import { useTranslation } from "react-i18next"
import { PiDesktopTowerDuotone } from "react-icons/pi"

import { ListItem } from "@renderer/components/ui/List"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"

/**
 * One Mod a server downloaded: art, name, version, and a marker saying where it came from.
 *
 * Deliberately no controls, not even a disabled one. A Mod in here carries no `.disabled` suffix, so
 * a scan reads it as enabled, yet the game loads it only while the player is connected to that
 * server: showing the usual on/off badge would be a lie about what the game does with it, and an
 * update button would offer a write into a folder the game owns and refills on the next join.
 */
function ServerModItem({ iMod }: Readonly<{ iMod: InstalledModType }>): JSX.Element {
  const { t } = useTranslation()

  return (
    <ListItem>
      <div className="@container h-16 flex gap-4 p-2 items-center whitespace-nowrap skip-offscreen-render">
        <div className="shrink-0">
          {iMod._image ? (
            <img src={`cachemodimg:${iMod._image}`} alt={iMod.name} loading="lazy" className="size-12 @max-md:size-10 object-cover rounded-sm" />
          ) : (
            <div className="size-12 @max-md:size-10 bg-zinc-900 rounded-sm shadow-sm shadow-zinc-950" />
          )}
        </div>

        <ThinSeparator />

        <div className="min-w-0 w-full flex gap-2 items-center @max-xl:flex-wrap @max-xl:gap-y-0">
          <p className="min-w-0 truncate font-bold @max-xl:grow">{iMod.name}</p>
          <div className="shrink-0 flex gap-2 items-center">
            <span>·</span>
            <p>v{iMod.version}</p>
          </div>
        </div>

        <ThinSeparator />

        <p className="shrink-0 flex gap-1 items-center text-sm text-zinc-300">
          <PiDesktopTowerDuotone className="text-lg" aria-hidden="true" />
          <span>{t("features.mods.serverModsMarker")}</span>
        </p>
      </div>
    </ListItem>
  )
}

export default ServerModItem
