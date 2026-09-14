/**
 * Checking an overlay before it runs, and the folder it wrote afterwards.
 *
 * Two passes, and they answer two different questions.
 *
 * The first is provenance. Every file staged out of the archive is hashed
 * against the manifest's own `files[]`, and nothing the manifest does not name
 * is allowed to be there. The archive's hash already proved the tarball was the
 * published one, so this looks redundant until you remember what is inside it:
 * the donors, the patcher and the CLI itself. A per-file pass is what makes the
 * archive hash reach each of them individually, and it is the reason a missing
 * `expectedInputSha256` upstream is survivable.
 *
 * The second is completion. After a successful run, `.optimum/manifest.json`
 * names what the patch wrote and what it hashed to, and every one of those is
 * checked against the file on disk. That catches the half patch a failed mod
 * donor leaves behind, which still exits 0. It proves the patch finished and
 * that nothing rewrote the assemblies after it; it cannot prove provenance,
 * which the first pass already did upstream.
 */

import fse from "fs-extra"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { join, relative, sep } from "node:path"

import { type OptimumManifest } from "@domain/optimum/manifest"

/** The one file the archive carries that `files[]` never names: the walk that built the list ran before it was written. */
const UNLISTED_ARCHIVE_FILE = "optimum-manifest.json"

/** Where the patch records what it did, relative to the game folder. */
export const OPTIMUM_STATE_FOLDER = ".optimum"

const OPTIMUM_STATE_MANIFEST = join(OPTIMUM_STATE_FOLDER, "manifest.json")

/** The file the patch leaves at the game root, which the launcher's own rollback has to take back out. */
export const OPTIMUM_CONTRACTS_ASSEMBLY = "Optimum.Api.Contracts.dll"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Streams a file through SHA-256, so a 200 MB assembly is never held in memory to be hashed. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash("sha256")
    const reader = createReadStream(path)
    reader.on("error", rejectPromise)
    reader.on("data", (chunk) => digest.update(chunk))
    reader.on("end", () => resolvePromise(digest.digest("hex")))
  })
}

/** Every file under `root`, as forward-slashed paths relative to it. Refuses anything that is not a plain file or folder. */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await fse.readdir(join(root, prefix), { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...(await listFiles(root, path)))
      continue
    }
    // A symbolic link, a socket or a device staged out of an archive is not
    // something to hash and move past. `runExtraction` already refuses these,
    // so reaching one here means something wrote into the cache afterwards.
    if (!entry.isFile()) throw new Error("Staged overlay holds an entry that is not a plain file")
    found.push(path)
  }

  return found
}

/**
 * Whether the staged overlay is byte for byte the one the manifest published.
 *
 * Refuses on the first file that is missing, the wrong size, or the wrong hash,
 * and on any file the manifest does not name. The strict "nothing unlisted"
 * rule has one exception, `optimum-manifest.json` at the root, which the
 * packaging walk cannot list because it is written after the walk.
 *
 * @returns true when every listed file matched and nothing else was there.
 */
export async function verifyStagedOverlay(overlayDirectory: string, manifest: OptimumManifest): Promise<boolean> {
  let staged: string[]
  try {
    staged = await listFiles(overlayDirectory)
  } catch {
    return false
  }

  const listed = new Set(manifest.files.map((file) => file.path))
  const unlisted = staged.filter((path) => path !== UNLISTED_ARCHIVE_FILE && !listed.has(path))
  if (unlisted.length > 0) return false

  for (const file of manifest.files) {
    const path = join(overlayDirectory, ...file.path.split("/"))
    try {
      const stats = await fse.lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.size) return false
      if ((await sha256File(path)) !== file.sha256) return false
    } catch {
      return false
    }
  }

  return true
}

/** One assembly the patch claims to have written, and what it hashed to. */
type PatchedTarget = { assembly: string; patchedHash: string }

function readPatchedTargets(document: unknown): PatchedTarget[] | undefined {
  if (!isRecord(document) || !Array.isArray(document.targets)) return undefined

  const targets: PatchedTarget[] = []
  for (const entry of document.targets) {
    if (!isRecord(entry) || typeof entry.assembly !== "string" || typeof entry.patchedHash !== "string") return undefined
    const hash = /^sha256:([a-f0-9]{64})$/.exec(entry.patchedHash)
    if (!hash?.[1]) return undefined
    targets.push({ assembly: entry.assembly, patchedHash: hash[1] })
  }

  return targets
}

/**
 * Whether the patch really wrote what it says it wrote.
 *
 * Every target the overlay manifest names has to appear in
 * `<game-dir>/.optimum/manifest.json`, and every hash recorded there has to
 * match the file sitting at that path now.
 *
 * @returns true when the patch is complete and intact.
 */
export async function verifyPatchedOutput(gameDirectory: string, manifest: OptimumManifest): Promise<boolean> {
  // A manifest that names no target vouches for nothing, so there would be
  // nothing to check and no reason to believe a patch happened.
  if (manifest.targets.length === 0) return false

  let document: unknown
  try {
    document = await fse.readJSON(join(gameDirectory, OPTIMUM_STATE_MANIFEST))
  } catch {
    return false
  }

  if (!isRecord(document) || document.optimumVersion !== manifest.optimumVersion) return false

  const written = readPatchedTargets(document)
  if (!written) return false

  for (const target of manifest.targets) {
    const record = written.find((entry) => entry.assembly === target.assembly)
    if (!record) return false

    const path = join(gameDirectory, ...target.assembly.split("/"))
    // The assembly paths came out of the overlay manifest, which refuses a `..`
    // segment and a leading slash, so this is belt to that brace rather than the
    // only thing holding the join inside the game folder.
    if (relative(gameDirectory, path).startsWith(`..${sep}`)) return false

    try {
      const stats = await fse.lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink()) return false
      if ((await sha256File(path)) !== record.patchedHash) return false
    } catch {
      return false
    }
  }

  return true
}
