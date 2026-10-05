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
 * checked against the file on disk. Its CLR metadata references are also read
 * from the AssemblyRef table and checked against the game's root, `Lib` and
 * `Mods` folders. That catches the half patch a failed mod donor leaves behind,
 * which still exits 0. It proves the patch finished and that nothing rewrote
 * the assemblies after it; it cannot prove provenance, which the first pass
 * already did upstream.
 */

import fse from "fs-extra"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { join, relative, sep } from "node:path"

import { readOptimumAssemblyReferences } from "@domain/optimum/assemblyReferences"
import { type OptimumManifest } from "@domain/optimum/manifest"
import { OPTIMUM_ASSEMBLY_SEARCH_FOLDERS, OPTIMUM_STATE_FOLDER } from "@domain/optimum/plan"
import { isRecord } from "@domain/records"

/** The manifest file the archive carries that `files[]` never names: the walk ran before it was written. */
function isUnlistedManifestFile(path: string, manifest: OptimumManifest): boolean {
  return path === "optimum-manifest.json" || path === `optimum-manifest-${manifest.rid}.json`
}

const OPTIMUM_STATE_MANIFEST = join(OPTIMUM_STATE_FOLDER, "manifest.json")

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
 * rule has one exception for the root manifest, written after the packaging
 * walk. Both the legacy name and the current RID-specific name are accepted.
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
  const unlisted = staged.filter((path) => !isUnlistedManifestFile(path, manifest) && !listed.has(path))
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
 * `<game-dir>/.optimum/manifest.json`, every hash recorded there has to match
 * the file on disk, and its AssemblyRef entries must resolve to a file in the
 * game's root, `Lib` or `Mods` folder.
 *
 * @returns true when the patch is complete and intact.
 */
export type PatchedOutputVerification = { ok: true } | { ok: false; reason: "unverified" } | { ok: false; reason: "missing-assembly"; target: string; assembly: string }

type OptimumReferenceVerification = { ok: true } | { ok: false; reason: "unverified" } | { ok: false; reason: "missing-assembly"; assembly: string }

export async function verifyPatchedOutput(gameDirectory: string, manifest: OptimumManifest): Promise<PatchedOutputVerification> {
  // A manifest that names no target vouches for nothing, so there would be
  // nothing to check and no reason to believe a patch happened.
  if (manifest.targets.length === 0) return { ok: false, reason: "unverified" }

  let document: unknown
  try {
    document = await fse.readJSON(join(gameDirectory, OPTIMUM_STATE_MANIFEST))
  } catch {
    return { ok: false, reason: "unverified" }
  }

  if (!isRecord(document) || document.optimumVersion !== manifest.optimumVersion) return { ok: false, reason: "unverified" }

  const written = readPatchedTargets(document)
  if (!written) return { ok: false, reason: "unverified" }

  for (const target of manifest.targets) {
    const record = written.find((entry) => entry.assembly === target.assembly)
    if (!record) return { ok: false, reason: "unverified" }

    const path = join(gameDirectory, ...target.assembly.split("/"))
    // The assembly paths came out of the overlay manifest, which refuses a `..`
    // segment and a leading slash, so this is belt to that brace rather than the
    // only thing holding the join inside the game folder.
    if (relative(gameDirectory, path).startsWith(`..${sep}`)) return { ok: false, reason: "unverified" }

    try {
      const stats = await fse.lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink()) return { ok: false, reason: "unverified" }
      if ((await sha256File(path)) !== record.patchedHash) return { ok: false, reason: "unverified" }
      const references = await verifyOptimumReferences(gameDirectory, path)
      if (!references.ok) {
        if (references.reason === "missing-assembly") return { ok: false, reason: "missing-assembly", target: target.assembly, assembly: references.assembly }
        return references
      }
    } catch {
      return { ok: false, reason: "unverified" }
    }
  }

  return { ok: true }
}

/** Reads one verified target's CLR references and checks Vintage Story's game assembly folders. */
async function verifyOptimumReferences(gameDirectory: string, targetPath: string): Promise<OptimumReferenceVerification> {
  let image: Buffer
  try {
    // Metadata tables need random access. Buffer keeps the single image read in
    // memory; unlike the former latin1 scan it does not allocate a second copy.
    image = await fse.readFile(targetPath)
  } catch {
    return { ok: false, reason: "unverified" }
  }

  const references = readOptimumAssemblyReferences(image)
  if (!references) return { ok: false, reason: "unverified" }

  const checks = await Promise.all(
    references.map(async (assembly) => {
      const available = await Promise.all(OPTIMUM_ASSEMBLY_SEARCH_FOLDERS.map((folder) => fse.pathExists(join(gameDirectory, folder, assembly))))
      return available.some(Boolean) ? undefined : assembly
    })
  )
  const missing = checks.find((assembly) => assembly !== undefined)
  if (missing) return { ok: false, reason: "missing-assembly", assembly: missing }

  return { ok: true }
}
