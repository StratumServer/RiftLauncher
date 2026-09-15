/**
 * Reads one answer from Electron's `session.resolveProxy(url)` (issue #481).
 *
 * Chromium answers with a PAC-style, semicolon-separated list, most-preferred
 * entry first: `"PROXY host:port"`, `"HTTPS host:port"`, `"SOCKS5 host:port"`,
 * `"SOCKS4 host:port"` or `"DIRECT"`. Only the first entry is ever read: a
 * fallback entry exists for when the first is unreachable, which is a retry
 * policy this launcher does not implement, so acting on it would silently
 * try a proxy the OS itself only offered as a second choice.
 *
 * `"HTTPS host:port"` names a proxy reached over its own TLS connection.
 * `src/ipc/network.ts` can tunnel one (see {@link parseProxyUrl}, used on the
 * `HTTPS_PROXY`/`HTTP_PROXY` fallback path), but Chromium's own answer for it
 * comes back `unsupported` here regardless: a PAC answer never carries more
 * than the host and port, and this function's job is only to say what the OS
 * answered, not to guess at a scheme it was never told to trust for this
 * particular proxy. `socks` still gets its own shape rather than folding into
 * `unsupported` too: a SOCKS entry is not garbage, only unimplemented.
 */
export type ProxyResolution =
  | { kind: "direct" }
  | { kind: "http"; host: string; port: number }
  | { kind: "https"; host: string; port: number }
  | { kind: "socks"; host: string; port: number }
  | { kind: "unsupported" }

const PROXY_ENTRY = /^(PROXY|SOCKS4|SOCKS5|SOCKS)\s+([^\s:]+):(\d{1,5})$/i

export function parseProxyResolution(text: string): ProxyResolution {
  const first = text.split(";")[0]?.trim() ?? ""
  if (first === "" || /^direct$/i.test(first)) return { kind: "direct" }

  const match = PROXY_ENTRY.exec(first)
  if (!match) return { kind: "unsupported" }

  const scheme = match[1] ?? ""
  const host = match[2] ?? ""
  const port = Number(match[3])
  if (host === "" || !Number.isInteger(port) || port < 1 || port > 65_535) return { kind: "unsupported" }

  return scheme.toUpperCase() === "PROXY" ? { kind: "http", host, port } : { kind: "socks", host, port }
}

/**
 * Reads one `HTTPS_PROXY`/`HTTP_PROXY`-style URL (issue #481's environment fallback,
 * `src/ipc/network.ts`'s `environmentProxyResolution`), keeping the scheme the URL
 * itself names instead of discarding it: an `http:` or `https:` proxy URL both come
 * back tunnelable (`connectThroughProxy` reaches an `https:` one over its own TLS
 * connection before ever sending the CONNECT), and a `socks:`/`socks4:`/`socks5:` one
 * comes back as the same recognised-but-unimplemented `socks` shape
 * {@link parseProxyResolution} gives a PAC SOCKS answer, rather than being silently
 * folded into `http` the way string surgery on the hostname alone used to. Anything
 * else that still parses as a URL (an unknown scheme) comes back `unsupported`; a
 * value that fails to parse as a URL at all comes back `undefined`, the caller's cue
 * to fall back to the direct path rather than fail a login over a malformed
 * environment variable.
 */
export function parseProxyUrl(raw: string): ProxyResolution | undefined {
  let proxyUrl: URL
  try {
    proxyUrl = new URL(raw)
  } catch {
    return undefined
  }

  const host = proxyUrl.hostname
  if (host === "") return undefined

  switch (proxyUrl.protocol) {
    case "http:":
      return { kind: "http", host, port: Number(proxyUrl.port) || 80 }
    case "https:":
      return { kind: "https", host, port: Number(proxyUrl.port) || 443 }
    case "socks:":
    case "socks4:":
    case "socks5:":
      return { kind: "socks", host, port: Number(proxyUrl.port) || 1080 }
    default:
      return { kind: "unsupported" }
  }
}
