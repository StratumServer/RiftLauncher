import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { FiLoader } from "react-icons/fi"
import { PiDownloadDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useGameVersions, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useGameVersionCatalog } from "@renderer/features/versions/hooks/useGameVersionCatalog"
import { useVersionInstallFolder } from "@renderer/features/versions/hooks/useVersionInstallFolder"
import { useInstallVersion } from "@renderer/features/versions/hooks/useInstallVersion"

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
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton, ReloadButton } from "@renderer/components/ui/StickyMenu"

function AddVersion(): JSX.Element {
  const { t } = useTranslation()
  const installedGameVersions = useGameVersions()
  const settings = useSettingsConfig()

  const { gameVersions, loading, failed, retry } = useGameVersionCatalog()
  const [version, setVersion] = useState<DownloadableGameVersionTypeType | undefined>()
  const [versionFilters, setVersionFilters] = useState({ stable: true, rc: false, pre: false })
  const { folder, setFolder, browseFolder } = useVersionInstallFolder(version, settings.defaultVersionsFolder)
  const installVersion = useInstallVersion()

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setVersion(gameVersions.find((gv) => versionFilters[gv.type] && !installedGameVersions.some((igv) => igv.version === gv.version)))
  }, [gameVersions, versionFilters])

  const handleInstallVersion = (): Promise<void> => installVersion(version, folder)

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

                  {failed ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-10">
                      <p className="text-sm text-zinc-400">{t("features.versions.catalogLoadFailed")}</p>
                      <ReloadButton onClick={retry} reloading={loading} />
                    </div>
                  ) : gameVersions.length === 0 ? (
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
                              disabled={installedGameVersions.some((igv) => igv.version === gv.version)}
                              onClick={() => !installedGameVersions.some((igv) => igv.version === gv.version) && setVersion(gv)}
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
                  <FormButton onClick={browseFolder} title={t("generic.browse")} className="px-2 py-1">
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
