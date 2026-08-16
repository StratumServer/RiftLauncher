import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse, Socket } from "node:http"
import { afterEach, describe, it } from "vitest"

import "./helpers/electronMock"

import { requestBoundedTextViaNode } from "@src/ipc/network"

/**
 * `network.ts` imports `net` from `electron` at module load (for
 * `requestBoundedText`), which is why "./helpers/electronMock" runs first,
 * the same ordering `ipcSecurity.test.ts` relies on. Nothing here ever calls
 * `requestBoundedText`, so the mock's missing `net` member is never touched.
 *
 * Every server in this file is a plain `node:http` server on 127.0.0.1,
 * started fresh per test and torn down in `afterEach`, sockets included --
 * a couple of these tests deliberately never respond, and an un-destroyed
 * socket would keep the process (and vitest) alive past the test.
 */

let server: Server | undefined
const openSockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()

  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
})

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<URL> {
  return new Promise((resolve) => {
    server = createServer(handler)
    server.on("connection", (socket) => {
      openSockets.add(socket)
      socket.on("close", () => openSockets.delete(socket))
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address()
      if (address === null || typeof address !== "object") throw new Error("Server failed to bind")
      resolve(new URL(`http://127.0.0.1:${address.port}/`))
    })
  })
}

describe("requestBoundedTextViaNode posts the body verbatim", () => {
  it("delivers exactly the bytes handed to it, unmodified", async () => {
    let received = ""
    const url = await startServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        received = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("ok")
      })
    })

    const body = "email=someone%40example.com&password=hunter2&gameloginversion=1"
    const result = await requestBoundedTextViaNode(url, { method: "POST", body })

    assert.equal(received, body)
    assert.equal(result, "ok")
  })
})

describe("requestBoundedTextViaNode aborts on an oversized response", () => {
  it("aborts up front when Content-Length exceeds maxBytes", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "1000" })
      res.end("short")
    })

    await assert.rejects(requestBoundedTextViaNode(url, { maxBytes: 10 }), /too large/)
  })

  it("aborts once streamed bytes exceed maxBytes, with no Content-Length to warn it up front", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200)
      res.write("0123456789")
      res.write("0123456789")
      res.write("0123456789")
      // Deliberately never end(): if the cap did not trip on the stream,
      // this test would hang instead of failing.
    })

    await assert.rejects(requestBoundedTextViaNode(url, { maxBytes: 15 }), /too large/)
  })
})

describe("requestBoundedTextViaNode enforces its timeout", () => {
  it("rejects once timeoutMs elapses against a server that never responds", async () => {
    const url = await startServer(() => {
      // No res.write, no res.end: the connection is accepted and then held open.
    })

    await assert.rejects(requestBoundedTextViaNode(url, { timeoutMs: 50 }), /timed out/)
  })
})

describe("requestBoundedTextViaNode rejects a non-2xx status", () => {
  it("rejects a 404 rather than resolving its body", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ valid: 0, reason: "notfound" }))
    })

    await assert.rejects(requestBoundedTextViaNode(url), /404/)
  })
})

/**
 * The regression this file exists to pin (issue #76): the auth service
 * refused every login because Electron's `net.request` attaches Chromium's
 * `sec-fetch-*` fetch metadata and a Chrome User-Agent, and `request.setHeader`
 * cannot remove them. `requestBoundedTextViaNode` has to arrive with neither,
 * the same as the game's own .NET `HttpClient` does. This is not a redundant
 * check against "posts the body verbatim" above: that test proves the body,
 * this one proves the headers, and it is the header shape, not the body,
 * that the auth service was keying its refusal on.
 */
describe("requestBoundedTextViaNode never sends browser fetch metadata", () => {
  it("carries no user-agent and no sec-fetch-* header", async () => {
    let receivedHeaders: IncomingMessage["headers"] = {}
    const url = await startServer((req, res) => {
      receivedHeaders = req.headers
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("ok")
    })

    await requestBoundedTextViaNode(url, { method: "POST", body: "a=b" })

    assert.equal(receivedHeaders["user-agent"], undefined, "no User-Agent header should be sent")
    for (const name of Object.keys(receivedHeaders)) {
      assert.equal(name.toLowerCase().startsWith("sec-fetch"), false, `unexpected browser fetch metadata header: ${name}`)
    }
  })

  it("still sends the same Accept and Content-Type headers requestBoundedText sends", async () => {
    let receivedHeaders: IncomingMessage["headers"] = {}
    const url = await startServer((req, res) => {
      receivedHeaders = req.headers
      res.writeHead(200)
      res.end("ok")
    })

    await requestBoundedTextViaNode(url, { method: "POST", body: "a=b" })

    assert.equal(receivedHeaders["accept"], "application/json, text/plain;q=0.9")
    assert.equal(receivedHeaders["content-type"], "application/x-www-form-urlencoded")
  })
})
