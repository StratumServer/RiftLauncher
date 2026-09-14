import { useState } from "react"
import { useTranslation } from "react-i18next"

import { useServerMods } from "@renderer/features/mods/hooks/useServerMods"
import { useExportModpack } from "@renderer/features/mods/hooks/useExportModpack"

import { matchesModSearch } from "@domain/mods/installedFilters"

import ServerModsGroup from "@renderer/features/mods/components/ServerModsGroup"
import RemoveServerModsDialog from "@renderer/features/mods/components/RemoveServerModsDialog"

/**
 * Every server that sent this Installation Mods, one collapsed group each.
 *
 * Nothing here feeds the Installation's Mod count, the page's selection or Update all: those all
 * read `installedMods`, which comes from the `Mods` folder and structurally never holds a server's
 * Mod. The group headers are what account for the archives on disk that the count does not.
 *
 * "Save as a modpack" rather than "save as a profile": a profile is applied against the `Mods`
 * folder, so a profile built from a server's set would count every entry as missing and turn the
 * player's own Mods off while turning nothing on. The manifest is the shape that already means
 * "reproduce this set later", and importing one downloads into the Mods folder.
 *
 * @param search The page's search field, trimmed and lower-cased. It narrows an open group; the
 *   three filter dropdowns do not, because they filter a list this is not part of.
 * @param reloadToken The page's Reload button, counted up, so the groups are re-read with the rest.
 */
function ServerModsSection({ installation, search, reloadToken }: Readonly<{ installation: InstallationType; search: string; reloadToken: number }>): JSX.Element | null {
  const { t } = useTranslation()
  const { groups, truncated, unreadable, remove, removing } = useServerMods(installation, reloadToken)
  const exportModpack = useExportModpack()

  const [openServer, setOpenServer] = useState<string | null>(null)
  const [groupToRemove, setGroupToRemove] = useState<ServerModGroupType | null>(null)

  // A folder that will not open is the one case the feature exists to answer: the player is looking
  // for the disk the Mod list does not explain, and an empty page would tell them there is nothing
  // there. So the region stays for that, and only for that.
  if (groups.length < 1 && !unreadable) return null

  return (
    <>
      <div className="w-full flex flex-col gap-1">
        <h2 className="text-2xl text-center font-bold">{t("features.mods.serverModsTitle")}</h2>
        {/* zinc-200, not the zinc-400 the groups use: these two lines are the only prose in the
            feature that sits on the shell scrim alone, with no list panel under them. */}
        {truncated && (
          <p role="status" className="text-zinc-200 text-center text-sm">
            {t("features.mods.serverModsTruncated")}
          </p>
        )}
        {unreadable && (
          <p role="status" className="text-zinc-200 text-center text-sm">
            {t("features.mods.serverModsFolderUnreadable")}
          </p>
        )}
      </div>

      {groups.map((group) => (
        <ServerModsGroup
          key={group.path}
          group={group}
          mods={search ? group.mods.filter((iMod) => matchesModSearch(iMod, search)) : group.mods}
          searching={search.length > 0}
          open={openServer === group.path}
          onToggle={() => setOpenServer((current) => (current === group.path ? null : group.path))}
          onRemove={() => setGroupToRemove(group)}
          onSaveAsModpack={() => exportModpack({ installedMods: group.mods, installation: { ...installation, name: `${installation.name} (${group.server})` } })}
          busy={removing === group.path}
        />
      ))}

      <RemoveServerModsDialog
        group={groupToRemove}
        close={() => setGroupToRemove(null)}
        onConfirm={async () => {
          const group = groupToRemove
          setGroupToRemove(null)
          if (group) await remove(group)
        }}
      />
    </>
  )
}

export default ServerModsSection
