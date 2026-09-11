import { useTranslation } from "react-i18next"
import { FiLoader } from "react-icons/fi"

import { findModUpdate } from "@domain/mods/compatibility"
import { installedCopiesOf } from "@domain/mods/installedFilters"
import { GridGroup, GridWrapper } from "@renderer/components/ui/Grid"
import ModListCard, { type ModCardAction } from "@renderer/features/mods/components/ModListCard"
import { quickInstallKey } from "@renderer/features/mods/hooks/useInstalledModActions"

/**
 * The ModDB results grid: a loading/empty state, or the visible slice of Mods as cards.
 *
 * Every card prop is worked out here as a primitive, so a card is re-rendered only when its own
 * state moved, never because the page handed over a fresh array or a rescan built new copies.
 */
function ModsGrid({
  mods,
  visibleCount,
  searching,
  installedMods,
  installationId,
  gameVersion,
  details,
  suspendedModUpdates,
  isBusy,
  isModFav,
  onSelectMod,
  onToggleFavMod,
  onOpenModDb,
  onModAction
}: Readonly<{
  mods: DownloadableModOnListType[]
  visibleCount: number
  searching: boolean
  /** The selected Installation's Mods folder, as the last scan read it. */
  installedMods: readonly InstalledModType[]
  /** The Installation card actions act on. Without one no card offers any. */
  installationId?: string
  /** The Installation's game version, which decides whether a newer release is tagged for it. */
  gameVersion: string
  /** ModDB details already looked up, by ModDB mod id. */
  details: ReadonlyMap<number, DownloadableModType>
  suspendedModUpdates: readonly string[]
  isBusy: (key: string) => boolean
  isModFav: (mod: DownloadableModOnListType) => boolean
  onSelectMod: (mod: DownloadableModOnListType) => void
  onToggleFavMod: (mod: DownloadableModOnListType) => void
  onOpenModDb: (mod: DownloadableModOnListType) => void
  onModAction: (mod: DownloadableModOnListType, action: ModCardAction) => void | Promise<unknown>
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <GridWrapper className="my-auto">
      <GridGroup>
        {mods.length < 1 ? (
          <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
            {searching ? <FiLoader className="animate-spin text-4xl text-zinc-400" /> : t("features.mods.noMatchingFilters")}
          </div>
        ) : (
          mods.slice(0, visibleCount).map((mod) => {
            const copies = installedCopiesOf(mod.modidstrs, installedMods)
            const copy = copies.length === 1 ? copies[0] : undefined
            const releases = copy && details.get(mod.modid)?.releases

            return (
              <ModListCard
                key={mod.modid}
                mod={mod}
                installed={copies.length > 0}
                isFav={isModFav(mod)}
                onSelect={onSelectMod}
                onToggleFav={onToggleFavMod}
                onOpenModDb={onOpenModDb}
                installationId={installationId}
                copyState={copies.length > 1 ? "several" : copy && (copy.enabled ? "enabled" : "disabled")}
                suspended={copy !== undefined && suspendedModUpdates.includes(copy.modid)}
                busy={isBusy(copy ? copy.path : quickInstallKey(mod.modid))}
                updateTo={copy && releases ? findModUpdate(copy.version, releases, gameVersion).updatableTo : undefined}
                onAction={onModAction}
              />
            )
          })
        )}
      </GridGroup>
    </GridWrapper>
  )
}

export default ModsGrid
