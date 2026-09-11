import { useTranslation } from "react-i18next"
import { PiTrashDuotone, PiXCircleDuotone } from "react-icons/pi"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/** Asks before a Mod archive is deleted. Nothing is deleted until Delete is pressed. */
function DeleteModDialog({ isOpen, close, onConfirm }: Readonly<{ isOpen: boolean; close: () => void; onConfirm: () => Promise<void> }>): JSX.Element {
  const { t } = useTranslation()

  return (
    <PopupDialogPanel title={t("features.mods.deleteMod")} isOpen={isOpen} close={close}>
      <>
        <p>{t("features.mods.areYouSureDelete")}</p>
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
