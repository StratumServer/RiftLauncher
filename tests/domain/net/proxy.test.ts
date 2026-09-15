import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { matchesNoProxy, parseProxyResolution } from "@domain/net/proxy"

describe("parseProxyResolution reads one session.resolveProxy answer (#481)", () => {
  it("reads DIRECT, case and whitespace insensitive", () => {
    assert.deepEqual(parseProxyResolution("DIRECT"), { kind: "direct" })
    assert.deepEqual(parseProxyResolution("direct"), { kind: "direct" })
    assert.deepEqual(parseProxyResolution("  DIRECT  "), { kind: "direct" })
  })

  it("reads a PROXY entry as an http proxy", () => {
    assert.deepEqual(parseProxyResolution("PROXY 10.0.0.1:8080"), { kind: "http", host: "10.0.0.1", port: 8080 })
    assert.deepEqual(parseProxyResolution("proxy office-proxy.local:3128"), { kind: "http", host: "office-proxy.local", port: 3128 })
  })

  it("reads a SOCKS4 or SOCKS5 entry as socks, unimplemented but recognised", () => {
    assert.deepEqual(parseProxyResolution("SOCKS5 10.0.0.1:1080"), { kind: "socks", host: "10.0.0.1", port: 1080 })
    assert.deepEqual(parseProxyResolution("SOCKS4 10.0.0.1:1080"), { kind: "socks", host: "10.0.0.1", port: 1080 })
    assert.deepEqual(parseProxyResolution("SOCKS 10.0.0.1:1080"), { kind: "socks", host: "10.0.0.1", port: 1080 })
  })

  it("only reads the first entry, tolerant of a fallback list and stray whitespace", () => {
    assert.deepEqual(parseProxyResolution("PROXY 10.0.0.1:8080; DIRECT"), { kind: "http", host: "10.0.0.1", port: 8080 })
    assert.deepEqual(parseProxyResolution("  PROXY   10.0.0.1:8080  ;SOCKS5 10.0.0.2:1080"), { kind: "http", host: "10.0.0.1", port: 8080 })
    assert.deepEqual(parseProxyResolution("DIRECT; PROXY 10.0.0.1:8080"), { kind: "direct" })
  })

  it("cannot tunnel an HTTPS-secured proxy, so it comes back unsupported like a truly unknown scheme", () => {
    assert.deepEqual(parseProxyResolution("HTTPS 10.0.0.1:443"), { kind: "unsupported" })
    assert.deepEqual(parseProxyResolution("QUIC 10.0.0.1:443"), { kind: "unsupported" })
  })

  it("treats garbage and out-of-range ports as unsupported rather than throwing", () => {
    assert.deepEqual(parseProxyResolution("not a proxy answer"), { kind: "unsupported" })
    assert.deepEqual(parseProxyResolution("PROXY 10.0.0.1"), { kind: "unsupported" })
    assert.deepEqual(parseProxyResolution("PROXY 10.0.0.1:99999"), { kind: "unsupported" })
    assert.deepEqual(parseProxyResolution("PROXY 10.0.0.1:0"), { kind: "unsupported" })
  })

  it("treats an empty answer as direct rather than throwing", () => {
    assert.deepEqual(parseProxyResolution(""), { kind: "direct" })
    assert.deepEqual(parseProxyResolution("   "), { kind: "direct" })
  })
})

describe("matchesNoProxy reads one NO_PROXY entry list (#481)", () => {
  it("matches a bare host by exact name", () => {
    assert.equal(matchesNoProxy(new URL("https://auth.vintagestory.at"), "auth.vintagestory.at"), true)
    assert.equal(matchesNoProxy(new URL("https://other.example.com"), "auth.vintagestory.at"), false)
  })

  it("matches a host with a port only when the target's own effective port agrees", () => {
    // https://auth.vintagestory.at never spells out :443, but that is its effective port.
    assert.equal(matchesNoProxy(new URL("https://auth.vintagestory.at"), "auth.vintagestory.at:443"), true)
    assert.equal(matchesNoProxy(new URL("http://auth.vintagestory.at"), "auth.vintagestory.at:443"), false)
    assert.equal(matchesNoProxy(new URL("https://auth.vintagestory.at:8443"), "auth.vintagestory.at:443"), false)
    assert.equal(matchesNoProxy(new URL("https://auth.vintagestory.at:443"), "auth.vintagestory.at:443"), true)
  })

  it("matches a domain suffix, leading dot optional", () => {
    assert.equal(matchesNoProxy(new URL("https://api.vintagestory.at"), ".vintagestory.at"), true)
    assert.equal(matchesNoProxy(new URL("https://api.vintagestory.at"), "vintagestory.at"), true)
    assert.equal(matchesNoProxy(new URL("https://vintagestory.at.evil.com"), "vintagestory.at"), false)
  })

  it("matches every host on the * entry", () => {
    assert.equal(matchesNoProxy(new URL("https://anything.example.com"), "*"), true)
  })

  it("tolerates spaces around an entry in a comma-separated list", () => {
    assert.equal(matchesNoProxy(new URL("https://auth.vintagestory.at"), "other.example.com,  auth.vintagestory.at  ,third.example.com"), true)
  })

  it("matches regardless of case", () => {
    assert.equal(matchesNoProxy(new URL("https://Auth.VintageStory.at"), "AUTH.vintagestory.AT"), true)
  })

  it("returns false for an empty or unset NO_PROXY", () => {
    assert.equal(matchesNoProxy(new URL("https://auth.vintagestory.at"), undefined), false)
    assert.equal(matchesNoProxy(new URL("https://auth.vintagestory.at"), ""), false)
  })
})
