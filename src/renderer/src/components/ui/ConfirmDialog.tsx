import { useTranslation } from "react-i18next"
import { PiXCircleDuotone } from "react-icons/pi"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"
import type { ButtonVariant } from "@renderer/components/ui/buttonStyles"

/**
 * The launcher's one "are you sure?" shell: a question, what it costs, and two actions.
 *
 * Cancel comes first in the DOM on purpose, and every caller now gets that order for free. Headless
 * UI's focus trap focuses the first focusable child of the panel, so a player who hits Enter on a
 * prompt they were not expecting backs out instead of confirming.
 *
 * It owns no copy but the Cancel button: every other string reads off whatever the player picked.
 */
function ConfirmDialog({
  title,
  isOpen,
  close,
  question,
  consequence,
  confirmLabel,
  confirmIcon,
  confirmVariant = "destructive",
  onConfirm,
  children,
  beforeActions
}: Readonly<{
  title: string
  isOpen: boolean
  close: () => void
  /** Left out by a prompt whose subject is a block of its own, passed as `children`. */
  question?: string
  /** What confirming costs, in the muted colour tests/text-contrast.test.ts measures. */
  consequence?: string
  confirmLabel: string
  confirmIcon: React.ReactNode
  /** Destructive unless confirming gives something back, as restoring a version does. */
  confirmVariant?: ButtonVariant
  onConfirm: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>
  /** Detail between the question and the consequence: the names about to go, a warning box. */
  children?: React.ReactNode
  /** A choice the player makes before confirming, shown just above the buttons. */
  beforeActions?: React.ReactNode
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <PopupDialogPanel title={title} isOpen={isOpen} close={close}>
      <>
        {question !== undefined && <p>{question}</p>}
        {children}
        {consequence !== undefined && <p className="text-zinc-400">{consequence}</p>}
        {beforeActions}
        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("generic.cancel")} onClick={close} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
          <FormButton title={confirmLabel} onClick={onConfirm} variant={confirmVariant} size="md" icon={confirmIcon} />
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ConfirmDialog
