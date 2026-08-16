import type { DirectoryReader, IconStore, ModArchiveProblem, ModArchiveReader, PathBuilder } from "../ports"
import { parseModInfo } from "./modinfo"
import type { ModInfoProblem } from "./modinfo"

/**
 * Most archives one scan will open, however many the folder holds.
 *
 * A Mods folder is user managed and can be pointed at anything, so the scan
 * refuses to grow without limit. Two thousand is far past any real load order.
 */
export const MAX_MOD_ARCHIVES = 2_000

/**
 * How many archives are read at once.
 *
 * Each read holds a file handle and a buffer, so the scan works through the
 * folder in fixed slices rather than firing every archive off at once. A batch
 * is finished when every read in it has finished, which is what keeps the
 * number of handles the host holds bounded by this number.
 */
export const MOD_SCAN_BATCH_SIZE = 16

/** Extension an archive has to carry to be considered a mod at all. */
const MOD_ARCHIVE_EXTENSION = ".zip"

/** A mod the scan identified, ready for the caller to hand to the UI. */
export interface ScannedMod {
  name: string
  modid: string
  version: string
  /** Full path of the archive it was read from. */
  path: string
  description?: string
  side?: string
  authors?: string[]
  contributors?: string[]
  type?: string
  /** Name the mod's icon was stored under, absent when it has none. */
  image?: string
}

/** Why one archive did not turn into a mod. */
export type ModScanProblem = ModArchiveProblem | ModInfoProblem | "modinfo-missing"

/** One archive the scan could not identify, and why. */
export interface UnidentifiedModArchive {
  /** Archive file name, without its folder. */
  zipname: string
  /** Full path of the archive. */
  path: string
  problem: ModScanProblem
}

/** Everything one scan found, identified and not. */
export interface ScanInstalledModsResult {
  mods: ScannedMod[]
  errors: UnidentifiedModArchive[]
}

/**
 * How many mod archives an installation holds, identified or not.
 *
 * The archives the scan could not read count too, and that is the point: they are still files in the
 * Mods folder, the game still tries to load them, and an installation showing "12 Mods" while
 * holding fourteen zips is a lie the user cannot act on.
 */
export function installedModsTotal(scan: { mods: readonly unknown[]; errors: readonly unknown[] }): number {
  return scan.mods.length + scan.errors.length
}

export interface ScanInstalledModsPorts {
  directories: DirectoryReader
  archives: ModArchiveReader
  icons: IconStore
  paths: PathBuilder
}

export interface ScanInstalledModsInput {
  /** Folder holding the archives. Usually an installation's `Mods` folder. */
  folder: string
}

/**
 * Side effects the caller owns: logging, progress, notifications. The service
 * only says when they happen.
 */
export interface ScanInstalledModsEvents {
  /** Fired once the folder is listed and bounded, with how many archives will be read. */
  onArchivesFound?(count: number): void
  /** Fired for each archive that produced a mod. */
  onModIdentified?(mod: ScannedMod): void
  /** Fired for each archive that did not, in the order the scan settled them. */
  onArchiveUnidentified?(archive: UnidentifiedModArchive): void
}

/** What reading one archive settled on. Exactly one of the two, never both. */
type ArchiveOutcome = { mod: ScannedMod } | { problem: ModScanProblem }

/** True for a name the scan will bother opening. */
function looksLikeModArchive(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(MOD_ARCHIVE_EXTENSION)
}

/**
 * Reads one archive and decides what it is.
 *
 * The order matters: the metadata is read before the icon is stored, so an
 * archive that turns out not to describe a mod never leaves an icon behind in
 * the store that nothing will ever point at.
 */
async function readArchive(ports: ScanInstalledModsPorts, archivePath: string): Promise<ArchiveOutcome> {
  const read = await ports.archives.read(archivePath)
  if (!read.ok) return { problem: read.problem }

  const { modinfo, icon } = read.content
  if (modinfo === undefined) return { problem: "modinfo-missing" }

  const info = parseModInfo(modinfo)
  if (!info.ok) return { problem: info.problem }

  const mod: ScannedMod = { ...info.info, path: archivePath }

  // A stored icon is a nicety. Failing to store one leaves the mod listed
  // without it, which is what the UI already falls back to.
  if (icon !== undefined) {
    const image = await ports.icons.store(icon)
    if (image !== undefined) mod.image = image
  }

  return { mod }
}

/**
 * Reads every mod archive in a folder and says what each one is.
 *
 * The result carries both halves on purpose. A folder of two hundred mods
 * regularly holds one archive that is truncated, one that is a resource pack
 * with no `modinfo.json` and one whose author left a trailing comma the parser
 * of the day did not like. Dropping those silently would leave the user
 * wondering where a mod went, and refusing the whole scan over them would be
 * worse still, so each one comes back named alongside the mods that did work.
 *
 * Nothing here touches a file handle: reading an archive is one call to the
 * archive reader, which opens it, takes what it needs and closes it before
 * resolving. That is what makes the batch bound real, because an archive can
 * never still be reading once the batch it belonged to has finished.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The folder to scan.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns The mods that were identified, and every archive that was not.
 */
export async function scanInstalledMods(ports: ScanInstalledModsPorts, input: ScanInstalledModsInput, events: ScanInstalledModsEvents = {}): Promise<ScanInstalledModsResult> {
  const names = (await ports.directories.listFileNames(input.folder)).filter(looksLikeModArchive).slice(0, MAX_MOD_ARCHIVES)

  events.onArchivesFound?.(names.length)

  const mods: ScannedMod[] = []
  const errors: UnidentifiedModArchive[] = []

  for (let batchStart = 0; batchStart < names.length; batchStart += MOD_SCAN_BATCH_SIZE) {
    const batch = names.slice(batchStart, batchStart + MOD_SCAN_BATCH_SIZE)

    const settled = await Promise.all(
      batch.map(async (zipname) => {
        const archivePath = await ports.paths.join([input.folder, zipname])
        return { zipname, archivePath, outcome: await readArchive(ports, archivePath) }
      })
    )

    // Collected after the batch rather than inside each read, so the two lists
    // come out in folder order however the reads interleaved.
    for (const { zipname, archivePath, outcome } of settled) {
      if ("mod" in outcome) {
        mods.push(outcome.mod)
        events.onModIdentified?.(outcome.mod)
      } else {
        const archive: UnidentifiedModArchive = { zipname, path: archivePath, problem: outcome.problem }
        errors.push(archive)
        events.onArchiveUnidentified?.(archive)
      }
    }
  }

  return { mods, errors }
}
