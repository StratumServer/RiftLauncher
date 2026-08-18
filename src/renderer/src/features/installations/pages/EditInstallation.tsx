import { useEffect, useState, useRef } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { Button } from "@headlessui/react"
import { PiFloppyDiskBackDuotone, PiXCircleDuotone } from "react-icons/pi"

import { validateInstallationFields } from "@domain/installations/create"
import { INSTALLATION_ICONS } from "@renderer/utils/installationIcons"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useInstallations, useGameVersions, useCustomIcons, useConfigDispatch, useSettingsConfig, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { describeInstallationFieldsFailure } from "@renderer/features/installations/adapters/create"
import { useOpenExternalLink } from "@renderer/features/installations/hooks/useOpenExternalLink"
import { useLogMessage } from "@renderer/features/installations/hooks/useLogMessage"
import { useInstallationFormFields } from "@renderer/features/installations/hooks/useInstallationFormFields"
import { NameAndIconPicker } from "@renderer/features/installations/components/NameAndIconPicker"
import { GameVersionPicker } from "@renderer/features/installations/components/GameVersionPicker"
import { BackupsSettingsSection } from "@renderer/features/installations/components/BackupsSettingsSection"
import { AdvancedSettingsSection } from "@renderer/features/installations/components/AdvancedSettingsSection"

import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

import { ButtonsWrapper, FormLinkButton, FormGroupWrapper, FormButton, FromWrapper } from "@renderer/components/ui/FormComponents"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"

const LOG_TAG = "[front] [installations] [features/installations/pages/EditInstallation.tsx]"

function EditInslallation(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const installations = useInstallations()
  const gameVersions = useGameVersions()
  const customIcons = useCustomIcons()
  const configDispatch = useConfigDispatch()
  const navigate = useNavigate()
  const openExternalLink = useOpenExternalLink()
  const logMessage = useLogMessage()
  const { schemaVersion } = useSettingsConfig()
  const isConfigLoaded = schemaVersion !== 0

  const { id } = useParams()

  const [installation, setInstallation] = useState<InstallationType | undefined>(installations.find((igv) => igv.id === id))

  const fields = useInstallationFormFields({
    icon: INSTALLATION_ICONS[0],
    name: "",
    // Starts empty on purpose: the only version this form may show is the one the
    // Installation actually points at, filled in by the effect below (#118).
    version: undefined,
    startParams: "",
    backupsLimit: 0,
    backupsAuto: false,
    compressionLevel: 6,
    mesaGlThread: false,
    envVars: ""
  })

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Depends on the loaded state too: on a cold mount whose config arrives after the first render,
  // `id` never changes, so a dependency list of just `[id]` never re-runs this lookup and the page
  // is stuck reporting "Installation not found!" even once the config lands (#58).
  useEffect(() => {
    setInstallation(installations.find((igv) => igv.id === id))
  }, [id, isConfigLoaded])

  useEffect(() => {
    fields.setIcon(INSTALLATION_ICONS.find((ii) => ii.id === installation?.icon) ?? customIcons.find((ii) => ii.id === installation?.icon) ?? INSTALLATION_ICONS[0])
    fields.setName(installation?.name ?? "")
    // No fallback: an Installation whose VS Version was uninstalled leaves the picker
    // empty rather than silently adopting whatever happens to be first in the config's
    // list, which used to get written to disk on the next save (#118).
    fields.setVersion(gameVersions.find((gv) => gv.version === installation?.version))
    fields.setStartParams(installation?.startParams ?? "")
    fields.setBackupsLimit(installation?.backupsLimit ?? 0)
    fields.setBackupsAuto(installation?.backupsAuto ?? false)
    fields.setCompressionLevel(installation?.compressionLevel ?? 6)
    fields.setMesaGlThread(installation?.mesaGlThread ?? false)
    fields.setEnvVars(installation?.envVars ?? "")
  }, [installation])

  // The Installation's own version when the launcher no longer has it installed. Read
  // from the Installation, not from the picker: it stays true (and worth showing) after
  // the player has picked a replacement, until the edit is actually saved. "" is a real
  // value here, not a bug: configManager normalizes a missing or invalid version to the
  // empty string and keeps the Installation, and gameVersions can never hold an entry with
  // an empty version, so the empty case always falls through to the warning too (#118).
  const missingGameVersion: string | undefined = installation && !gameVersions.some((gv) => gv.version === installation.version) ? installation.version : undefined

  const handleEditInstallation = async (): Promise<void> => {
    if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")
    if (installation._backuping) return addNotification(t("features.backups.backupInProgress"), "error")
    if (installation._playing) return addNotification(t("features.installations.editWhilePlaying"), "error")
    if (installation._restoringBackup) return addNotification(t("features.backups.restoreInProgress"), "error")

    if (!id || !fields.name || !fields.backupsLimit || fields.backupsAuto === undefined) return addNotification(t("notifications.body.missingFields"), "error")

    const result = validateInstallationFields({ name: fields.name, startParams: fields.startParams })
    if (!result.ok) {
      const { messageKey } = describeInstallationFieldsFailure(result.reason)
      return addNotification(t(messageKey, { min: 5, max: 50 }), "error")
    }

    try {
      // version is only sent when the picker has a selection. EDIT_INSTALLATION takes Partial
      // updates (configReducer.ts), so leaving the key out keeps whatever the Installation already
      // points at, orphaned or unset, instead of reassigning it, while every other field on the
      // form still saves the way it did before this fix (#118).
      const updates: Partial<Omit<InstallationType, "id">> = {
        name: fields.name,
        icon: fields.icon.id,
        startParams: fields.startParams,
        backupsAuto: fields.backupsAuto,
        backupsLimit: fields.backupsLimit,
        compressionLevel: fields.compressionLevel,
        mesaGlThread: fields.mesaGlThread,
        envVars: fields.envVars
      }
      if (fields.version) updates.version = fields.version.version

      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id, updates } })
      addNotification(t("features.installations.installationSuccessfullyEdited"), "success")
      // The banner is gone once the page unmounts, so the toast is the only thing left telling
      // the player the version is still unresolved after an otherwise successful save.
      if (!fields.version) addNotification(t("features.versions.versionLeftUnchanged"), "warning")
      navigate("/installations")
    } catch (error) {
      logMessage("error", `${LOG_TAG} [handleEditInstallation] Error editing an Installation.`)
      logMessage("debug", `${LOG_TAG} [handleEditInstallation] Error editing the Installation ${id}: ${error}.`)
      addNotification(t("features.installations.errorEditingInstallation"), "error")
    }
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/installations" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.installations"), to: "/installations" },
                { name: t("breadcrumbs.editInstallation"), to: installation ? `/installations/edit/${installation.id}` : "/installations" }
              ]}
            />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <FromWrapper className="max-w-[50rem] w-full my-auto">
          {!installation ? (
            <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
              <p className="text-2xl">{t("features.installations.noInstallationFound")}</p>
              <p className="w-full flex gap-1 items-center justify-center">{t("features.installations.noInstallationFoundDesc")}</p>
            </div>
          ) : (
            <>
              <FormGroupWrapper title={t("generic.basics")}>
                <NameAndIconPicker
                  name={fields.name}
                  onNameChange={fields.setName}
                  icon={fields.icon}
                  onIconChange={fields.setIcon}
                  customIcons={customIcons}
                  iconButtonClassName="w-1/3 h-13 p-1 pr-2 flex items-center justify-between gap-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none text-sm text-start cursor-pointer"
                />

                <GameVersionPicker gameVersions={gameVersions} version={fields.version} onSelect={fields.setVersion} missingVersion={missingGameVersion} />
              </FormGroupWrapper>

              <BackupsSettingsSection
                backupsLimit={fields.backupsLimit}
                onBackupsLimitChange={fields.setBackupsLimit}
                backupsAuto={fields.backupsAuto}
                onBackupsAutoChange={fields.setBackupsAuto}
                compressionLevel={fields.compressionLevel}
                onCompressionLevelChange={fields.setCompressionLevel}
              />

              <AdvancedSettingsSection
                startParams={fields.startParams}
                onStartParamsChange={fields.setStartParams}
                startParamsLink={
                  <Button onClick={() => openExternalLink("https://wiki.vintagestory.at/Client_startup_parameters")} className="text-vsl">
                    {t("features.installations.startParamsLink")}
                  </Button>
                }
                mesaGlThread={fields.mesaGlThread}
                onMesaGlThreadChange={fields.setMesaGlThread}
                envVars={fields.envVars}
                onEnvVarsChange={fields.setEnvVars}
              />

              <ButtonsWrapper className="text-lg">
                <FormLinkButton to="/installations" title={t("generic.goBack")} type="error" className="p-2">
                  <PiXCircleDuotone />
                </FormLinkButton>
                <FormButton onClick={handleEditInstallation} title={t("generic.save")} type="success" className="p-2">
                  <PiFloppyDiskBackDuotone />
                </FormButton>
              </ButtonsWrapper>
            </>
          )}
        </FromWrapper>
      </div>
    </ScrollableContainer>
  )
}

export default EditInslallation
