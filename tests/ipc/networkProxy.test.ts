import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import type { Server as HttpsServer } from "node:https"
import { connect as netConnect } from "node:net"
import type { Socket } from "node:net"
import { afterEach, describe, it } from "vitest"

import "./helpers/electronMock"
import { setElectronProxyResolution } from "./helpers/electronMock"
import "./helpers/tlsFixtures"
import { createSelfSignedCert, setTrustedCa } from "./helpers/tlsFixtures"

import { requestBoundedTextViaNode } from "@src/ipc/network"

/**
 * `requestBoundedTextViaNode`'s system-proxy support (issue #481): the login
 * transport now asks Electron's session for the proxy before opening a
 * socket, tunnels an HTTP proxy answer with a plain CONNECT, and refuses a
 * proxy shape it cannot route through before ever touching the network.
 *
 * Most servers here (origin and proxy alike) are plain, unencrypted
 * `node:http`/`node:net` servers on 127.0.0.1: the tunnel is exercised with an
 * `http:` target URL, the one case `requestBoundedTextViaNode` itself already
 * skips the TLS wrap for (see its `url.protocol === "http:"` check), which
 * proves the CONNECT-and-relay mechanics without a certificate anywhere in
 * most of the tests. A handful reach for a self-signed certificate from
 * `./helpers/tlsFixtures` instead, where the point under test is a real TLS
 * connection: an `https:` proxy URL, or an `https:` target reached through
 * the tunnel, both real logins hit and neither of which a plain server can
 * stand in for.
 */

const openSockets = new Set<Socket>()
let origin: Server | undefined
let proxy: Server | undefined
let secureProxy: HttpsServer | undefined
let secureOrigin: HttpsServer | undefined

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  setElectronProxyResolution("DIRECT")
  setTrustedCa(undefined)
  delete process.env.HTTPS_PROXY
  delete process.env.HTTP_PROXY
  delete process.env.NO_PROXY

  for (const server of [origin, proxy, secureProxy, secureOrigin]) {
    if (!server) continue
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  origin = undefined
  proxy = undefined
  secureProxy = undefined
  secureOrigin = undefined
})

function trackSockets(server: Server | HttpsServer): void {
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

/** Like {@link startOrigin}, but the origin itself is reached over TLS with `cert`/`key`: an `https:` target, the shape a real login always is. */
function startSecureOrigin(cert: string, key: string, handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<URL> {
  return new Promise((resolve) => {
    secureOrigin = createHttpsServer({ cert, key }, handler)
    trackSockets(secureOrigin)
    secureOrigin.listen(0, "127.0.0.1", () => {
      const address = secureOrigin?.address()
      if (address === null || typeof address !== "object") throw new Error("Secure origin server failed to bind")
      resolve(new URL(`https://127.0.0.1:${address.port}/`))
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

/** Like {@link startRelayProxy}, but the proxy itself is reached over TLS with `cert`/`key`: an `https:` proxy URL. */
function startSecureRelayProxy(cert: string, key: string): Promise<{ port: number; connectTargets: string[] }> {
  return new Promise((resolve) => {
    const connectTargets: string[] = []
    secureProxy = createHttpsServer({ cert, key })
    trackSockets(secureProxy)
    secureProxy.on("connect", (req, clientSocket, head) => {
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
    secureProxy.listen(0, "127.0.0.1", () => {
      const address = secureProxy?.address()
      if (address === null || typeof address !== "object") throw new Error("Secure proxy server failed to bind")
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

describe("requestBoundedTextViaNode keeps HTTPS_PROXY's own scheme (#481)", () => {
  it("reaches an https HTTPS_PROXY over its own TLS connection instead of a plaintext CONNECT", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    const { cert, key } = createSelfSignedCert()
    const relay = await startSecureRelayProxy(cert, key)
    setElectronProxyResolution("DIRECT")
    setTrustedCa(cert)
    process.env.HTTPS_PROXY = `https://127.0.0.1:${relay.port}`

    const result = await requestBoundedTextViaNode(url)

    assert.equal(result, "ok")
    assert.deepEqual(relay.connectTargets, [`127.0.0.1:${url.port}`])
  })

  it("rejects a socks5 HTTPS_PROXY as unsupported rather than treating it as an HTTP proxy", async () => {
    const url = await startOrigin((_req, res) => {
      res.writeHead(200)
      res.end("should never be reached")
    })
    setElectronProxyResolution("DIRECT")
    // Nothing is listening on this port: the old string-surgery fallback treated any
    // HTTPS_PROXY as an HTTP proxy and would have tried to CONNECT through it, failing to
    // connect instead of being refused up front.
    process.env.HTTPS_PROXY = "socks5://127.0.0.1:1"

    await assert.rejects(requestBoundedTextViaNode(url), /Login proxy is not supported/)
  })
})

describe("requestBoundedTextViaNode reaches an https target through an HTTP proxy's CONNECT tunnel (#481)", () => {
  it("wraps the tunnelled socket in TLS and posts the login body through it", async () => {
    const { cert, key } = createSelfSignedCert()
    let receivedBody = ""
    const url = await startSecureOrigin(cert, key, (req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("ok")
      })
    })
    const relay = await startRelayProxy()
    setElectronProxyResolution(`PROXY 127.0.0.1:${relay.port}`)
    setTrustedCa(cert)

    const body = "email=someone%40example.com&password=hunter2"
    const result = await requestBoundedTextViaNode(url, { method: "POST", body })

    assert.equal(result, "ok")
    assert.equal(receivedBody, body)
    assert.deepEqual(relay.connectTargets, [`127.0.0.1:${url.port}`])
  })
})
