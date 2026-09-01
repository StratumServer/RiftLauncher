import { compareVersions } from "../versionNumbers"
import { evaluateModCompatibility } from "./compatibility"
import type { ModCompatibilityVerdict } from "./compatibility"
import type { InstalledModCopy, InstallModFailure, InstallModResult, ModReleaseToInstall } from "./install"

/**
 * Importing a modpack in two halves: decide everything first, then act.
 *
 * The old flow interleaved the two. It queried the ModDB, picked a release, deleted the installed
 * copy and started a download inside one loop body, which meant nothing could be shown, counted or
 * tested before the first file was already gone. Splitting them costs nothing at runtime and buys
 * the whole decision as data: {@link planModpackImport} is pure, so what the import will do to a
 * folder is a value a test can read.
 *
 * Dependencies are deliberately absent. The launcher resolves none today, and a modpack manifest
 * lists every mod it wants explicitly, so nothing here needs them. A plan entry is the obvious place
 * to hang them from if that ever changes.
 */

/** One line of a modpack manifest. */
export interface ModpackEntry {
  modid: string
  version: string
}

/** A mod already in the installation's Mods folder, copied out of wherever it lives. */
export interface InstalledModSnapshot extends InstalledModCopy {
  modid: string
  name: string
  /** False when the copy on disk is turned off, so the game does not load it. */
  enabled: boolean
  /** ModDB page id, when the launcher has already resolved it. Carried for the summary's link. */
  assetid?: number
}

/** One release of a mod as the ModDB publishes it, plus the tags the pick reads. */
export interface ModpackRelease extends ModReleaseToInstall {
  tags: readonly string[]
}

/** The ModDB detail the caller fetched for one entry, as plain data. */
export interface ModpackModDetail {
  name: string
  assetid?: number
  /** Newest first, the order the API serves them in. */
  releases: readonly ModpackRelease[]
}

/** Why an entry will not be downloaded. */
export type ModpackSkipReason =
  /** The installed copy is already the exact version the manifest asks for. */
  | "already-present"
  /** No ModDB page answers for this modid. */
  | "not-on-moddb"
  /** The page exists but publishes no release at all. */
  | "no-release"

/** An entry the import will install, with the release it settled on. */
export interface ModpackInstallItem {
  decision: "install"
  modid: string
  /** Version the manifest asked for, which the picked release does not always match. */
  requestedVersion: string
  /** Mod name as the ModDB publishes it. */
  name: string
  assetid?: number
  release: ModpackRelease
  /** How the picked release's tags relate to the installation's game version. */
  compatibility: ModCompatibilityVerdict
  /** True when the picked release is older than the copy installed. */
  downgrade: boolean
  /** The copy this install replaces, absent when the mod is new to the installation. */
  existing?: InstalledModCopy
  /** Version currently installed, or null when the mod is new. */
  fromVersion: string | null
}

/** An entry the import will not install, and why. */
export interface ModpackSkippedItem {
  decision: "skip"
  modid: string
  requestedVersion: string
  /** The ModDB name when the page was found, the raw modid when it was not. */
  name: string
  assetid?: number
  reason: ModpackSkipReason
  fromVersion: string | null
}

export type ModpackPlanItem = ModpackInstallItem | ModpackSkippedItem

/** Everything one import intends to do, in manifest order. */
export interface ModpackImportPlan {
  items: ModpackPlanItem[]
  /** Entries whose picked release is older than what is installed. */
  downgrades: ModpackInstallItem[]
}

export interface ModpackPlanInput {
  entries: readonly ModpackEntry[]
  installed: readonly InstalledModSnapshot[]
  /** Game version of the target installation, without a leading "v". */
  gameVersion: string
  /** ModDB detail per modid, for every entry {@link modpackEntriesToResolve} asked for. */
  details: ReadonlyMap<string, ModpackModDetail>
}

function installedFor(installed: readonly InstalledModSnapshot[], modid: string): InstalledModSnapshot | undefined {
  return installed.find((mod) => mod.modid === modid)
}

/**
 * The installed copy that already answers this entry exactly, when there is one and nothing has to
 * happen.
 *
 * A disabled copy never answers it. A pack is a playable set, so importing one over a mod the player
 * had turned off reinstalls it enabled rather than reporting it as already there and leaving the
 * game unable to load a mod the pack asks for.
 */
function satisfyingCopy(entry: ModpackEntry, existing: InstalledModSnapshot | undefined): InstalledModSnapshot | undefined {
  return existing?.enabled === true && existing.version === entry.version ? existing : undefined
}

/**
 * The entries that still need a ModDB lookup.
 *
 * The caller fetches these and hands the details back to {@link planModpackImport}. It exists so
 * that a pack whose mods are all installed costs no network calls at all, which is what the old
 * interleaved loop achieved by checking the folder before querying.
 */
export function modpackEntriesToResolve(entries: readonly ModpackEntry[], installed: readonly InstalledModSnapshot[]): ModpackEntry[] {
  return entries.filter((entry) => satisfyingCopy(entry, installedFor(installed, entry.modid)) === undefined)
}

/**
 * Entries the manifest would replace with an older version.
 *
 * Read straight off the manifest rather than off a plan, because the warning is shown before the
 * user agrees to anything, which is before a single ModDB page has been fetched.
 */
export function modpackDowngrades(entries: readonly ModpackEntry[], installed: readonly InstalledModSnapshot[]): ModpackEntry[] {
  return entries.filter((entry) => {
    const existing = installedFor(installed, entry.modid)
    return existing !== undefined && compareVersions(entry.version, existing.version) < 0
  })
}

/**
 * Picks the release to install for one entry.
 *
 * The order is the one the import has always used and is not an accident:
 *
 * 1. the exact version the manifest names, because reproducing a pack is the whole point;
 * 2. failing that, the newest release the author tagged for this game series, because a pack made
 *    for a different patch level is still worth installing;
 * 3. failing that, the newest release there is, because an author who never tags anything should not
 *    make the pack unimportable.
 *
 * Step 2 reads {@link evaluateModCompatibility} rather than matching tag prefixes by hand, which is
 * the same test the rest of the launcher applies: an exact tag or any tag in the same Major.Minor
 * series counts, nothing else does.
 */
function pickRelease(releases: readonly ModpackRelease[], requestedVersion: string, gameVersion: string): ModpackRelease | undefined {
  const exact = releases.find((release) => release.modversion === requestedVersion)
  if (exact) return exact

  const compatible = releases.find((release) => evaluateModCompatibility(release.tags, gameVersion) !== "undeclared")
  if (compatible) return compatible

  return releases[0]
}

function planEntry(entry: ModpackEntry, input: ModpackPlanInput): ModpackPlanItem {
  const existing = installedFor(input.installed, entry.modid)
  const fromVersion = existing?.version ?? null

  const satisfied = satisfyingCopy(entry, existing)
  if (satisfied) {
    // Named off the installed copy: the ModDB was never asked about this one.
    return { decision: "skip", modid: entry.modid, requestedVersion: entry.version, name: satisfied.name, assetid: satisfied.assetid, reason: "already-present", fromVersion }
  }

  const detail = input.details.get(entry.modid)
  if (!detail) return { decision: "skip", modid: entry.modid, requestedVersion: entry.version, name: entry.modid, reason: "not-on-moddb", fromVersion }

  const release = pickRelease(detail.releases, entry.version, input.gameVersion)
  if (!release) {
    return { decision: "skip", modid: entry.modid, requestedVersion: entry.version, name: detail.name, assetid: detail.assetid, reason: "no-release", fromVersion }
  }

  return {
    decision: "install",
    modid: entry.modid,
    requestedVersion: entry.version,
    name: detail.name,
    assetid: detail.assetid,
    release,
    compatibility: evaluateModCompatibility(release.tags, input.gameVersion),
    downgrade: existing !== undefined && compareVersions(release.modversion, existing.version) < 0,
    existing: existing && { path: existing.path, version: existing.version },
    fromVersion
  }
}

/**
 * Decides what an import will do to an installation, without touching it.
 *
 * @param input The manifest, what is already installed, the game version and the fetched details.
 * @returns One item per manifest entry, in manifest order.
 */
export function planModpackImport(input: ModpackPlanInput): ModpackImportPlan {
  const items = input.entries.map((entry) => planEntry(entry, input))

  return { items, downgrades: items.filter((item): item is ModpackInstallItem => item.decision === "install" && item.downgrade) }
}

/** What became of one manifest entry. The skip reasons carry over untouched from the plan. */
export type ModpackEntryStatus = "installed" | ModpackSkipReason | InstallModFailure

/** One row of what the import did, ready for the caller's summary. */
export interface ModpackImportEntryReport {
  modid: string
  name: string
  assetid?: number
  /** Version installed before the import, or null when the mod was new. */
  fromVersion: string | null
  /** Version installed after it, or null when nothing was installed. */
  toVersion: string | null
  status: ModpackEntryStatus
}

export interface ModpackImportReport {
  entries: ModpackImportEntryReport[]
  installed: number
  /** Entries that were meant to be installed and were not. Planned skips do not count. */
  failed: number
}

/**
 * Installs one planned entry.
 *
 * A function rather than a set of ports because the host has to name the download task in the user's
 * language, and only the host knows how. The renderer wires it straight to the install service, so
 * every mod the launcher installs, from any flow, goes through exactly the same code.
 */
export interface ModInstaller {
  install(item: ModpackInstallItem): Promise<InstallModResult>
}

export interface ExecuteModpackImportPorts {
  installer: ModInstaller
}

export interface ExecuteModpackImportInput {
  plan: ModpackImportPlan
}

export interface ModpackImportEvents {
  /** Fired when an entry's download is about to start. Planned skips never fire it. */
  onEntryStarted?(modid: string): void
  /** Fired once per entry, skips included, in manifest order. */
  onEntrySettled?(report: ModpackImportEntryReport): void
}

function reportSkip(item: ModpackSkippedItem): ModpackImportEntryReport {
  // An already-present entry reports the version it is sitting at, which is the version the manifest
  // asked for. Everything else has nothing to report as installed.
  const toVersion = item.reason === "already-present" ? item.fromVersion : null

  return { modid: item.modid, name: item.name, assetid: item.assetid, fromVersion: item.fromVersion, toVersion, status: item.reason }
}

/**
 * Runs a plan, one entry at a time, and says what happened to each.
 *
 * One entry's failure never stops the import: a pack of forty mods where one has been taken off the
 * ModDB still installs the other thirty-nine, and the summary names the one that did not. Entries
 * run in sequence rather than at once so the progress the user watches matches the order they read
 * in the table.
 *
 * @param ports The installer the planned entries run through.
 * @param input The plan produced by {@link planModpackImport}.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns One report row per manifest entry, plus the counts a final message needs.
 */
export async function executeModpackImport(ports: ExecuteModpackImportPorts, input: ExecuteModpackImportInput, events: ModpackImportEvents = {}): Promise<ModpackImportReport> {
  const entries: ModpackImportEntryReport[] = []
  let installed = 0
  let failed = 0

  for (const item of input.plan.items) {
    if (item.decision === "skip") {
      const report = reportSkip(item)
      entries.push(report)
      events.onEntrySettled?.(report)
      continue
    }

    events.onEntryStarted?.(item.modid)

    const result = await ports.installer.install(item)

    if (result.ok) installed++
    else failed++

    const report: ModpackImportEntryReport = {
      modid: item.modid,
      name: item.name,
      assetid: item.assetid,
      fromVersion: item.fromVersion,
      toVersion: result.ok ? item.release.modversion : null,
      status: result.ok ? "installed" : result.reason
    }

    entries.push(report)
    events.onEntrySettled?.(report)
  }

  return { entries, installed, failed }
}
