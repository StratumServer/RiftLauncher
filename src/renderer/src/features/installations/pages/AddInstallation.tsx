import { useRef } from "react"
import { useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { PiFloppyDiskBackDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"

import { createInstallation, INSTALLATION_NAME_MAX_LENGTH, INSTALLATION_NAME_MIN_LENGTH } from "@domain/installations/create"
import { DEFAULT_COMPRESSION_LEVEL } from "@domain/config/defaults"
import { compareGameVersionsDesc } from "@renderer/utils/gameVersionOrder"
import { INSTALLATION_ICONS } from "@renderer/utils/installationIcons"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useInstallations, useGameVersions, useCustomIcons, useSettingsConfig, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { createCreateInstallationPorts, describeCreateInstallationFailure, toFoldersInUse, toInstallationType } from "@renderer/features/installations/adapters/create"
import { useEnsurePathExists } from "@renderer/features/installations/hooks/usePathActions"
import { useInstallationFolder } from "@renderer/features/installations/hooks/useInstallationFolder"
import { useExternalLinks } from "@renderer/hooks/useExternalLinks"
import { useInstallationFormFields } from "@renderer/features/installations/hooks/useInstallationFormFields"
import { NameAndIconPicker } from "@renderer/features/installations/components/NameAndIconPicker"
import { GameVersionPicker } from "@renderer/features/installations/components/GameVersionPicker"
import { BackupsSettingsSection } from "@renderer/features/installations/components/BackupsSettingsSection"
import { AdvancedSettingsSection } from "@renderer/features/installations/components/AdvancedSettingsSection"

import {
  FormBody,
  FormHead,
  FormLabel,
  FromGroup,
  FromWrapper,
  ButtonsWrapper,
  FormFieldGroup,
  FormButton,
  FormLinkButton,
  FormInputText,
  FormGroupWrapper
} from "@renderer/components/ui/FormComponents"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

const LOG_TAG = "[front] [installations] [features/installations/pages/AddInstallation.tsx]"

function AddInslallation(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const installations = useInstallations()
  const gameVersions = useGameVersions()
  const customIcons = useCustomIcons()
  const settings = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const navigate = useNavigate()
  const ensurePathExists = useEnsurePathExists()
  const { openOnBrowser: openExternalLink } = useExternalLinks()

  const fields = useInstallationFormFields({
    icon: INSTALLATION_ICONS[0],
    name: t("features.installations.defaultName"),
    version: [...gameVersions].sort((a, b) => compareGameVersionsDesc(a.version, b.version))[0],
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: DEFAULT_COMPRESSION_LEVEL,
    mesaGlThread: false,
    envVars: "",
    launchWrapper: ""
  })

  const { folder: path, setFolder: setPath, browseFolder } = useInstallationFolder(fields.name, settings.defaultInstallationsFolder)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  const handleAddInstallation = async (): Promise<void> => {
    if (!fields.name || !path || !fields.version || !fields.backupsLimit || fields.backupsAuto === undefined) return addNotification(t("notifications.body.missingFields"), "error")

    const result = createInstallation(createCreateInstallationPorts(), {
      name: fields.name,
      icon: fields.icon.id,
      path,
      version: fields.version.version,
      startParams: fields.startParams,
      backupsLimit: fields.backupsLimit,
      backupsAuto: fields.backupsAuto,
      compressionLevel: fields.compressionLevel,
      mesaGlThread: fields.mesaGlThread,
      envVars: fields.envVars,
      launchWrapper: fields.launchWrapper.trim(),
      foldersInUse: toFoldersInUse({ backupsFolder: settings.backupsFolder, installations, gameVersions })
    })

    if (!result.ok) {
      const { messageKey } = describeCreateInstallationFailure(result.reason)
      return addNotification(t(messageKey, { min: INSTALLATION_NAME_MIN_LENGTH, max: INSTALLATION_NAME_MAX_LENGTH }), "error")
    }

    try {
      // Awaited and checked on purpose: a folder that can't be created (permissions, bad
      // path) must block the add, not just log a rejection nobody catches. Adding the
      // Installation to the list before the folder exists would leave a dangling entry
      // with no data behind it.
      if (!(await ensurePathExists(path))) {
        addNotification(t("notifications.body.installationFolderCreateFailed"), "error")
        return
      }

      configDispatch({ type: CONFIG_ACTIONS.ADD_INSTALLATION, payload: toInstallationType(result.installation) })
      addNotification(t("features.installations.installationSuccessfullyAdded"), "success")
      navigate("/installations")
    } catch (error) {
      window.api.utils.logMessage("error", `${LOG_TAG} [handleAddInstallation] Error adding an Installation.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} [handleAddInstallation] Error adding the Installation at ${path}: ${error}.`)
      addNotification(t("features.installations.errorAddingInstallation"), "error")
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
                { name: t("breadcrumbs.addInstallation"), to: "/installations/add" }
              ]}
            />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <FromWrapper className="max-w-[50rem] w-full my-auto">
          <FormGroupWrapper title={t("generic.basics")}>
            <NameAndIconPicker
              name={fields.name}
              onNameChange={fields.setName}
              icon={fields.icon}
              onIconChange={fields.setIcon}
              customIcons={customIcons}
              iconButtonClassName="w-40 h-13 p-1 pr-2 flex items-center justify-between gap-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none text-sm text-start cursor-pointer shrink-0"
            />

            <GameVersionPicker gameVersions={gameVersions} version={fields.version} onSelect={fields.setVersion} />

            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.installations.dataFolder")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup alignment="x">
                  <FormButton onClick={browseFolder} title={t("generic.browse")} className="h-8 px-2 py-1">
                    <PiMagnifyingGlassDuotone />
                  </FormButton>
                  <FormInputText placeholder={t("features.installations.installationFolder")} value={path} onChange={(e) => setPath(e.target.value)} minLength={1} className="w-full" />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>
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
              <NormalButton
                title={t("features.installations.startParamsLink")}
                onClick={() => openExternalLink("https://wiki.vintagestory.at/Client_startup_parameters")}
                className="text-vsl underline"
              >
                {t("features.installations.startParamsLink")}
              </NormalButton>
            }
            mesaGlThread={fields.mesaGlThread}
            onMesaGlThreadChange={fields.setMesaGlThread}
            envVars={fields.envVars}
            onEnvVarsChange={fields.setEnvVars}
            launchWrapper={fields.launchWrapper}
            onLaunchWrapperChange={fields.setLaunchWrapper}
          />

          <ButtonsWrapper className="text-lg">
            <FormLinkButton to="/installations" title={t("generic.goBack")} type="error" className="p-2">
              <PiXCircleDuotone />
            </FormLinkButton>
            <FormButton onClick={handleAddInstallation} title={t("generic.add")} type="success" className="p-2">
              <PiFloppyDiskBackDuotone />
            </FormButton>
          </ButtonsWrapper>
        </FromWrapper>
      </div>
    </ScrollableContainer>
  )
}

export default AddInslallation
