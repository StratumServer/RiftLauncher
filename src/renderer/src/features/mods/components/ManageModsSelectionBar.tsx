import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { PiMoonDuotone, PiSunDuotone, PiToggleLeftDuotone, PiToggleRightDuotone, PiTrashDuotone } from "react-icons/pi"

import type { ModBatchActions } from "@renderer/features/mods/hooks/useModBatchActions"

import DeleteModDialog from "@renderer/features/mods/components/DeleteModDialog"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { StickyMenuGroupWrapper, StickyMenuGroup } from "@renderer/components/ui/StickyMenu"

/**
 * The selection's own bar: a tri-state "every Mod shown" box, the count, and the five batch actions.
 *
 * @param batch The page's selection and what it can do.
 * @param shownCount How many Mods the search and filters leave on screen.
 * @param locked A single row's action is in flight, so the whole bar waits for it.
 */
function ManageModsSelectionBar({ batch, shownCount, locked }: Readonly<{ batch: ModBatchActions; shownCount: number; locked: boolean }>): JSX.Element {
  const { t } = useTranslation()

  const selectAllRef = useRef<HTMLInputElement>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const count = batch.selected.length
  const allShownChecked = shownCount > 0 && count === shownCount
  const disabled = locked || batch.running

  // "Some but not all" has no attribute, only a DOM property, so it is set once the render is in.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = count > 0 && !allShownChecked
  }, [count, allShownChecked])

  // When a batch lands, the button that started it has just become disabled, or its row is gone. The
  // select-all box is the one control certain to be there and live, once the render that re-enables
  // it is in.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !batch.running) selectAllRef.current?.focus()
    wasRunning.current = batch.running
  }, [batch.running])

  // A confirmed Delete that leaves failures leaves its button live, and the dialog hands focus back to
  // it as it goes. Once the dialog is gone, the focus is moved on to select-all like after any batch.
  const deleteConfirmed = useRef(false)

  function suspendOrResume(action: () => void): void {
    action()
    selectAllRef.current?.focus()
  }

  return (
    <>
      <StickyMenuGroupWrapper type="centered">
        <StickyMenuGroup>
          <label className="flex items-center gap-2 cursor-pointer">
            <Input ref={selectAllRef} type="checkbox" checked={allShownChecked} disabled={disabled} onChange={batch.toggleAllShown} className="cursor-pointer" />
            <span>{t("features.mods.selectAllShown")}</span>
          </label>
          <p role="status">{t("features.mods.selectedCount", { count })}</p>
        </StickyMenuGroup>

        <StickyMenuGroup>
          <FormButton title={t("features.mods.batchEnableTitle")} variant="secondary" className="p-1 w-fit h-8" disabled={disabled || !batch.canEnable} onClick={batch.enable}>
            <PiToggleRightDuotone className="text-xl" />
            <p>{t("features.mods.batchEnable")}</p>
          </FormButton>

          <FormButton title={t("features.mods.batchDisableTitle")} variant="secondary" className="p-1 w-fit h-8" disabled={disabled || !batch.canDisable} onClick={batch.disable}>
            <PiToggleLeftDuotone className="text-xl" />
            <p>{t("features.mods.batchDisable")}</p>
          </FormButton>

          <FormButton
            title={t("features.mods.batchSuspendUpdatesTitle")}
            variant="secondary"
            className="p-1 w-fit h-8"
            disabled={disabled || !batch.canSuspend}
            onClick={() => suspendOrResume(batch.suspendUpdates)}
          >
            <PiMoonDuotone className="text-xl" />
            <p>{t("features.mods.batchSuspendUpdates")}</p>
          </FormButton>

          <FormButton
            title={t("features.mods.batchResumeUpdatesTitle")}
            variant="secondary"
            className="p-1 w-fit h-8"
            disabled={disabled || !batch.canResume}
            onClick={() => suspendOrResume(batch.resumeUpdates)}
          >
            <PiSunDuotone className="text-xl" />
            <p>{t("features.mods.batchResumeUpdates")}</p>
          </FormButton>

          <FormButton title={t("features.mods.batchDeleteTitle")} variant="destructive" className="p-1 w-fit h-8" disabled={disabled || count === 0} onClick={() => setConfirmingDelete(true)}>
            <PiTrashDuotone className="text-xl" />
            <p>{t("generic.delete")}</p>
          </FormButton>
        </StickyMenuGroup>
      </StickyMenuGroupWrapper>

      <DeleteModDialog
        isOpen={confirmingDelete}
        close={() => setConfirmingDelete(false)}
        names={batch.selected.map((iMod) => iMod.name)}
        onClosed={() => {
          if (!deleteConfirmed.current) return
          deleteConfirmed.current = false
          selectAllRef.current?.focus()
        }}
        onConfirm={async () => {
          deleteConfirmed.current = true
          setConfirmingDelete(false)
          await batch.remove()
        }}
      />
    </>
  )
}

export default ManageModsSelectionBar
