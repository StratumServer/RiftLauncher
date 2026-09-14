import { useTranslation } from "react-i18next"
import { PiPlayCircleDuotone, PiXCircleDuotone } from "react-icons/pi"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { FormButton } from "@renderer/components/ui/FormComponents"

/**
 * #338's question, rendered wherever a launch can start: the main menu's Play button, and the
 * Join on a saved server's row. One component rather than one copy per launch surface, because
 * the dialog's button order is load-bearing (see below) and a second copy is where that gets lost.
 */
function LaunchBackupPrompt({ isOpen, answer }: Readonly<{ isOpen: boolean; answer: (launchAnyway: boolean) => void }>): JSX.Element {
  const { t } = useTranslation()

  return (
    // Cancel comes first in the DOM because HeadlessUI's focus trap focuses
    // the first focusable child, so Enter on a freshly opened prompt keeps
    // the launch stopped. The restore and delete confirms order themselves
    // the same way for the same reason.
    <PopupDialogPanel title={t("features.backups.backupFailedTitle")} isOpen={isOpen} close={() => answer(false)}>
      <>
        <p>{t("features.backups.backupFailedSkipLaunch")}</p>
        <div className="flex gap-4 items-center justify-center text-lg">
          <FormButton title={t("generic.cancel")} className="p-2" onClick={() => answer(false)} variant="secondary">
            <PiXCircleDuotone />
          </FormButton>
          <FormButton title={t("features.backups.launchAnyway")} className="p-2" onClick={() => answer(true)} variant="destructive">
            <PiPlayCircleDuotone />
          </FormButton>
        </div>
      </>
    </PopupDialogPanel>
  )
}

export default LaunchBackupPrompt
