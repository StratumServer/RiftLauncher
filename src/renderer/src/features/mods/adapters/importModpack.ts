import type { InstalledModSnapshot, ModpackImportEntryReport, ModpackModDetail } from "@domain/mods/importModpack"

/** Copies an installed mod into the plain shape the planner reads. */
export function toInstalledModSnapshot(mod: InstalledModType): InstalledModSnapshot {
  return { modid: mod.modid, name: mod.name, version: mod.version, path: mod.path, assetid: mod._mod?.assetid }
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
