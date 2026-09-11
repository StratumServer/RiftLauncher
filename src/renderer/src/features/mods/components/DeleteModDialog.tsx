import { useTranslation } from "react-i18next"
import { PiTrashDuotone, PiXCircleDuotone } from "react-icons/pi"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/**
 * Asks before Mod archives are deleted. Nothing is deleted until Delete is pressed.
 *
 * With `names`, it is asking about several Mods at once, and it names every one of them before
 * anything happens, because the player picked them from a list they may have scrolled past.
 */
function DeleteModDialog({ isOpen, close, onConfirm, names }: Readonly<{ isOpen: boolean; close: () => void; onConfirm: () => Promise<void>; names?: readonly string[] }>): JSX.Element {
  const { t } = useTranslation()
  const sortedNames = names && [...names].sort((a, b) => a.localeCompare(b))

  return (
    <PopupDialogPanel title={sortedNames ? t("features.mods.deleteSelectedTitle", { count: sortedNames.length }) : t("features.mods.deleteMod")} isOpen={isOpen} close={close}>
      <>
        <p>{sortedNames ? t("features.mods.areYouSureDeleteSelected") : t("features.mods.areYouSureDelete")}</p>
        {sortedNames && (
          <ul className="max-h-48 overflow-y-auto text-left px-2">
            {sortedNames.map((name, index) => (
              <li key={index}>{name}</li>
            ))}
          </ul>
        )}
        <p className="text-zinc-400">{t("features.mods.deletingNotReversible")}</p>
        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("generic.cancel")} onClick={close} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
          <FormButton title={t("generic.delete")} onClick={onConfirm} variant="destructive" size="md" icon={<PiTrashDuotone />} />
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default DeleteModDialog
