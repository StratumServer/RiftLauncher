import { net, session } from "electron"
import { Agent, request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import { connect as tlsConnect } from "node:tls"
import { parseProxyResolution } from "@domain/net/proxy"
import type { ProxyResolution } from "@domain/net/proxy"
import { MAX_RESPONSE_BYTES } from "@src/ipc/validation"
import { logMessage } from "@src/utils/logManager"

const REQUEST_TIMEOUT_MS = 15_000

/**
 * The two literals the login proxy path throws, read back by
 * `src/ipc/handlers/loginFailureReason.ts` (issue #481) so the renderer can
 * tell a player a proxy is the reason, without either literal ever carrying
 * a host: Chromium's `resolveProxy` answer never carries proxy credentials,
 * so a 407 is the only answer a login through a proxy can give for one, and
 * a SOCKS (or otherwise unrouted) proxy is refused before a socket is ever
 * opened, for the same reason `requestBoundedTextViaNode` never got a SOCKS
 * client: nothing in this codebase speaks that protocol.
 */
const PROXY_AUTH_REQUIRED_MESSAGE = "Login proxy requires authentication"
const PROXY_UNSUPPORTED_MESSAGE = "Login proxy is not supported"

const DEFAULT_ACCEPT_HEADER = "application/json, text/plain;q=0.9"

type BoundedRequestOptions = {
  method?: "GET" | "POST"
  body?: string
  maxBytes?: number
  /** Overrides the JSON/text default for a caller that is not asking for text. */
  accept?: string
  /** Extra headers beyond Accept and Content-Type, applied as given. For a target that needs one the shared defaults don't cover, a User-Agent GitHub's API requires among them. */
  headers?: Record<string, string>
  /** Overrides REQUEST_TIMEOUT_MS for a caller that needs a tighter wall clock than every other request on this transport gets. */
  timeoutMs?: number
}

/**
 * A response {@link requestBoundedBuffer} refused for its status, carrying enough of the response
 * to classify why without ever logging it. `statusCode` and `headers` are Node's own shapes,
 * unread by every caller except one that asks for them on purpose (see
 * src/ipc/handlers/netHandlers.ts's releaseNotesFailureReason, which reads a single header off a
 * 403 to tell GitHub's rate limit apart from any other refusal); every existing caller keeps
 * matching on `.message`, unaffected.
 */
export class BoundedResponseError extends Error {
  readonly statusCode: number | undefined
  readonly headers: Record<string, string | string[] | undefined>

  constructor(message: string, statusCode: number | undefined, headers: Record<string, string | string[] | undefined>) {
    super(message)
    this.name = "BoundedResponseError"
    this.statusCode = statusCode
    this.headers = headers
  }
}

export function requestBoundedText(url: URL, options: BoundedRequestOptions = {}): Promise<string> {
  return requestBoundedBuffer(url, options).then((bytes) => bytes.toString("utf8"))
}

/**
 * {@link requestBoundedText} without the utf8 decode, for the one caller that fetches an image.
 * Same ceiling, same wall-clock timeout, same refusal to follow a redirect: the decode was always
 * the only thing separating the two, and a JPEG does not survive it.
 */
export function requestBoundedBuffer(url: URL, options: BoundedRequestOptions = {}): Promise<Buffer> {
  const method = options.method ?? "GET"
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let settled = false
    let responseBytes = 0
    const chunks: Buffer[] = []
    const request = net.request({
      url: url.toString(),
      method,
      redirect: "error",
      credentials: "omit"
    })

    const timeout = setTimeout(() => {
      request.abort()
      finish(new Error("Network request timed out"))
    }, timeoutMs)

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (error) {
        reject(error)
      } else {
        resolve(Buffer.concat(chunks))
      }
    }

    request.on("response", (response) => {
      const contentLengthHeader = response.headers["content-length"]
      const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader
      const contentLength = Number(contentLengthValue)

      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        request.abort()
        finish(new Error("Network response is too large"))
        return
      }

      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        request.abort()
        finish(new BoundedResponseError(`Network request failed with status ${response.statusCode ?? "unknown"}`, response.statusCode, response.headers))
        return
      }

      response.on("data", (chunk: Buffer | string) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        responseBytes += chunkBuffer.length

        if (responseBytes > maxBytes) {
          request.abort()
          finish(new Error("Network response is too large"))
          return
        }

        chunks.push(chunkBuffer)
      })
      response.on("end", () => finish())
      response.on("aborted", () => finish(new Error("Network response was aborted")))
      response.on("error", (error) => finish(error))
    })

    request.on("error", (error) => finish(error))
    request.on("login", (_authInfo, callback) => callback())

    request.setHeader("Accept", options.accept ?? DEFAULT_ACCEPT_HEADER)
    for (const [name, value] of Object.entries(options.headers ?? {})) request.setHeader(name, value)
    if (options.body !== undefined) {
      request.setHeader("Content-Type", "application/x-www-form-urlencoded")
      request.end(options.body)
    } else {
      request.end()
    }
  })
}

/**
 * Node-`https`-transport twin of {@link requestBoundedText}, for the one
 * endpoint that refuses Electron's Chromium-flavoured `net.request` (issue
 * #76): the auth service rejects credential posts that carry `net.request`'s
 * `sec-fetch-*` metadata and Chrome User-Agent, neither of which
 * `request.setHeader` can strip. The download worker
 * (`src/ipc/workers/downloadWorker.ts`) already posts through Node's `https`
 * for the same reason of principle, though its shape differs because a
 * multi-gigabyte file download needs a streamed-to-disk write and a
 * socket-inactivity timeout, not the wall-clock timeout this function keeps.
 *
 * Every guarantee `requestBoundedText` carries is preserved here and no
 * caller of `requestBoundedText` is affected, since that function is
 * untouched:
 *  - the response is capped at `maxBytes`, checked against `Content-Length`
 *    up front and against the running streamed total as chunks arrive;
 *  - the whole exchange is bounded by `REQUEST_TIMEOUT_MS`, the same
 *    wall-clock timeout `requestBoundedText` uses (not `request.setTimeout`,
 *    which only measures socket inactivity and would let a slow-trickling
 *    response run forever);
 *  - no redirect is ever followed: `http(s).request`, unlike `fetch`, has no
 *    redirect-following behaviour to opt out of, so a 3xx response is just
 *    another status this function rejects, same as `requestBoundedText`'s
 *    `redirect: "error"`;
 *  - a POST body, and the same `Accept` and `Content-Type` headers.
 *
 * Deliberately absent: a `User-Agent` header. The game's own .NET
 * `HttpClient` sends none and is never refused; adding one back here would
 * reopen this issue.
 *
 * Picks `http` or `https` off `url.protocol` so tests can point this at a
 * plain-`http` server on 127.0.0.1; every real caller passes an `https:` URL.
 *
 * `timeoutMs` exists only so tests can trip the timeout branch without a real
 * 15-second wait; no production caller sets it, so every real call still gets
 * `REQUEST_TIMEOUT_MS`.
 *
 * Also honours the system proxy (issue #481), which this transport never
 * used to read: `session.defaultSession.resolveProxy` is asked for `url`
 * first, the same question Electron's own `net.request` answers itself for
 * every other call in this file. An HTTP proxy answer is tunneled through
 * with a plain CONNECT (see {@link connectThroughProxy}); `DIRECT` keeps
 * this function's byte-for-byte prior behaviour, falling back to
 * `HTTPS_PROXY`/`HTTP_PROXY` (`NO_PROXY` respected) only when the session
 * itself found nothing to use; a SOCKS answer, an HTTPS-secured proxy answer,
 * or anything else this transport cannot route through fails the request up
 * front with {@link PROXY_UNSUPPORTED_MESSAGE}, before a socket is ever
 * opened. The whole decision, and the tunnel handshake, sit inside the same
 * `timeoutMs` wall clock this function already bounded every request with.
 */
export function requestBoundedTextViaNode(url: URL, options: BoundedRequestOptions & { timeoutMs?: number } = {}): Promise<string> {
  const method = options.method ?? "GET"
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  const headers: Record<string, string> = { Accept: options.accept ?? DEFAULT_ACCEPT_HEADER }
  if (options.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded"

  return new Promise((resolve, reject) => {
    let settled = false
    let responseBytes = 0
    const chunks: Buffer[] = []
    // Whichever request is in flight right now (the CONNECT, or the real one), so the
    // one timeout below can abort it without knowing which phase it landed in.
    let abortInFlight = (): void => {}

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (error) {
        reject(error)
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"))
      }
    }

    const timeout = setTimeout(() => {
      abortInFlight()
      finish(new Error("Network request timed out"))
    }, timeoutMs)

    function onResponse(response: IncomingMessage): void {
      const contentLengthHeader = response.headers["content-length"]
      const contentLength = Number(contentLengthHeader)

      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        abortInFlight()
        finish(new Error("Network response is too large"))
        return
      }

      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        abortInFlight()
        finish(new Error(`Network request failed with status ${response.statusCode ?? "unknown"}`))
        return
      }

      response.on("data", (chunk: Buffer | string) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        responseBytes += chunkBuffer.length

        if (responseBytes > maxBytes) {
          abortInFlight()
          finish(new Error("Network response is too large"))
          return
        }

        chunks.push(chunkBuffer)
      })
      response.on("end", () => finish())
      response.on("aborted", () => finish(new Error("Network response was aborted")))
      response.on("error", (error) => finish(error))
    }

    // A tunneled request is always sent with node:http's own `request`, `agent` and all,
    // never `https.request`: the agent already hands back a socket doing TLS on its own
    // for an `https:` target (see connectThroughProxy), and a second TLS layer on top is
    // not what `https.request` would give it anyway. The URL itself is never passed
    // through in that case either: a `URL` carries its own `protocol`, and `http.request`
    // refuses one that disagrees with the agent's ("https:" against `TunnelAgent`'s
    // inherited "http:"), so the pieces `http.request` actually needs are read off it by
    // hand instead. The direct branch is untouched: same call as before this issue.
    function send(agent?: Agent): void {
      const request = agent
        ? httpRequest({ hostname: url.hostname, port: url.port || (url.protocol === "http:" ? 80 : 443), path: `${url.pathname}${url.search}`, method, headers, agent }, onResponse)
        : (url.protocol === "http:" ? httpRequest : httpsRequest)(url, { method, headers }, onResponse)

      abortInFlight = (): void => {
        request.destroy()
      }
      request.on("error", (error) => finish(error))
      if (options.body !== undefined) request.end(options.body)
      else request.end()
    }

    decideProxy(url)
      .then((decision) => {
        if (settled) return
        if (decision.kind === "blocked") return finish(decision.error)
        if (decision.kind === "direct") return send()

        return connectThroughProxy(decision.proxy, url, (abort) => {
          abortInFlight = abort
        }).then((agent) => {
          if (!settled) send(agent)
        })
      })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

/** What {@link requestBoundedTextViaNode} does once it knows the proxy for `url`. */
type ProxyDecision = { kind: "direct" } | { kind: "tunnel"; proxy: { host: string; port: number } } | { kind: "blocked"; error: Error }

/**
 * Asks Electron's default session how `url` should be reached, the same
 * question `net.request` answers for itself, and turns the answer into what
 * {@link requestBoundedTextViaNode} does next.
 *
 * A session that fails to answer (no window ever created one, or some
 * Electron-internal error) is treated as `DIRECT`: a proxy question this
 * transport cannot even ask is not a reason to refuse a login that used to
 * work before this issue existed.
 *
 * Every branch logs exactly one fixed token and nothing else, never the
 * host `url` names or the proxy resolved for it (issue #481): `proxy-used`
 * and `proxy-direct` here; a blocked resolution logs nothing of its own; its
 * `proxy-unsupported` (or a CONNECT 407's `proxy-auth-required`) reaches the
 * log the same way every other login failure does, through the reason
 * `src/ipc/handlers/loginFailureReason.ts` classifies the thrown error into.
 */
async function decideProxy(url: URL): Promise<ProxyDecision> {
  const pacAnswer = await session.defaultSession.resolveProxy(url.toString()).catch(() => "DIRECT")
  const resolution = parseProxyResolution(pacAnswer)
  const effective = resolution.kind === "direct" ? (environmentProxyResolution(url.hostname) ?? resolution) : resolution

  if (effective.kind === "direct") {
    logMessage("debug", "[back] [ipc] [network.ts] [PROXY] proxy-direct")
    return { kind: "direct" }
  }
  if (effective.kind === "http") {
    logMessage("debug", "[back] [ipc] [network.ts] [PROXY] proxy-used")
    return { kind: "tunnel", proxy: { host: effective.host, port: effective.port } }
  }
  // socks, or a shape this transport does not recognise: neither has a client here.
  return { kind: "blocked", error: new Error(PROXY_UNSUPPORTED_MESSAGE) }
}

/**
 * `HTTPS_PROXY`/`HTTP_PROXY`, read only when the session itself answered
 * `DIRECT`: Node's `http(s).request` never consults either variable on its
 * own, unlike `net.request`, which is why this transport needed one at all.
 * `NO_PROXY` is checked first and wins outright, matching curl and every
 * other tool that honours the trio. A value that fails to parse as a URL,
 * same as nothing set at all, leaves the caller on the direct path rather
 * than failing a login over a malformed environment variable.
 */
function environmentProxyResolution(targetHost: string): ProxyResolution | undefined {
  if (hostMatchesNoProxy(targetHost, process.env.NO_PROXY ?? process.env.no_proxy)) return undefined

  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (!raw) return undefined

  try {
    const proxyUrl = new URL(raw)
    return parseProxyResolution(`PROXY ${proxyUrl.hostname}:${proxyUrl.port || "80"}`)
  } catch {
    return undefined
  }
}

/** `NO_PROXY=a.example.com,.b.example.com,*`: an exact host, a domain suffix (leading dot optional), or `*` for every host. */
function hostMatchesNoProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false
  const target = host.toLowerCase()

  return noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
    .some((entry) => entry === "*" || target === entry || target.endsWith(`.${entry}`))
}

/**
 * An `http.Agent` that hands back one already-established socket instead of
 * ever opening a connection of its own: the tunnel {@link connectThroughProxy}
 * just built. `http.request` (never `https.request`, even for an `https:`
 * target) is what this agent is meant for: once the socket it returns is
 * already doing TLS (see {@link connectThroughProxy}), the request built on
 * top of it only ever writes plaintext HTTP/1.1 onto a stream, and that
 * stream encrypts on the way out on its own.
 */
class TunnelAgent extends Agent {
  private readonly socket: Socket

  constructor(socket: Socket) {
    super({ keepAlive: false })
    this.socket = socket
  }

  override createConnection(): Socket {
    return this.socket
  }
}

/**
 * Opens the login request's actual connection through an HTTP proxy with a
 * CONNECT tunnel: `node:http`'s own `request` sends the CONNECT, and once the
 * proxy answers 200 the raw socket it hands back either is the connection
 * (a plain-`http` test target) or gets wrapped in TLS to the real origin (an
 * `https:` target, every real login). No new dependency: `node:tls`'s
 * `connect({ socket })` upgrading an already-open socket, and the tiny
 * {@link TunnelAgent} above, are both standard library.
 *
 * `onAbort` is handed the one thing worth cancelling at each point in time,
 * so `requestBoundedTextViaNode`'s single timeout can reach whichever phase
 * is actually in flight without knowing which one that is.
 *
 * A 407 is the only status this maps by itself, to {@link PROXY_AUTH_REQUIRED_MESSAGE}:
 * Chromium's proxy resolution never carries credentials for this transport to send back,
 * so an authenticated proxy cannot be satisfied and the player is told plainly rather than
 * left on a generic connection failure. Known limit, not a bug: there is no prompt for a
 * proxy password anywhere in this launcher.
 */
function connectThroughProxy(proxy: { host: string; port: number }, url: URL, onAbort: (abort: () => void) => void): Promise<Agent> {
  const targetPort = Number(url.port) || (url.protocol === "http:" ? 80 : 443)

  return new Promise<Socket>((resolve, reject) => {
    const connectRequest = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${url.hostname}:${targetPort}`,
      headers: { Host: `${url.hostname}:${targetPort}` }
    })

    onAbort(() => connectRequest.destroy())
    connectRequest.on("error", reject)
    connectRequest.on("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket)
        return
      }

      socket.destroy()
      reject(response.statusCode === 407 ? new Error(PROXY_AUTH_REQUIRED_MESSAGE) : new Error(`Login proxy CONNECT failed with status ${response.statusCode ?? "unknown"}`))
    })
    connectRequest.end()
  }).then((rawSocket) => {
    const tunneledSocket = url.protocol === "http:" ? rawSocket : tlsConnect({ socket: rawSocket, servername: url.hostname })
    onAbort(() => tunneledSocket.destroy())
    return new TunnelAgent(tunneledSocket)
  })
}
