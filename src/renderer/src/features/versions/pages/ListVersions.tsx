import { useId, useRef, useState } from "react"
import {
  PiFloppyDiskBackDuotone,
  PiFolderOpenDuotone,
  PiPlusCircleDuotone,
  PiTrashDuotone,
  PiMagnifyingGlassDuotone,
  PiPencilSimpleDuotone,
  PiXCircleDuotone,
  PiWarningDuotone,
  PiLinkDuotone,
  PiArrowCircleUpDuotone,
  PiArrowUUpLeftDuotone
} from "react-icons/pi"
import { useTranslation } from "react-i18next"

import { MAX_GAME_VERSION_LABEL_LENGTH } from "@domain/naming"
import { isUpdateAvailable } from "@domain/optimum/plan"
import { compareGameVersionsDesc } from "@renderer/utils/gameVersionOrder"
import { CONFIG_ACTIONS, useConfigDispatch, useGameVersions, useInstallations } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useUninstallGameVersion } from "@renderer/features/versions/hooks/useUninstallGameVersion"
import { useOpenVersionFolder } from "@renderer/features/versions/hooks/useOpenVersionFolder"
import { summarizeUsedByInstallations } from "@renderer/features/versions/adapters/uninstall"
import { useOptimumActions } from "@renderer/features/versions/hooks/useOptimumActions"
import { useOptimumManifest } from "@renderer/features/versions/hooks/useOptimumManifest"

import { ListGroup, ListWrapper, ListItem } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { LinkButton, NormalButton } from "@renderer/components/ui/Buttons"
import { ButtonsWrapper, FormButton, FormInputText } from "@renderer/components/ui/FormComponents"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

/** A version pending the "still in use" warning: the deletion was refused, this is what it would affect. */
interface VersionInUseWarning {
  version: GameVersionType
  usedByInstallations: string[]
}

function ListVersions(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const gameVersions = useGameVersions()
  const installations = useInstallations()
  const configDispatch = useConfigDispatch()
  const uninstallVersion = useUninstallGameVersion()
  const openVersionFolder = useOpenVersionFolder()
  const optimum = useOptimumManifest()
  const { applyOptimum, restoreVanilla } = useOptimumActions()

  const [versionToDelete, setVersionToDelete] = useState<GameVersionType | null>(null)
  const [versionInUseWarning, setVersionInUseWarning] = useState<VersionInUseWarning | null>(null)
  const [versionToRename, setVersionToRename] = useState<GameVersionType | null>(null)
  const [newLabel, setNewLabel] = useState<string>("")
  const [versionToRestore, setVersionToRestore] = useState<GameVersionType | null>(null)

  const renameFieldId = useId()
  const scrollRef = useRef<HTMLDivElement | null>(null)

  function installationsUsing(version: GameVersionType): string[] {
    return installations.filter((installation) => installation.gameVersionId === version.id).map((installation) => installation.name)
  }

  /** Composes the in-use warning's installation list, folding anything past the cap into a translated "N more" through t() instead of hardcoding it. */
  function installationsInUseLabel(names: string[]): string {
    const { shown, remaining } = summarizeUsedByInstallations(names)
    return remaining > 0 ? `${shown.join(", ")} ${t("features.versions.installationsAndMore", { count: remaining })}` : shown.join(", ")
  }

  /**
   * Writes the typed name onto the selected build.
   *
   * Only the label moves: the version number the compatibility checks read and
   * the folder the game runs from are both left alone. A name that is empty or
   * nothing but spaces falls back to the version number, the same rule
   * registering a build applies, so no row can end up with a blank name.
   *
   * Submitted rather than clicked, so the Enter key ends the rename the way it
   * ends the one in the mod profiles popup.
   */
  function RenameVersionHandler(event: React.FormEvent): void {
    event.preventDefault()
    if (versionToRename === null) return

    const label = newLabel.trim() || versionToRename.version
    configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: versionToRename.id, updates: { label } } })
    setVersionToRename(null)
    addNotification(t("features.versions.versionRenamed"), "success")
  }

  /**
   * Whether a newer overlay is published that still covers this row's game
   * version. Both halves matter: a newer Optimum that dropped 1.22.7 is not an
   * update for a 1.22.7 build, it is an overlay for a build nobody has here.
   */
  function optimumUpdateAvailable(version: GameVersionType): boolean {
    return version.variant !== undefined && optimum.manifest !== undefined && isUpdateAvailable(version.variant.version, version.version, optimum.manifest)
  }

  async function UpdateOptimumHandler(version: GameVersionType): Promise<void> {
    if (!optimum.manifest) return
    await applyOptimum({ id: version.id, path: version.path, version: version.version }, optimum.manifest)
  }

  async function RestoreVanillaHandler(): Promise<void> {
    if (versionToRestore === null) return

    const target = versionToRestore
    setVersionToRestore(null)
    await restoreVanilla({ id: target.id, path: target.path, version: target.version })
  }

  async function DeleteVersionHandler(): Promise<void> {
    if (versionToDelete === null) return addNotification(t("features.versions.noVersionSelected"), "error")

    const target = versionToDelete
    const usedByInstallations = installationsUsing(target)
    setVersionToDelete(null)

    const result = await uninstallVersion(target, { usedByInstallations })

    if (!result.ok && result.reason === "version-in-use") setVersionInUseWarning({ version: target, usedByInstallations })
  }

  async function DeleteVersionAnywayHandler(): Promise<void> {
    if (versionInUseWarning === null) return

    const { version, usedByInstallations } = versionInUseWarning
    setVersionInUseWarning(null)

    await uninstallVersion(version, { usedByInstallations, confirmedInUse: true })
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs breadcrumbs={[{ name: t("breadcrumbs.versions"), to: "/versions" }]} />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <ListWrapper className="max-w-[50rem] w-full my-auto">
          <ListGroup>
            <div className="flex gap-2">
              <ListItem className="group">
                <LinkButton
                  to="/versions/add"
                  title={t("features.versions.installNewVersion")}
                  icon={<PiPlusCircleDuotone className="duration-200 group-hover:scale-95" />}
                  variant="primary"
                  className="w-full h-8"
                />
              </ListItem>
              <ListItem className="group">
                <LinkButton
                  to="/versions/look-for-a-version"
                  title={t("features.versions.searchForAGameVersion")}
                  icon={<PiMagnifyingGlassDuotone className="duration-200 group-hover:scale-95" />}
                  variant="secondary"
                  className="w-full h-8"
                />
              </ListItem>
            </div>
            {gameVersions
              .slice()
              .sort((a, b) => compareGameVersionsDesc(a.version, b.version))
              .map((gv) => (
                <ListItem key={gv.id}>
                  <div className="w-full h-8 flex gap-2 p-1 justify-between items-center">
                    <div className="w-full flex items-center justify-center text-start font-bold pl-1">
                      <p className="w-full">{gv.label}</p>
                    </div>

                    <ThinSeparator />

                    <div className="shrink-0 w-fit flex gap-1 items-center text-lg">
                      {gv.linked && <PiLinkDuotone className="p-1" title={t("features.versions.linkedVersion")} />}
                      {optimumUpdateAvailable(gv) && (
                        <NormalButton
                          className="p-1"
                          title={t("features.versions.updateOptimumTo", { version: optimum.manifest?.optimumVersion ?? "" })}
                          variant="ghost"
                          onClick={() => UpdateOptimumHandler(gv)}
                        >
                          <PiArrowCircleUpDuotone />
                        </NormalButton>
                      )}
                      {gv.variant && (
                        <NormalButton className="p-1" title={t("features.versions.restoreVanilla")} variant="ghost" onClick={() => setVersionToRestore(gv)}>
                          <PiArrowUUpLeftDuotone />
                        </NormalButton>
                      )}
                      <NormalButton onClick={() => openVersionFolder(gv.path)} title={`${t("generic.openOnFileExplorer")} · ${gv.path}`} variant="ghost" className="p-1">
                        <PiFolderOpenDuotone />
                      </NormalButton>
                      <NormalButton
                        className="p-1"
                        title={t("features.versions.renameVersion")}
                        variant="ghost"
                        onClick={() => {
                          setNewLabel(gv.label)
                          setVersionToRename(gv)
                        }}
                      >
                        <PiPencilSimpleDuotone />
                      </NormalButton>
                      <NormalButton
                        className="p-1"
                        title={gv.linked ? t("features.versions.removeFromList") : t("features.versions.deleteVersion")}
                        variant="ghost"
                        onClick={async () => {
                          setVersionToDelete(gv)
                        }}
                      >
                        <PiTrashDuotone />
                      </NormalButton>
                    </div>
                  </div>
                </ListItem>
              ))}
          </ListGroup>
        </ListWrapper>

        <PopupDialogPanel
          title={t(versionToDelete?.linked ? "features.versions.removeFromList" : "features.versions.uninstallVersion")}
          isOpen={versionToDelete !== null}
          close={() => setVersionToDelete(null)}
        >
          <>
            <p>{t(versionToDelete?.linked ? "features.versions.areYouSureUnlink" : "features.versions.areYouSureUninstall", { version: versionToDelete?.label ?? versionToDelete?.version })}</p>
            <p className="text-zinc-400">{t(versionToDelete?.linked ? "features.versions.unlinkingKeepsTheFolder" : "features.versions.uninstallingNotReversible")}</p>
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={() => setVersionToDelete(null)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton
                title={t(versionToDelete?.linked ? "features.versions.removeFromList" : "generic.uninstall")}
                onClick={DeleteVersionHandler}
                variant="destructive"
                size="md"
                icon={<PiTrashDuotone />}
              />
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>

        <PopupDialogPanel title={t("features.versions.renameVersion")} isOpen={versionToRename !== null} close={() => setVersionToRename(null)}>
          <form className="flex flex-col gap-3" onSubmit={RenameVersionHandler}>
            <p className="text-zinc-400">{t("features.versions.renameVersionDesc")}</p>
            <label htmlFor={renameFieldId} className="sr-only">
              {t("generic.name")}
            </label>
            <FormInputText
              id={renameFieldId}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder={t("generic.name")}
              maxLength={MAX_GAME_VERSION_LABEL_LENGTH}
              autoFocus
              className="w-full"
            />
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={() => setVersionToRename(null)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton title={t("generic.save")} nativeType="submit" variant="primary" size="md" icon={<PiFloppyDiskBackDuotone />} />
            </ButtonsWrapper>
          </form>
        </PopupDialogPanel>

        <PopupDialogPanel title={t("features.versions.restoreVanilla")} isOpen={versionToRestore !== null} close={() => setVersionToRestore(null)}>
          <>
            <p>{t("features.versions.areYouSureRestoreVanilla", { version: versionToRestore?.label ?? versionToRestore?.version })}</p>
            <p className="text-zinc-400">{t("features.versions.restoreVanillaIsPartial")}</p>
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={() => setVersionToRestore(null)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton title={t("features.versions.restoreVanilla")} onClick={RestoreVanillaHandler} variant="primary" size="md" icon={<PiArrowUUpLeftDuotone />} />
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>

        <PopupDialogPanel title={t("features.versions.versionInUse")} isOpen={versionInUseWarning !== null} close={() => setVersionInUseWarning(null)}>
          <>
            <div className="flex items-center justify-center gap-2 rounded-sm bg-orange-500/10 border border-orange-500/30 px-3 py-2 text-sm text-orange-300">
              <PiWarningDuotone className="text-lg shrink-0" />
              <span>{t("features.versions.versionInUseByInstallations", { installations: installationsInUseLabel(versionInUseWarning?.usedByInstallations ?? []) })}</span>
            </div>
            <p className="text-zinc-400">{t(versionInUseWarning?.version.linked ? "features.versions.unlinkingKeepsTheFolder" : "features.versions.uninstallingNotReversible")}</p>
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={() => setVersionInUseWarning(null)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton title={t("features.versions.deleteAnyway")} onClick={DeleteVersionAnywayHandler} variant="destructive" size="md" icon={<PiTrashDuotone />} />
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>
      </div>
    </ScrollableContainer>
  )
}

export default ListVersions
