#!/usr/bin/env node
/**
 * Builds a throwaway RiftLauncher profile for a headless check: a config.json
 * at the schema the launcher reads today, the managed installations and game
 * version folders it points at, and (optionally) a handful of fabricated
 * Mods so a Mods list has something to show.
 *
 * No dependency: the fabricated Mods are zips written by hand with node:zlib
 * (deflateRawSync for the entry, zlib.crc32 for its checksum), holding
 * nothing but a modinfo.json, which is all scanInstalledMods
 * (src/domain/mods/scanInstalled.ts) needs to identify a Mod.
 *
 *   node scripts/headless/seed.mjs <specPath> <profileRoot>
 *
 * <profileRoot> becomes the three XDG roots launch.sh points the packaged
 * build at: <profileRoot>/config (XDG_CONFIG_HOME, where config.json and the
 * managed folders live), /cache and /data (XDG_CACHE_HOME / XDG_DATA_HOME,
 * created empty).
 *
 * Spec shape (see tests/config/headlessSeed.test.ts for a validated example):
 *
 *   {
 *     "installations": [
 *       { "name": "Vanilla", "gameVersion": "1.20.4", "mods": ["Primitive Survival"] }
 *     ],
 *     "window": { "width": 1024, "height": 600 },
 *     "backupsLimit": 5,
 *     "lastSeenChangelogVersion": "1.7.0",
 *     "moddbVisibilityAnswer": "declined"
 *   }
 *
 * Every top-level field but "installations" is optional. "moddbVisibilityAnswer"
 * answers the ModDB visibility prompt in advance, under its pre-#477 name
 * (one of "unasked", "accepted", "declined", "already-done"): the config
 * normalizer still reads that name and migrates it, so the seed does not need
 * to know today's answeredVersion/countedVersions shape to pre-answer it.
 * Leave it out to seed a profile where the prompt still shows, which is what
 * a check that exercises the prompt itself wants.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { deflateRawSync, crc32 } from "node:zlib"

// Kept as a plain literal, not an import: scripts/ runs straight through node with no build
// step, and src/domain/config/migrations.ts is TypeScript. Bump this by hand to match that
// file's own CURRENT_CONFIG_SCHEMA whenever a schema migration lands, and shape the config
// object below to match. If it drifts, tests/config/headlessSeed.test.ts fails instead of a
// reviewer finding out from a broken headless check weeks later.
const CURRENT_CONFIG_SCHEMA = 6
const DEFAULT_COMPRESSION_LEVEL = 6
const DEFAULT_BACKGROUND_ID = "default"
const DEFAULT_ACCENT_ID = "amber"
const DEFAULT_INSTALLATION_BACKUPS_LIMIT = 3

function usageError(message) {
  console.error(message)
  console.error("usage: node scripts/headless/seed.mjs <specPath> <profileRoot>")
  process.exit(1)
}

const [, , specPath, profileRoot] = process.argv
if (!specPath || !profileRoot) usageError("both <specPath> and <profileRoot> are required.")

let spec
try {
  spec = JSON.parse(readFileSync(specPath, "utf-8"))
} catch (err) {
  usageError(`could not read the spec at ${specPath}: ${err.message}`)
}

/** Lowercase, hyphenated, and never empty: good enough for a folder or file name, not for display. */
function slugify(text, fallback) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || fallback
}

/** Appends -2, -3, ... until `candidate` is not already in `used`, then reserves it. */
function dedupe(candidate, used) {
  let id = candidate
  let suffix = 2
  while (used.has(id)) id = `${candidate}-${suffix++}`
  used.add(id)
  return id
}

// --- a modinfo-only mod archive, built by hand -----------------------------------------------

/** One ZIP local/central file header pair, deflate-compressed, no dependency but node:zlib itself. */
function zipEntry(name, content) {
  const nameBytes = Buffer.from(name, "utf-8")
  const data = Buffer.from(content, "utf-8")
  const compressed = deflateRawSync(data)
  const checksum = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0) // local file header signature
  local.writeUInt16LE(20, 4) // version needed to extract
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(8, 8) // method: deflate
  local.writeUInt16LE(0, 10) // mod time
  local.writeUInt16LE(0, 12) // mod date
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28) // extra field length

  return { nameBytes, compressed, checksum, uncompressedSize: data.length, localRecord: Buffer.concat([local, nameBytes, compressed]) }
}

/** A single-entry ZIP holding one `modinfo.json`, which is all scanInstalledMods reads off an archive. */
function buildModArchive(modinfo) {
  const entry = zipEntry("modinfo.json", JSON.stringify(modinfo, null, 2))
  const offset = 0

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0) // central directory header signature
  central.writeUInt16LE(20, 4) // version made by
  central.writeUInt16LE(20, 6) // version needed to extract
  central.writeUInt16LE(0, 8) // flags
  central.writeUInt16LE(8, 10) // method: deflate
  central.writeUInt16LE(0, 12) // mod time
  central.writeUInt16LE(0, 14) // mod date
  central.writeUInt32LE(entry.checksum, 16)
  central.writeUInt32LE(entry.compressed.length, 20)
  central.writeUInt32LE(entry.uncompressedSize, 24)
  central.writeUInt16LE(entry.nameBytes.length, 28)
  central.writeUInt16LE(0, 30) // extra field length
  central.writeUInt16LE(0, 32) // comment length
  central.writeUInt16LE(0, 34) // disk number start
  central.writeUInt16LE(0, 36) // internal attributes
  central.writeUInt32LE(0, 38) // external attributes
  central.writeUInt32LE(offset, 42) // local header offset
  const centralRecord = Buffer.concat([central, entry.nameBytes])

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(1, 8) // entries on this disk
  end.writeUInt16LE(1, 10) // total entries
  end.writeUInt32LE(centralRecord.length, 12) // central directory size
  end.writeUInt32LE(entry.localRecord.length, 16) // central directory offset
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([entry.localRecord, centralRecord, end])
}

// --- the profile itself -----------------------------------------------------------------------

const configDir = join(profileRoot, "config")
const cacheDir = join(profileRoot, "cache")
const dataDir = join(profileRoot, "data")
const userDataDir = join(configDir, "RiftLauncher")
const installationsRoot = join(configDir, "RiftLauncherInstallations")
const versionsRoot = join(configDir, "RiftLauncherGameVersions")

for (const dir of [configDir, cacheDir, dataDir, userDataDir, installationsRoot, versionsRoot]) mkdirSync(dir, { recursive: true })

const usedVersionIds = new Set()
const gameVersionsByVersion = new Map()
const usedInstallationIds = new Set()

const installations = (spec.installations ?? []).map((entry) => {
  if (!entry.name || !entry.gameVersion) usageError('each installation needs a "name" and a "gameVersion".')

  let gameVersion = gameVersionsByVersion.get(entry.gameVersion)
  if (!gameVersion) {
    const id = dedupe(slugify(entry.gameVersion, "version"), usedVersionIds)
    const path = join(versionsRoot, id)
    mkdirSync(path, { recursive: true })
    gameVersion = { id, version: entry.gameVersion, label: entry.gameVersion, path }
    gameVersionsByVersion.set(entry.gameVersion, gameVersion)
  }

  const id = dedupe(slugify(entry.name, "installation"), usedInstallationIds)
  const path = join(installationsRoot, id)
  const modsDir = join(path, "Mods")
  mkdirSync(modsDir, { recursive: true })

  const usedModIds = new Set()
  for (const modName of entry.mods ?? []) {
    const modid = dedupe(slugify(modName, "mod"), usedModIds)
    const archive = buildModArchive({ name: modName, modid, version: "1.0.0" })
    writeFileSync(join(modsDir, `${modid}.zip`), archive)
  }

  return {
    id,
    name: entry.name,
    icon: "",
    path,
    version: entry.gameVersion,
    gameVersionId: gameVersion.id,
    startParams: "",
    backupsLimit: spec.backupsLimit ?? DEFAULT_INSTALLATION_BACKUPS_LIMIT,
    backupsAuto: false,
    compressionLevel: DEFAULT_COMPRESSION_LEVEL,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
})

const config = {
  schemaVersion: CURRENT_CONFIG_SCHEMA,
  lastUsedInstallation: null,
  defaultInstallationsFolder: installationsRoot,
  defaultVersionsFolder: versionsRoot,
  backupsFolder: join(configDir, "RiftLauncherBackups"),
  window: {
    width: spec.window?.width ?? 1280,
    height: spec.window?.height ?? 720,
    x: 0,
    y: 0,
    maximized: false
  },
  accounts: [],
  activeAccountId: null,
  installations,
  gameVersions: [...gameVersionsByVersion.values()],
  favMods: [],
  suspendedModUpdates: [],
  background: DEFAULT_BACKGROUND_ID,
  accentColor: DEFAULT_ACCENT_ID,
  // Added at schema 6 (#498): nobody has answered the mod-suggestions consent question yet,
  // and none has been dismissed, same as any config written before that field existed.
  modSuggestionsConsent: null,
  dismissedModSuggestions: [],
  receiveBetaUpdates: null,
  measurePlaySessions: true,
  allowBasicSessionStore: false,
  lastSeenChangelogVersion: spec.lastSeenChangelogVersion ?? "",
  customIcons: [],
  // Already at today's shape (see src/domain/moddbVisibility.ts) unless the spec asks to
  // pre-answer, in which case the pre-#477 string name is written instead and the config
  // normalizer migrates it on the launcher's own first read. Both are valid input to
  // normalizeConfig; see tests/config/headlessSeed.test.ts for both paths.
  ...(spec.moddbVisibilityAnswer !== undefined ? { moddbVisibilityAnswer: spec.moddbVisibilityAnswer } : { moddbVisibility: { policy: "ask", answeredVersion: "", countedVersions: [] } })
}

writeFileSync(join(userDataDir, "config.json"), JSON.stringify(config, null, 2))

console.log(
  JSON.stringify(
    {
      configDir,
      cacheDir,
      dataDir,
      userDataDir,
      installations: installations.map(({ id, name, path }) => ({ id, name, path })),
      gameVersions: [...gameVersionsByVersion.values()].map(({ id, version, path }) => ({ id, version, path }))
    },
    null,
    2
  )
)
