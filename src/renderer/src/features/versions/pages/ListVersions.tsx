import { useEffect, useId, useRef, useState } from "react"
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
import { toFolderPlatform, type FolderPlatform } from "@domain/paths"
import { isUpdateAvailable, supportsGameVersion } from "@domain/optimum/plan"
import { isInterruptedInstall } from "@domain/versions/interruptedInstall"
import { compareGameVersionsDesc } from "@renderer/utils/gameVersionOrder"
import { CONFIG_ACTIONS, useConfigDispatch, useGameVersions, useInstallations, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { findHeldManagedFolder } from "@renderer/features/installations/adapters/nesting"
import { useUninstallGameVersion } from "@renderer/features/versions/hooks/useUninstallGameVersion"
import { useOpenVersionFolder } from "@renderer/features/versions/hooks/useOpenVersionFolder"
import { summarizeUsedByInstallations } from "@renderer/features/versions/adapters/uninstall"
import { useBrokenOptimumVersions } from "@renderer/features/versions/hooks/useBrokenOptimumVersions"
import { useOptimumActions } from "@renderer/features/versions/hooks/useOptimumActions"
import { useOptimumBackups } from "@renderer/features/versions/hooks/useOptimumBackups"
import { useOptimumManifest } from "@renderer/features/versions/hooks/useOptimumManifest"

import { ListGroup, ListWrapper, ListItem } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import ConfirmDialog from "@renderer/components/ui/ConfirmDialog"
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
  const settings = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const uninstallVersion = useUninstallGameVersion()
  const openVersionFolder = useOpenVersionFolder()
  const optimum = useOptimumManifest()
  const optimumBackups = useOptimumBackups(gameVersions)
  const brokenOptimumVersions = useBrokenOptimumVersions(gameVersions, optimumBackups)
  const { applyOptimum, restoreVanilla } = useOptimumActions()

  const [versionToDelete, setVersionToDelete] = useState<GameVersionType | null>(null)
  const [versionInUseWarning, setVersionInUseWarning] = useState<VersionInUseWarning | null>(null)
  const [versionToRename, setVersionToRename] = useState<GameVersionType | null>(null)
  const [newLabel, setNewLabel] = useState<string>("")
  const [versionToRestore, setVersionToRestore] = useState<GameVersionType | null>(null)

  const renameFieldId = useId()
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const [platform, setPlatform] = useState<FolderPlatform>("posix")
  useEffect(() => {
    void window.api.utils.getOs().then((os) => setPlatform(toFolderPlatform(os)))
  }, [])

  /**
   * True when uninstalling this version leaves its folder where it is: it was registered, not
   * installed, or its folder holds Installations, other VS Versions or the folders the launcher is set
   * up on (#707). The host's deletion policy refuses exactly those, through the same comparison, so
   * the version only leaves the list instead of failing the same way on every retry.
   */
  function keepsFolder(version: GameVersionType | null | undefined): boolean {
    if (!version) return false
    if (version.linked === true) return true
    const otherVersions = gameVersions.filter((gameVersion) => gameVersion.id !== version.id)
    return findHeldManagedFolder(version, { settings, installations, gameVersions: otherVersions }, platform) !== null
  }

  /** The consequence line of the delete dialogs, true to what the uninstall does to this folder. */
  function consequenceFor(version: GameVersionType | null | undefined): string {
    if (version?.linked) return t("features.versions.unlinkingKeepsTheFolder")
    if (keepsFolder(version)) return t("features.versions.folderKeptItHoldsOthers", { folder: version?.path })
    return t("features.versions.uninstallingDeletesFolder", { folder: version?.path })
  }

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
   * What the published overlay is good for on this row, if anything.
   *
   * `add` for a plain build the overlay was published for, which is what makes
   * "you can try again from this page" true after a download that failed partway
   * through an install. `update` when the row already reads as Optimum and a
   * newer overlay still covers that game version: both halves matter, since a
   * newer Optimum that dropped 1.22.7 is not an update for a 1.22.7 build, it is
   * an overlay for a build nobody has here.
   */
  function optimumActionFor(version: GameVersionType): "add" | "update" | undefined {
    if (!optimum.manifest) return undefined
    if (!version.variant) return supportsGameVersion(optimum.manifest, version.version) ? "add" : undefined
    return isUpdateAvailable(version.variant.version, version.version, optimum.manifest) ? "update" : undefined
  }

  async function ApplyOptimumHandler(version: GameVersionType): Promise<void> {
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

    const result = await uninstallVersion(target, { usedByInstallations, keepFolder: keepsFolder(target) })

    if (!result.ok && result.reason === "version-in-use") setVersionInUseWarning({ version: target, usedByInstallations })
  }

  async function DeleteVersionAnywayHandler(): Promise<void> {
    if (versionInUseWarning === null) return

    const { version, usedByInstallations } = versionInUseWarning
    setVersionInUseWarning(null)

    await uninstallVersion(version, { usedByInstallations, confirmedInUse: true, keepFolder: keepsFolder(version) })
  }

  // Every installation on the refused version, the ones folded into "and N more" included: the verb and the
  // pronouns of the warning go by how many there are, not by how many names fit on the line.
  const inUseNames = versionInUseWarning?.usedByInstallations ?? []

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
              .map((gv) => {
                const optimumAction = optimumActionFor(gv)
                const isBrokenOptimum = brokenOptimumVersions.has(gv.id)
                // Everything that writes into the folder, or launches out of it,
                // is refused while the launcher is writing into it itself. An install that was cut off
                // refuses the same things except removal, which is the way out of it.
                const interrupted = isInterruptedInstall(gv)
                const busy = gv._installing === true

                return (
                  <ListItem key={gv.id}>
                    <div className="w-full h-8 flex gap-2 p-1 justify-between items-center">
                      <div className="w-full min-w-0 flex items-center justify-center gap-2 text-start font-bold pl-1">
                        <p className={isBrokenOptimum || interrupted ? "w-full min-w-0 truncate" : "w-full"}>{gv.label}</p>
                        {interrupted && (
                          <>
                            <span className="sr-only">{t("features.versions.installInterruptedDesc")}</span>
                            <span
                              className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-red-400"
                              title={t("features.versions.installInterruptedDesc")}
                            >
                              {t("features.versions.installInterrupted")}
                            </span>
                          </>
                        )}
                        {isBrokenOptimum && (
                          <>
                            <span className="sr-only">{t("features.versions.optimumMissingAssembliesDesc")}</span>
                            <span
                              className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-red-400"
                              title={t("features.versions.optimumMissingAssembliesDesc")}
                            >
                              {t("features.versions.optimumMissingAssemblies")}
                            </span>
                          </>
                        )}
                      </div>

                      <ThinSeparator />

                      <div className="shrink-0 w-fit flex gap-1 items-center text-lg">
                        {gv.linked && <PiLinkDuotone className="p-1" title={t("features.versions.linkedVersion")} />}
                        {optimumAction && (
                          <NormalButton
                            className="p-1"
                            title={t(optimumAction === "add" ? "features.versions.addOptimum" : "features.versions.updateOptimumTo", { version: optimum.manifest?.optimumVersion ?? "" })}
                            variant="ghost"
                            disabled={busy || interrupted}
                            onClick={() => ApplyOptimumHandler(gv)}
                          >
                            <PiArrowCircleUpDuotone />
                          </NormalButton>
                        )}
                        {(gv.variant || optimumBackups.has(gv.id)) && (
                          <NormalButton className="p-1" title={t("features.versions.restoreVanilla")} variant="ghost" disabled={busy || interrupted} onClick={() => setVersionToRestore(gv)}>
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
                          title={keepsFolder(gv) ? t("features.versions.removeFromList") : t("features.versions.deleteVersion")}
                          variant="ghost"
                          disabled={busy}
                          onClick={async () => {
                            setVersionToDelete(gv)
                          }}
                        >
                          <PiTrashDuotone />
                        </NormalButton>
                      </div>
                    </div>
                  </ListItem>
                )
              })}
          </ListGroup>
        </ListWrapper>

        <ConfirmDialog
          title={t(keepsFolder(versionToDelete) ? "features.versions.removeFromList" : "features.versions.uninstallVersion")}
          isOpen={versionToDelete !== null}
          close={() => setVersionToDelete(null)}
          question={t(keepsFolder(versionToDelete) ? "features.versions.areYouSureUnlink" : "features.versions.areYouSureUninstall", { version: versionToDelete?.label ?? versionToDelete?.version })}
          consequence={consequenceFor(versionToDelete)}
          confirmLabel={t(keepsFolder(versionToDelete) ? "features.versions.removeFromList" : "generic.uninstall")}
          confirmIcon={<PiTrashDuotone />}
          onConfirm={DeleteVersionHandler}
        />

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

        <ConfirmDialog
          title={t("features.versions.restoreVanilla")}
          isOpen={versionToRestore !== null}
          close={() => setVersionToRestore(null)}
          question={t("features.versions.areYouSureRestoreVanilla", { version: versionToRestore?.label ?? versionToRestore?.version })}
          consequence={t("features.versions.restoreVanillaIsPartial")}
          confirmLabel={t("features.versions.restoreVanilla")}
          confirmIcon={<PiArrowUUpLeftDuotone />}
          confirmVariant="primary"
          onConfirm={RestoreVanillaHandler}
        />

        <ConfirmDialog
          title={t("features.versions.versionInUse")}
          isOpen={versionInUseWarning !== null}
          close={() => setVersionInUseWarning(null)}
          consequence={consequenceFor(versionInUseWarning?.version)}
          confirmLabel={t("features.versions.deleteAnyway")}
          confirmIcon={<PiTrashDuotone />}
          onConfirm={DeleteVersionAnywayHandler}
        >
          <div className="flex items-center justify-center gap-2 rounded-sm bg-orange-500/10 border border-orange-500/30 px-3 py-2 text-sm text-orange-300">
            <PiWarningDuotone className="text-lg shrink-0" />
            <span>{t("features.versions.versionInUseByInstallations", { installations: installationsInUseLabel(inUseNames), count: inUseNames.length })}</span>
          </div>
        </ConfirmDialog>
      </div>
    </ScrollableContainer>
  )
}

export default ListVersions
