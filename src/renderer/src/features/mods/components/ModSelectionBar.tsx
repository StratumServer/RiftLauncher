import { useTranslation } from "react-i18next"

import { MAX_MOD_SELECTION } from "@domain/mods/modSelection"
import { FormButton } from "@renderer/components/ui/FormComponents"

/**
 * The browse page's selection bar: how many Mods are picked, and what to do with them.
 *
 * The count includes picks the current filter hides, since the install table names every one of
 * them before anything happens. It sits in a status region, with the cap note, so a screen reader
 * hears both as they change.
 */
function ModSelectionBar({
  count,
  canInstall,
  onPickVisible,
  onClear,
  onInstall
}: Readonly<{
  count: number
  /** False with no Installation selected. */
  canInstall: boolean
  onPickVisible: () => void
  onClear: () => void
  onInstall: () => void | Promise<void>
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
      <div role="status" className="flex flex-col items-center">
        <span>{t("features.mods.pickedCount", { count })}</span>
        {count >= MAX_MOD_SELECTION && <span className="text-zinc-400">{t("features.mods.pickLimit", { max: MAX_MOD_SELECTION })}</span>}
      </div>
      <FormButton title={t("features.mods.pickVisible")} variant="ghost" className="px-2" onClick={onPickVisible}>
        {t("features.mods.pickVisible")}
      </FormButton>
      <FormButton title={t("features.mods.clearPicks")} variant="ghost" className="px-2" onClick={onClear}>
        {t("features.mods.clearPicks")}
      </FormButton>
      <FormButton title={t("features.mods.installPicked")} variant="primary" className="px-2" disabled={count < 1 || !canInstall} onClick={onInstall}>
        {t("features.mods.installPicked")}
      </FormButton>
    </div>
  )
}

export default ModSelectionBar
