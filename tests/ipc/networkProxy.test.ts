import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { connect as netConnect } from "node:net"
import type { Socket } from "node:net"
import { afterEach, describe, it } from "vitest"

import "./helpers/electronMock"
import { setElectronProxyResolution } from "./helpers/electronMock"

import { requestBoundedTextViaNode } from "@src/ipc/network"

/**
 * `requestBoundedTextViaNode`'s system-proxy support (issue #481): the login
 * transport now asks Electron's session for the proxy before opening a
 * socket, tunnels an HTTP proxy answer with a plain CONNECT, and refuses a
 * proxy shape it cannot route through before ever touching the network.
 *
 * Every server here (origin and proxy alike) is a plain, unencrypted
 * `node:http`/`node:net` server on 127.0.0.1: the tunnel is exercised with an
 * `http:` target URL, the one case `requestBoundedTextViaNode` itself already
 * skips the TLS wrap for (see its `url.protocol === "http:"` check), which
 * proves the CONNECT-and-relay mechanics without a certificate anywhere in
 * the test. Every real login target is `https:`, where the same code path
 * wraps the tunnelled socket in TLS before the request is written.
 */

const openSockets = new Set<Socket>()
let origin: Server | undefined
let proxy: Server | undefined

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  setElectronProxyResolution("DIRECT")
  delete process.env.HTTPS_PROXY
  delete process.env.HTTP_PROXY
  delete process.env.NO_PROXY

  for (const server of [origin, proxy]) {
    if (!server) continue
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  origin = undefined
  proxy = undefined
})

function trackSockets(server: Server): void {
  server.on("connection", (socket) => {
    openSockets.add(socket)
    socket.on("close", () => openSockets.delete(socket))
  })
}

function startOrigin(handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<URL> {
  return new Promise((resolve) => {
    origin = createHttpServer(handler)
    trackSockets(origin)
    origin.listen(0, "127.0.0.1", () => {
      const address = origin?.address()
      if (address === null || typeof address !== "object") throw new Error("Origin server failed to bind")
      resolve(new URL(`http://127.0.0.1:${address.port}/`))
    })
  })
}

/** A CONNECT-accepting proxy that relays the tunnel to the real target, and records every CONNECT target it saw. */
function startRelayProxy(): Promise<{ port: number; connectTargets: string[] }> {
  return new Promise((resolve) => {
    const connectTargets: string[] = []
    proxy = createHttpServer()
    trackSockets(proxy)
    proxy.on("connect", (req, clientSocket, head) => {
      connectTargets.push(req.url ?? "")
      const [host, portText] = (req.url ?? "").split(":")
      const upstream = netConnect(Number(portText), host)
      openSockets.add(upstream)
      upstream.on("close", () => openSockets.delete(upstream))
      upstream.on("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on("error", () => clientSocket.destroy())
      clientSocket.on("error", () => upstream.destroy())
    })
    proxy.listen(0, "127.0.0.1", () => {
      const address = proxy?.address()
      if (address === null || typeof address !== "object") throw new Error("Proxy server failed to bind")
      resolve({ port: address.port, connectTargets })
    })
  })
}

/** A CONNECT-accepting proxy that never tunnels: it always answers with `status`, e.g. a 407. */
function startRefusingProxy(status: number): Promise<{ port: number; connectTargets: string[] }> {
  return new Promise((resolve) => {
    const connectTargets: string[] = []
    proxy = createHttpServer()
    trackSockets(proxy)
    proxy.on("connect", (req, clientSocket) => {
      connectTargets.push(req.url ?? "")
      clientSocket.end(`HTTP/1.1 ${status} Proxy Refused\r\n\r\n`)
    })
    proxy.listen(0, "127.0.0.1", () => {
      const address = proxy?.address()
      if (address === null || typeof address !== "object") throw new Error("Proxy server failed to bind")
      resolve({ port: address.port, connectTargets })
    })
  })
}

describe("requestBoundedTextViaNode reaches the login host through an HTTP proxy (#481)", () => {
  it("tunnels the request through the proxy and gets the real response back", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("ok")
    })
    const relay = await startRelayProxy()
    setElectronProxyResolution(`PROXY 127.0.0.1:${relay.port}`)

    const result = await requestBoundedTextViaNode(url)

    assert.equal(result, "ok")
    assert.deepEqual(relay.connectTargets, [`127.0.0.1:${url.port}`])
  })

  it("posts the same body and headers through the tunnel as it would send directly", async () => {
    let receivedBody = ""
    let receivedHeaders: IncomingMessage["headers"] = {}
    const url = await startOrigin((req, res) => {
      receivedHeaders = req.headers
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200)
        res.end("ok")
      })
    })
    const relay = await startRelayProxy()
    setElectronProxyResolution(`PROXY 127.0.0.1:${relay.port}`)

    await requestBoundedTextViaNode(url, { method: "POST", body: "a=b" })

    assert.equal(receivedBody, "a=b")
    assert.equal(receivedHeaders["content-type"], "application/x-www-form-urlencoded")
    assert.equal(receivedHeaders["accept"], "application/json, text/plain;q=0.9")
  })
})

describe("requestBoundedTextViaNode maps a proxy CONNECT refusal to a fixed reason (#481)", () => {
  it("maps a 407 to the proxy-auth-required reason, never reaching the origin", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("should never be reached")
    })
    const refusing = await startRefusingProxy(407)
    setElectronProxyResolution(`PROXY 127.0.0.1:${refusing.port}`)

    await assert.rejects(requestBoundedTextViaNode(url), /Login proxy requires authentication/)
    assert.deepEqual(refusing.connectTargets, [`127.0.0.1:${url.port}`])
  })
})

describe("requestBoundedTextViaNode refuses a SOCKS proxy up front (#481)", () => {
  it("rejects with the proxy-unsupported reason before opening any socket", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("should never be reached")
    })
    setElectronProxyResolution("SOCKS5 127.0.0.1:1080")

    await assert.rejects(requestBoundedTextViaNode(url), /Login proxy is not supported/)
  })
})

describe("requestBoundedTextViaNode keeps the direct path when the session answers DIRECT (#481)", () => {
  it("bypasses the tunnel entirely, unchanged from before this issue", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    setElectronProxyResolution("DIRECT")

    assert.equal(await requestBoundedTextViaNode(url), "ok")
  })
})

describe("requestBoundedTextViaNode falls back to HTTPS_PROXY only when the session found nothing (#481)", () => {
  it("uses HTTPS_PROXY when the session answers DIRECT", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    const relay = await startRelayProxy()
    setElectronProxyResolution("DIRECT")
    process.env.HTTPS_PROXY = `http://127.0.0.1:${relay.port}`

    const result = await requestBoundedTextViaNode(url)

    assert.equal(result, "ok")
    assert.deepEqual(relay.connectTargets, [`127.0.0.1:${url.port}`])
  })

  it("still bypasses HTTPS_PROXY for a host NO_PROXY names", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    setElectronProxyResolution("DIRECT")
    // Nothing is listening on this port: if NO_PROXY failed to bypass it, the request would
    // fail to connect instead of succeeding.
    process.env.HTTPS_PROXY = "http://127.0.0.1:1"
    process.env.NO_PROXY = "127.0.0.1"

    assert.equal(await requestBoundedTextViaNode(url), "ok")
  })

  it("stays on the direct path when HTTPS_PROXY is not a valid URL", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    setElectronProxyResolution("DIRECT")
    process.env.HTTPS_PROXY = "not a url"

    assert.equal(await requestBoundedTextViaNode(url), "ok")
  })
})
