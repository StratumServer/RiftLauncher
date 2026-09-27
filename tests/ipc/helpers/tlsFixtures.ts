import { vi } from "vitest"
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto"

/**
 * Everything the proxy tests need to exercise real TLS: a self-signed certificate
 * generated fresh at test time (issue #481's HTTPS-through-CONNECT coverage), and a
 * way to make `src/ipc/network.ts` trust it for the one test that generated it,
 * without touching that module's own call sites or the process-wide certificate
 * store. `NODE_EXTRA_CA_CERTS` cannot do the latter: Node only reads it once, at
 * process start, before a single line of test code has run, so setting it here would
 * either do nothing or leak into every other test file sharing the process.
 * `node:tls`'s `connect` and `node:https`'s `request` are what network.ts's tunnel
 * wraps a socket with and what it CONNECTs to a secure proxy through, so mocking
 * exactly those two, everything else forwarded untouched, gets a real handshake and a
 * real certificate check against a CA only this file's tests ever set.
 */

const trust = vi.hoisted(() => ({ ca: undefined as string | undefined }))

vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tls")>()
  return {
    ...actual,
    connect: (options: Record<string, unknown>, ...rest: unknown[]): ReturnType<typeof actual.connect> => {
      const merged = trust.ca === undefined ? options : { ...options, ca: trust.ca }
      return (actual.connect as (...args: unknown[]) => ReturnType<typeof actual.connect>)(merged, ...rest)
    }
  }
})

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>()
  return {
    ...actual,
    request: (options: Record<string, unknown>, ...rest: unknown[]): ReturnType<typeof actual.request> => {
      const merged = trust.ca === undefined ? options : { ...options, ca: trust.ca }
      return (actual.request as (...args: unknown[]) => ReturnType<typeof actual.request>)(merged, ...rest)
    }
  }
})

/** Trusts `pem` for every `node:tls`/`node:https` call this file mocks, until cleared. Call with no argument (an `afterEach` should) to stop trusting it. */
export function setTrustedCa(pem?: string): void {
  trust.ca = pem
}

/**
 * Builds a minimal DER encoder for exactly the ASN.1 shapes an X.509 certificate
 * needs: no library, because Node ships no certificate-issuing API of its own, only
 * `X509Certificate` to read one back.
 */
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))
function int(n: number): Buffer {
  const bytes: number[] = []
  let v = n
  if (v === 0) bytes.push(0)
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0)
  return tlv(0x02, Buffer.from(bytes))
}
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number)
  const bytes = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)]
  for (const p of parts.slice(2)) {
    if (p < 128) {
      bytes.push(p)
      continue
    }
    const chunk = [p & 0x7f]
    let v = p >> 7
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}
const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"))
function utcTime(date: Date): Buffer {
  const p2 = (n: number): string => String(n).padStart(2, "0")
  const text = `${p2(date.getUTCFullYear() % 100)}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(text, "ascii"))
}
const bitString = (content: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), content]))
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content)
const octetString = (buf: Buffer): Buffer => tlv(0x04, buf)
const ipAddress = (ip: string): Buffer => tlv(0x87, Buffer.from(ip.split(".").map(Number)))
const dnsName = (value: string): Buffer => tlv(0x82, Buffer.from(value, "ascii"))

const CN_OID = oid("2.5.4.3")
const name = (cn: string): Buffer => seq(set(seq(CN_OID, utf8String(cn))))

const ECDSA_SHA256_OID = oid("1.2.840.10045.4.3.2")
const algEcdsaSha256 = (): Buffer => seq(ECDSA_SHA256_OID)

const SAN_OID = oid("2.5.29.17")
const extensionSAN = (altNames: Buffer[]): Buffer => seq(SAN_OID, octetString(seq(...altNames)))

function toPem(der: Buffer, label: string): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

/**
 * A fresh self-signed certificate for `127.0.0.1`/`localhost`, valid for the next day,
 * built from an EC key pair signed with its own private key: subject and issuer are
 * the same name, which is what makes a certificate self-signed rather than merely
 * unsigned-by-anyone-trusted, and the only way `openssl verify -CAfile` (or Node's own
 * chain check, handed this certificate as its `ca`) accepts it as its own root.
 */
export function createSelfSignedCert(): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" })

  const notBefore = new Date(Date.now() - 60_000)
  const notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const serial = Math.floor(Math.random() * 1e9) + 1
  const subjectAndIssuer = name("127.0.0.1")

  const tbsCertificate = seq(
    explicit(0, int(2)),
    int(serial),
    algEcdsaSha256(),
    subjectAndIssuer,
    seq(utcTime(notBefore), utcTime(notAfter)),
    subjectAndIssuer,
    publicKeyDer,
    explicit(3, seq(extensionSAN([ipAddress("127.0.0.1"), dnsName("localhost")])))
  )
  const signature = cryptoSign("sha256", tbsCertificate, { key: privateKey })
  const certificate = seq(tbsCertificate, algEcdsaSha256(), bitString(signature))

  return {
    cert: toPem(certificate, "CERTIFICATE"),
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string
  }
}
