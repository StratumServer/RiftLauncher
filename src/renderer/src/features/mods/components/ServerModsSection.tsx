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
 */
function ServerModsSection({ installation, search }: Readonly<{ installation: InstallationType; search: string }>): JSX.Element | null {
  const { t } = useTranslation()
  const { groups, truncated, remove, removing } = useServerMods(installation)
  const exportModpack = useExportModpack()

  const [openServer, setOpenServer] = useState<string | null>(null)
  const [groupToRemove, setGroupToRemove] = useState<ServerModGroupType | null>(null)

  if (groups.length < 1) return null

  return (
    <>
      <div className="w-full flex flex-col gap-1">
        <h2 className="text-2xl text-center font-bold">{t("features.mods.serverModsTitle")}</h2>
        {truncated && (
          <p role="status" className="text-zinc-400 text-center text-sm">
            {t("features.mods.serverModsTruncated")}
          </p>
        )}
      </div>

      {groups.map((group) => (
        <ServerModsGroup
          key={group.path}
          group={group}
          mods={search ? group.mods.filter((iMod) => matchesModSearch(iMod, search)) : group.mods}
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
