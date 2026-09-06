import { clampModpackModName } from "@domain/mods/importModpack"
import type { InstalledModSnapshot, ModpackImportEntryReport, ModpackModDetail } from "@domain/mods/importModpack"

/**
 * Builds the manifest an export writes.
 *
 * The local display name rides along with the modid because the two diverge often (`tradie` is
 * Traders Expansion, `sandwich` is Sammiches), and the importing launcher has nothing else to call a
 * mod the ModDB cannot resolve. Nothing reads it as an identifier: the modid stays the key, and the
 * name is clamped rather than passed through verbatim, so one mod with an oversized modinfo.json
 * name can never fail the whole export.
 */
export function toModpackManifest(installation: InstallationType, installedMods: readonly InstalledModType[]): ModpackManifestType {
  return {
    name: installation.name,
    gameVersion: installation.version,
    mods: installedMods.map((mod) => ({ modid: mod.modid, version: mod.version, name: clampModpackModName(mod.name) }))
  }
}

/** Copies an installed mod into the plain shape the planner reads. */
export function toInstalledModSnapshot(mod: InstalledModType): InstalledModSnapshot {
  return { modid: mod.modid, name: mod.name, version: mod.version, path: mod.path, enabled: mod.enabled, assetid: mod._mod?.assetid }
}

/** Copies a queried ModDB mod into the plain shape the planner reads. */
export function toModpackModDetail(mod: DownloadableModType): ModpackModDetail {
  return {
    name: mod.name,
    assetid: mod.assetid,
    releases: mod.releases.map((release) => ({ mainfile: release.mainfile, modidstr: release.modidstr, modversion: release.modversion, tags: release.tags }))
  }
}

/** Turns one report row into the summary row the change popup renders. */
export function toModChangeSummaryEntry(report: ModpackImportEntryReport): ModChangeSummaryEntry {
  return {
    name: report.name,
    modid: report.modid,
    fromVersion: report.fromVersion,
    toVersion: report.toVersion,
    assetid: report.assetid,
    alreadyPresent: report.status === "already-present"
  }
}
