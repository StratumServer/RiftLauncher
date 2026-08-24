import { createHash } from "node:crypto"
import fse from "fs-extra"
import { createReadStream } from "node:fs"

import { requestBoundedText } from "@src/ipc/network"
import { isRecord, MAX_RESPONSE_BYTES } from "@src/ipc/validation"

type VerifiedArtifact = {
  md5: string
  sourceUrl: string
  verifiedAt: number
}

const verifiedArtifacts = new Map<string, VerifiedArtifact>()
const officialManifestUrls = [new URL("https://api.vintagestory.at/stable.json"), new URL("https://api.vintagestory.at/unstable.json")]
let officialManifestCache: Promise<unknown[]> | undefined

function artifactKey(pathValue: string): string {
  return process.platform === "win32" ? pathValue.toLowerCase() : pathValue
}

function isMd5(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value)
}

async function getOfficialManifests(): Promise<unknown[]> {
  if (!officialManifestCache) {
    officialManifestCache = Promise.all(officialManifestUrls.map((url) => requestBoundedText(url, { maxBytes: MAX_RESPONSE_BYTES }).then((text) => JSON.parse(text))))
  }

  try {
    return await officialManifestCache
  } catch (error) {
    officialManifestCache = undefined
    throw error
  }
}

function findManifestHash(value: unknown, downloadUrl: string): string | undefined {
  if (!isRecord(value)) return undefined

  const urls = value.urls
  if (isRecord(urls)) {
    const candidateUrls = [urls.cdn, urls.local]
    if (candidateUrls.some((candidate) => candidate === downloadUrl) && isMd5(value.md5)) return value.md5.toLowerCase()
  }

  for (const child of Object.values(value)) {
    const result = findManifestHash(child, downloadUrl)
    if (result) return result
  }
  return undefined
}

export async function getTrustedDownloadHash(url: URL): Promise<string | undefined> {
  if (url.hostname !== "cdn.vintagestory.at") return undefined
  const manifests = await getOfficialManifests()
  const expectedHash = manifests.map((manifest) => findManifestHash(manifest, url.toString())).find((hash): hash is string => hash !== undefined)
  if (!expectedHash) throw new Error("Download is not present in the official Vintage Story manifest")
  return expectedHash
}

export async function calculateMd5(pathValue: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("md5")
    const stream = createReadStream(pathValue)
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

export async function recordVerifiedArtifact(pathValue: string, sourceUrl: URL, expectedMd5: string): Promise<void> {
  const actualMd5 = await calculateMd5(pathValue)
  if (actualMd5.toLowerCase() !== expectedMd5.toLowerCase()) throw new Error("Downloaded artifact digest did not match the official manifest")
  verifiedArtifacts.set(artifactKey(pathValue), { md5: expectedMd5.toLowerCase(), sourceUrl: sourceUrl.toString(), verifiedAt: Date.now() })
}

export async function assertVerifiedArtifact(pathValue: string): Promise<void> {
  const record = verifiedArtifacts.get(artifactKey(pathValue))
  if (!record) throw new Error("Installer was not downloaded and verified in this session")
  if (!fse.pathExistsSync(pathValue) || fse.lstatSync(pathValue).isSymbolicLink()) throw new Error("Installer path is unsafe")

  const actualMd5 = await calculateMd5(pathValue)
  if (actualMd5.toLowerCase() !== record.md5) {
    verifiedArtifacts.delete(artifactKey(pathValue))
    throw new Error("Installer digest no longer matches the verified artifact")
  }
}
