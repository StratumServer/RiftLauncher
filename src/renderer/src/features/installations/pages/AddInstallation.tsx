import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { PiFloppyDiskBackDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"
import semver from "semver"

import { createInstallation } from "@domain/installations/create"
import { INSTALLATION_ICONS } from "@renderer/utils/installationIcons"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useInstallations, useGameVersions, useCustomIcons, useSettingsConfig, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { createCreateInstallationPorts, describeCreateInstallationFailure, toFoldersInUse, toInstallationType } from "@renderer/features/installations/adapters/create"
import { useDefaultInstallationPath, useEnsurePathExists, usePickEmptyFolder } from "@renderer/features/installations/hooks/usePathActions"
import { useOpenExternalLink } from "@renderer/features/installations/hooks/useOpenExternalLink"
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

function AddInslallation(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const installations = useInstallations()
  const gameVersions = useGameVersions()
  const customIcons = useCustomIcons()
  const settings = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const navigate = useNavigate()
  const defaultInstallationPath = useDefaultInstallationPath()
  const pickEmptyFolder = usePickEmptyFolder()
  const ensurePathExists = useEnsurePathExists()
  const openExternalLink = useOpenExternalLink()

  const fields = useInstallationFormFields({
    icon: INSTALLATION_ICONS[0],
    name: t("features.installations.defaultName"),
    version: [...gameVersions].sort((a, b) => semver.compare(b.version, a.version))[0],
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    mesaGlThread: false,
    envVars: ""
  })

  const [path, setPath] = useState<string>("")
  const [folderByUser, setFolderByUser] = useState<boolean>(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    ;(async (): Promise<void> => {
      if (fields.name && !folderByUser) setPath(await defaultInstallationPath(settings.defaultInstallationsFolder, fields.name))
    })()
  }, [fields.name])

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
      foldersInUse: toFoldersInUse({ backupsFolder: settings.backupsFolder, installations, gameVersions })
    })

    if (!result.ok) {
      const { messageKey } = describeCreateInstallationFailure(result.reason)
      return addNotification(t(messageKey, { min: 5, max: 50 }), "error")
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
                  <FormButton
                    onClick={async () => {
                      const selectedPath = await pickEmptyFolder()
                      if (selectedPath) {
                        setPath(selectedPath)
                        setFolderByUser(true)
                      }
                    }}
                    title={t("generic.browse")}
                    className="h-8 px-2 py-1"
                  >
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
              <NormalButton title={t("features.installations.startParamsLink")} onClick={() => openExternalLink("https://wiki.vintagestory.at/Client_startup_parameters")} className="text-vsl">
                {t("features.installations.startParamsLink")}
              </NormalButton>
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
