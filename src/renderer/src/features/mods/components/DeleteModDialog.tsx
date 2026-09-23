import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { PiTrashDuotone } from "react-icons/pi"

import ConfirmDialog from "@renderer/components/ui/ConfirmDialog"

/**
 * Calls `onGone` once it has left the page. The timer puts the call after the microtask in which the
 * dialog, leaving along with it, hands focus back to whatever opened it.
 */
function OnGone({ onGone }: Readonly<{ onGone: () => void }>): null {
  const latest = useRef(onGone)
  useEffect(() => {
    latest.current = onGone
  })
  useEffect(() => {
    return (): void => {
      setTimeout(() => latest.current())
    }
  }, [])
  return null
}

/**
 * Asks before Mod archives are deleted. Nothing is deleted until Delete is pressed.
 *
 * With `names`, it is asking about several Mods at once, and it names every one of them before
 * anything happens, because the player picked them from a list they may have scrolled past.
 * `onClosed` runs once the dialog has left the screen and handed focus back.
 */
function DeleteModDialog({
  isOpen,
  close,
  onConfirm,
  names,
  onClosed
}: Readonly<{ isOpen: boolean; close: () => void; onConfirm: () => Promise<void>; names?: readonly string[]; onClosed?: () => void }>): JSX.Element {
  const { t } = useTranslation()
  const sortedNames = names && [...names].sort((a, b) => a.localeCompare(b))

  return (
    <ConfirmDialog
      title={sortedNames ? t("features.mods.deleteSelectedTitle", { count: sortedNames.length }) : t("features.mods.deleteMod")}
      isOpen={isOpen}
      close={close}
      question={sortedNames ? t("features.mods.areYouSureDeleteSelected", { count: sortedNames.length }) : t("features.mods.areYouSureDelete")}
      consequence={t("features.mods.deletingNotReversible")}
      confirmLabel={t("generic.delete")}
      confirmIcon={<PiTrashDuotone />}
      onConfirm={onConfirm}
    >
      {sortedNames && (
        <ul className="max-h-48 overflow-y-auto text-left px-2">
          {sortedNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {onClosed && <OnGone onGone={onClosed} />}
    </ConfirmDialog>
  )
}

export default DeleteModDialog
