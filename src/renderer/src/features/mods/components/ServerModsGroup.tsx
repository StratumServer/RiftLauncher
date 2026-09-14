import { useTranslation } from "react-i18next"
import { PiBoxArrowUpDuotone, PiCaretDownDuotone, PiCaretRightDuotone, PiTrashDuotone } from "react-icons/pi"

import { ListGroup, ListWrapper } from "@renderer/components/ui/List"
import { FormButton } from "@renderer/components/ui/FormComponents"
import ServerModItem from "@renderer/features/mods/components/ServerModItem"

/**
 * One server's downloaded Mods: a header saying which server and how many, the sentence that
 * answers "why do I have these", the two things the player can do with the set, and the rows once
 * the group is open.
 *
 * Collapsed on arrival and every time the page is opened. These are not the Mods the player came to
 * manage; they are the ones they did not know they had, and one line per server is the whole point.
 *
 * @param mods The rows to show, already narrowed by the page's search field.
 */
function ServerModsGroup({
  group,
  mods,
  open,
  onToggle,
  onRemove,
  onSaveAsModpack,
  busy = false
}: Readonly<{
  group: ServerModGroupType
  mods: InstalledModType[]
  open: boolean
  onToggle: () => void
  onRemove: () => void
  onSaveAsModpack: () => void
  /** A removal of this folder is in flight. */
  busy?: boolean
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <ListWrapper className="w-full">
      <ListGroup>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 items-center justify-between flex-wrap">
            <FormButton title={t("features.mods.serverModsGroupToggle")} variant="ghost" className="min-w-0 grow p-1 justify-start" onClick={onToggle} ariaExpanded={open} disabled={busy}>
              <span aria-hidden="true" className="shrink-0 flex items-center">
                {open ? <PiCaretDownDuotone className="text-xl" /> : <PiCaretRightDuotone className="text-xl" />}
              </span>
              <span className="min-w-0 truncate font-bold">{t("features.mods.serverModsGroupTitle", { server: group.server, interpolation: { escapeValue: false } })}</span>
              <span className="shrink-0 text-zinc-300">{t("features.mods.serverModsCount", { count: group.mods.length })}</span>
            </FormButton>

            <div className="shrink-0 flex gap-1 items-center">
              <FormButton title={t("features.mods.serverModsSaveAsModpack")} variant="secondary" className="p-1 w-fit h-8" onClick={onSaveAsModpack} disabled={busy || group.mods.length === 0}>
                <PiBoxArrowUpDuotone className="text-xl" />
                <p>{t("features.mods.serverModsSaveAsModpackButton")}</p>
              </FormButton>

              <FormButton title={t("features.mods.serverModsRemove")} variant="destructive" className="p-1 w-fit h-8" onClick={onRemove} busy={busy}>
                <PiTrashDuotone className="text-xl" />
                <p>{t("features.mods.serverModsRemoveButton")}</p>
              </FormButton>
            </div>
          </div>

          {/* The sentence is the feature: it answers the disk-space question and the "I never
              installed this" question at once, so it stays visible whether the group is open or not. */}
          <p className="text-zinc-400 text-sm">{t("features.mods.serverModsExplanation")}</p>

          {group.unreadable > 0 && <p className="text-zinc-400 text-sm">{t("features.mods.serverModsUnreadable", { count: group.unreadable })}</p>}
        </div>

        {open && mods.map((iMod) => <ServerModItem key={iMod.modid + iMod.path} iMod={iMod} />)}
      </ListGroup>
    </ListWrapper>
  )
}

export default ServerModsGroup
