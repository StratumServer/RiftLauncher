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
 * `"HTTPS host:port"` names a proxy reached over its own TLS connection,
 * which the login transport has no tunnel for (`src/ipc/network.ts` only
 * speaks a plain CONNECT to the proxy itself); it comes back `unsupported`,
 * the same as a SOCKS entry the launcher also does not tunnel through, and
 * the same as anything that fails to parse. `socks` still gets its own
 * shape rather than folding into `unsupported` too: this function's job is
 * to say what the OS answered, and a SOCKS entry is not garbage, only
 * unimplemented.
 */
export type ProxyResolution = { kind: "direct" } | { kind: "http"; host: string; port: number } | { kind: "socks"; host: string; port: number } | { kind: "unsupported" }

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
