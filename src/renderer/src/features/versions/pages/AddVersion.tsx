import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { useNavigate } from "react-router-dom"
import { FiLoader } from "react-icons/fi"
import { PiDownloadDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"

import { installGameVersion } from "@domain/versions/install"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useConfigContext } from "@renderer/features/config/contexts/ConfigContext"
import { useTaskContext } from "@renderer/contexts/TaskManagerContext"
import { createInstallPorts, describeInstallFailure, toDownloadableGameVersion } from "@renderer/features/versions/adapters/install"
import { compareVersions } from "@domain/versionNumbers"

import {
  FormBody,
  FormHead,
  FormLabel,
  FromGroup,
  FromWrapper,
  FormFieldGroup,
  FormButton,
  FormInputText,
  FormLinkButton,
  FormGroupWrapper,
  ButtonsWrapper
} from "@renderer/components/ui/FormComponents"
import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

// Official public API: https://api.vintagestory.at/{stable,unstable}.json
// Shape: { [version]: { [platform]: { filename, filesize, md5, urls: { cdn, local }, ... } } }
type RawPlatform = { filename?: string; urls: { cdn: string; local: string } }
type RawVersions = Record<string, Record<string, RawPlatform>>
const VS_API = "https://api.vintagestory.at"

const NO_BUILD: DownloadableGameVersionBuildType = { url: "", fileName: "" }

/**
 * Reads one platform's build out of a catalog entry.
 *
 * The catalog `filename` is the name the file is saved under. It is the same
 * string as the URL basename today, but it is the field the catalog publishes
 * alongside the md5 the download is checked against, so it is the one taken.
 * A build missing either field counts as no build: the install then says the
 * catalog has nothing for this system instead of inventing a name for it.
 */
function toBuild(platform: RawPlatform | undefined): DownloadableGameVersionBuildType {
  if (!platform?.urls.cdn || !platform.filename) return NO_BUILD
  return { url: platform.urls.cdn, fileName: platform.filename }
}

const LOG_TAG = "[front] [versions] [features/versions/pages/AddVersion.tsx]"

function deriveType(version: string): DownloadableGameVersionTypeType["type"] {
  if (version.includes("-rc")) return "rc"
  if (version.includes("-pre")) return "pre"
  return "stable"
}

function parseGameVersions(stable: RawVersions, unstable: RawVersions): DownloadableGameVersionTypeType[] {
  return Object.entries({ ...unstable, ...stable })
    .map(([version, p]) => ({
      version,
      type: deriveType(version),
      windows: toBuild(p.windows),
      linux: toBuild(p.linux),
      mac: toBuild(p["mac-arm64"] ?? p["mac-x64"])
    }))
    .sort((a, b) => compareVersions(b.version, a.version))
}

function AddVersion(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const { config, configDispatch } = useConfigContext()
  const { startDownload, startExtract, startInstall } = useTaskContext()
  const navigate = useNavigate()

  const [gameVersions, setGameVersions] = useState<DownloadableGameVersionTypeType[]>([])
  const [version, setVersion] = useState<DownloadableGameVersionTypeType | undefined>()
  const [folder, setFolder] = useState<string>("")
  const [folderByUser, setFolderByUser] = useState<boolean>(false)
  const [versionFilters, setVersionFilters] = useState({ stable: true, rc: false, pre: false })

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    ;(async (): Promise<void> => {
      try {
        const [stableResponse, unstableResponse] = await Promise.all([fetch(`${VS_API}/stable.json`), fetch(`${VS_API}/unstable.json`)])
        if (!stableResponse.ok || !unstableResponse.ok) throw new Error("Game version API request failed")
        const [stable, unstable] = (await Promise.all([stableResponse.json(), unstableResponse.json()])) as [RawVersions, RawVersions]
        setGameVersions(parseGameVersions(stable, unstable))
      } catch (err) {
        window.api.utils.logMessage("error", `[front] [mods] [features/versions/pages/AddVersion.tsx] [AddVersion] Error fetching game versions.`)
        window.api.utils.logMessage("debug", `[front] [mods] [features/versions/pages/AddVersion.tsx] [AddVersion] Error fetching game versions: ${err}`)
      }
    })()
  }, [])

  useEffect(() => {
    ;(async (): Promise<void> => {
      if (version && !folderByUser) setFolder(await window.api.pathsManager.formatPath([config.defaultVersionsFolder, version.version]))
    })()
  }, [version])

  useEffect(() => {
    setVersion(gameVersions.find((gv) => versionFilters[gv.type] && !config.gameVersions.some((igv) => igv.version === gv.version)))
  }, [gameVersions, versionFilters])

  const handleInstallVersion = async (): Promise<void> => {
    if (!version) return addNotification(t("features.versions.noVersionSelected"), "error")

    const ports = createInstallPorts({
      startDownload,
      startExtract,
      startInstall,
      taskName: t("features.versions.gameVersionTaskName", { version: version.version }),
      downloadDescription: t("features.versions.gameVersionDownloadDesc", { version: version.version }),
      unpackDescription: t("features.versions.gameVersionExtractDesc", { version: version.version })
    })

    const result = await installGameVersion(
      ports,
      {
        platform: await window.api.utils.getOs(),
        version: toDownloadableGameVersion(version),
        targetFolder: folder,
        installedVersions: config.gameVersions.map((gv) => gv.version),
        foldersInUse: [config.backupsFolder, ...config.gameVersions.map((gv) => gv.path), ...config.installations.map((i) => i.path)]
      },
      {
        onRegistered: () => {
          configDispatch({ type: CONFIG_ACTIONS.ADD_GAME_VERSION, payload: { version: version.version, path: folder, _installing: true } })
          navigate("/versions")
        },
        onInstalled: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: version.version, updates: { _installing: undefined } } }),
        onDiscarded: () => configDispatch({ type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { version: version.version } })
      }
    )

    if (result.ok) return

    const { messageKey, logged } = describeInstallFailure(result.reason)

    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} [handleInstallVersion] Error installing VS Version ${version.version}.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} [handleInstallVersion] Error installing VS Version ${version.version} on ${folder}: ${result.reason}.`)
    }

    addNotification(t(messageKey, { version: version.version, folder }), "error")
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/versions" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.versions"), to: "/versions" },
                { name: t("breadcrumbs.addVersion"), to: "/versions/add" }
              ]}
            />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <FromWrapper className="max-w-[50rem] w-full my-auto">
          <FormGroupWrapper title={t("generic.basics")}>
            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.versions.labelGameVersion")} />

                <div className="flex flex-col gap-1 text-sm text-right">
                  <div className="flex items-center">
                    <label htmlFor="stable-version" className="w-full cursor-pointer pr-2">
                      {t("features.versions.labelStables")}
                    </label>
                    <Input
                      type="checkbox"
                      id="stable-version"
                      checked={versionFilters.stable}
                      onChange={(e) => setVersionFilters({ ...versionFilters, stable: e.target.checked })}
                      className="cursor-pointer"
                    />
                  </div>
                  <div className="flex items-center">
                    <label htmlFor="rc-version" className="w-full cursor-pointer pr-2">
                      {t("features.versions.labelRCs")}
                    </label>
                    <Input type="checkbox" id="rc-version" checked={versionFilters.rc} onChange={(e) => setVersionFilters({ ...versionFilters, rc: e.target.checked })} className="cursor-pointer" />
                  </div>
                  <div className="flex items-center">
                    <label htmlFor="pre-version" className="w-full cursor-pointer pr-2">
                      {t("features.versions.labelPreReleases")}
                    </label>
                    <Input type="checkbox" id="pre-version" checked={versionFilters.pre} onChange={(e) => setVersionFilters({ ...versionFilters, pre: e.target.checked })} className="cursor-pointer" />
                  </div>
                </div>
              </FormHead>

              <FormBody>
                <TableWrapper className="text-center">
                  <TableHead>
                    <TableHeadRow>
                      <TableCell className="w-1/2">{t("generic.version")}</TableCell>
                      <TableCell className="w-1/2">{t("generic.type")}</TableCell>
                    </TableHeadRow>
                  </TableHead>

                  {gameVersions.length === 0 ? (
                    <div className="flex items-center justify-center py-10">
                      <FiLoader className="animate-spin text-3xl text-zinc-400" />
                    </div>
                  ) : (
                    <TableBody className="max-h-[14rem]">
                      {gameVersions.map(
                        (gv) =>
                          versionFilters[gv.type] && (
                            <TableBodyRow
                              key={gv.version}
                              selected={version?.version === gv.version}
                              disabled={config.gameVersions.some((igv) => igv.version === gv.version)}
                              onClick={() => !config.gameVersions.find((igv) => igv.version === gv.version) && setVersion(gv)}
                            >
                              <TableCell className="w-1/2">{gv.version}</TableCell>
                              <TableCell className="w-1/2">{gv.type}</TableCell>
                            </TableBodyRow>
                          )
                      )}
                    </TableBody>
                  )}
                </TableWrapper>
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("generic.folder")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup alignment="x">
                  <FormButton
                    onClick={async () => {
                      const path = await window.api.utils.selectFolderDialog()
                      const selectedPath = path[0]
                      if (selectedPath && selectedPath.length > 0) {
                        if (!(await window.api.pathsManager.checkPathEmpty(selectedPath))) addNotification(t("notifications.body.folderNotEmpty"), "warning")

                        setFolder(selectedPath)
                        setFolderByUser(true)
                      }
                    }}
                    title={t("generic.browse")}
                    className="px-2 py-1"
                  >
                    <PiMagnifyingGlassDuotone />
                  </FormButton>
                  <FormInputText placeholder={t("features.versions.versionFolder")} value={folder} onChange={(e) => setFolder(e.target.value)} className="w-full" />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>
          </FormGroupWrapper>

          <ButtonsWrapper className="text-lg">
            <FormLinkButton to="/versions" title={t("generic.goBack")} type="error" className="p-2">
              <PiXCircleDuotone />
            </FormLinkButton>
            <FormButton onClick={handleInstallVersion} title={t("generic.install")} type="success" className="p-2">
              <PiDownloadDuotone />
            </FormButton>
          </ButtonsWrapper>
        </FromWrapper>
      </div>
    </ScrollableContainer>
  )
}

export default AddVersion
