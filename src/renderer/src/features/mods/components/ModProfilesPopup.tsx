import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PiCopyDuotone, PiFloppyDiskDuotone, PiPencilDuotone, PiPlayDuotone, PiTrashDuotone, PiXCircleDuotone } from "react-icons/pi"

import type { ModProfiles } from "@renderer/features/mods/hooks/useModProfiles"
import { MAX_MOD_PROFILE_NAME_LENGTH, MAX_MOD_PROFILES } from "@domain/mods/profiles"
import type { ModProfileNameProblem } from "@domain/mods/profiles"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton, FormInputText } from "@renderer/components/ui/FormComponents"

const NAME_PROBLEM_KEYS: Record<ModProfileNameProblem, string> = {
  empty: "features.mods.profileNameEmpty",
  "too-long": "features.mods.profileNameTooLong",
  "control-character": "features.mods.profileNameControlCharacter",
  taken: "features.mods.profileNameTaken"
}

const STATUS_NOTICE_KEYS: Partial<Record<ModProfiles["status"], string>> = {
  "newer-format": "features.mods.profilesNewerFormat",
  unreadable: "features.mods.profilesUnreadable",
  unavailable: "features.mods.profilesUnavailable"
}

/**
 * The Profiles dialog: every profile of the Installation with Use, Rename, Duplicate and Delete, and
 * a field that saves the current Mods as a new one.
 *
 * @param profiles The Installation's profiles and what can be done with them.
 * @param locked A batch or a single Mod's rename is in flight, so a switch would race it on the same archives.
 */
function ModProfilesPopup({ isOpen, close, profiles, locked }: Readonly<{ isOpen: boolean; close: () => void; profiles: ModProfiles; locked: boolean }>): JSX.Element {
  const { t } = useTranslation()
  const newNameId = useId()

  const [newName, setNewName] = useState("")
  const [newNameProblem, setNewNameProblem] = useState<ModProfileNameProblem | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string; problem: ModProfileNameProblem | null } | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)

  const listRef = useRef<HTMLUListElement>(null)
  const newNameRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  const ready = profiles.status === "ready"
  const disabled = !ready || profiles.working
  const atCap = profiles.profiles.length >= MAX_MOD_PROFILES
  const notice = STATUS_NOTICE_KEYS[profiles.status]

  // Asking before a delete moves focus onto the question, so a keyboard lands on the answer.
  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.querySelector("button")?.focus()
  }, [confirmingDelete])

  // The row that held focus is gone after a delete, so focus goes back to the list, or to the field
  // when the list is gone too. Only once the render without that row is in.
  useEffect(() => {
    if (!deleted) return
    setDeleted(false)
    ;(listRef.current?.querySelector("button") ?? newNameRef.current?.querySelector("input"))?.focus()
  }, [deleted])

  // Closing drops a half-typed rename, a pending delete question and an unsaved name, so the next
  // open starts from the plain list. Escape and a click outside close through here too.
  function closeDialog(): void {
    setRenaming(null)
    setConfirmingDelete(null)
    setNewName("")
    setNewNameProblem(null)
    close()
  }

  function nameProblemMessage(problem: ModProfileNameProblem): string {
    return t(NAME_PROBLEM_KEYS[problem], { max: MAX_MOD_PROFILE_NAME_LENGTH })
  }

  async function submitNew(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const problem = await profiles.create(newName)
    setNewNameProblem(problem)
    if (!problem) setNewName("")
  }

  async function submitRename(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!renaming) return
    const problem = await profiles.rename(renaming.id, renaming.value)
    setRenaming(problem ? { ...renaming, problem } : null)
  }

  async function confirmDelete(id: string): Promise<void> {
    setConfirmingDelete(null)
    await profiles.remove(id)
    setDeleted(true)
  }

  function row(profile: ModProfile): JSX.Element {
    const active = profile.id === profiles.activeProfile?.id

    if (renaming?.id === profile.id) {
      const inputId = `${newNameId}-rename`
      return (
        <form className="flex flex-col gap-1" onSubmit={submitRename}>
          <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              {t("features.mods.profileNameLabel")}
            </label>
            <div className="grow">
              <FormInputText
                id={inputId}
                value={renaming.value}
                onChange={(e) => setRenaming({ ...renaming, value: e.target.value, problem: null })}
                maxLength={MAX_MOD_PROFILE_NAME_LENGTH * 2}
                autoFocus
                disabled={disabled}
                className="w-full h-8"
              />
            </div>
            <FormButton title={t("generic.save")} nativeType="submit" variant="primary" className="w-8 h-8" disabled={disabled}>
              <PiFloppyDiskDuotone />
            </FormButton>
            <FormButton title={t("generic.cancel")} variant="secondary" className="w-8 h-8" onClick={() => setRenaming(null)}>
              <PiXCircleDuotone />
            </FormButton>
          </div>
          {renaming.problem && <p role="alert">{nameProblemMessage(renaming.problem)}</p>}
        </form>
      )
    }

    if (confirmingDelete === profile.id) {
      return (
        <div ref={confirmRef} className="flex flex-col gap-2">
          <p>
            <span className="font-bold">{profile.name}</span>: {t("features.mods.confirmDeleteProfile")}
          </p>
          <div className="flex items-center gap-2">
            <FormButton title={t("generic.cancel")} variant="secondary" className="p-1 w-fit h-8" onClick={() => setConfirmingDelete(null)}>
              <PiXCircleDuotone className="text-xl" />
              <p>{t("generic.cancel")}</p>
            </FormButton>
            <FormButton title={t("generic.delete")} variant="destructive" className="p-1 w-fit h-8" disabled={disabled} onClick={() => confirmDelete(profile.id)}>
              <PiTrashDuotone className="text-xl" />
              <p>{t("generic.delete")}</p>
            </FormButton>
          </div>
        </div>
      )
    }

    return (
      <div className="flex items-center gap-2">
        <span className="grow min-w-0 truncate">{profile.name}</span>
        <FormButton
          title={t("features.mods.useProfileTitle")}
          variant={active ? "primary" : "secondary"}
          className="p-1 w-fit h-8"
          ariaPressed={active}
          busy={profiles.switchingTo === profile.id}
          disabled={disabled || locked}
          onClick={() => profiles.switchTo(profile.id)}
        >
          <PiPlayDuotone className="text-xl" />
          <p>{t("features.mods.useProfile")}</p>
        </FormButton>
        <FormButton
          title={t("features.mods.renameProfileTitle")}
          variant="ghost"
          className="w-8 h-8"
          disabled={disabled}
          onClick={() => setRenaming({ id: profile.id, value: profile.name, problem: null })}
        >
          <PiPencilDuotone />
        </FormButton>
        <FormButton title={t("features.mods.duplicateProfileTitle")} variant="ghost" className="w-8 h-8" disabled={disabled || atCap} onClick={() => profiles.duplicate(profile.id)}>
          <PiCopyDuotone />
        </FormButton>
        <FormButton title={t("features.mods.deleteProfileTitle")} variant="ghost" className="w-8 h-8" disabled={disabled} onClick={() => setConfirmingDelete(profile.id)}>
          <PiTrashDuotone />
        </FormButton>
      </div>
    )
  }

  return (
    <PopupDialogPanel title={t("features.mods.profilesTitle")} isOpen={isOpen} close={closeDialog}>
      <>
        <p>{t("features.mods.profilesIntro")}</p>

        {notice && <p role="status">{t(notice)}</p>}

        {ready && profiles.profiles.length === 0 && <p>{t("features.mods.profilesFirstHint")}</p>}
        {ready && profiles.profiles.length > 0 && !profiles.activeProfile && <p role="status">{t("features.mods.noProfileActive")}</p>}

        {profiles.profiles.length > 0 && (
          <ul ref={listRef} className="flex flex-col gap-2 max-h-72 overflow-y-auto text-left px-1">
            {profiles.profiles.map((profile) => (
              <li key={profile.id}>{row(profile)}</li>
            ))}
          </ul>
        )}

        <form className="flex flex-col gap-1 text-left" onSubmit={submitNew}>
          <label htmlFor={newNameId}>{t("features.mods.newProfileLabel")}</label>
          <div ref={newNameRef} className="flex items-center gap-2">
            <div className="grow">
              <FormInputText
                id={newNameId}
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value)
                  setNewNameProblem(null)
                }}
                maxLength={MAX_MOD_PROFILE_NAME_LENGTH * 2}
                disabled={disabled || atCap}
                className="w-full h-8"
              />
            </div>
            <FormButton title={t("features.mods.newProfileButtonTitle")} nativeType="submit" variant="primary" className="p-1 w-fit h-8" disabled={disabled || atCap}>
              <PiFloppyDiskDuotone className="text-xl" />
              <p>{t("features.mods.newProfileButton")}</p>
            </FormButton>
          </div>
          {newNameProblem && <p role="alert">{nameProblemMessage(newNameProblem)}</p>}
          {ready && atCap && <p>{t("features.mods.profileCapReached", { max: MAX_MOD_PROFILES })}</p>}
        </form>

        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("features.mods.profilesClose")} variant="secondary" size="md" onClick={closeDialog}>
            <PiXCircleDuotone className="text-xl" />
            <p>{t("features.mods.profilesClose")}</p>
          </FormButton>
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ModProfilesPopup
