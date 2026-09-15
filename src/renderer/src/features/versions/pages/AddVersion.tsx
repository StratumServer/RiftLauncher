import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { FiLoader } from "react-icons/fi"
import { PiDownloadDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useGameVersionCatalog } from "@renderer/features/versions/hooks/useGameVersionCatalog"
import { useVersionInstallFolder } from "@renderer/features/versions/hooks/useVersionInstallFolder"
import { useInstallVersion } from "@renderer/features/versions/hooks/useInstallVersion"
import { useOptimumManifest } from "@renderer/features/versions/hooks/useOptimumManifest"
import { describeOptimumManifestFailure } from "@renderer/features/versions/adapters/optimum"
import { supportsGameVersion } from "@domain/optimum/plan"

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
  const settings = useSettingsConfig()

  const { gameVersions, loading, failed, retry } = useGameVersionCatalog()
  const [version, setVersion] = useState<DownloadableGameVersionTypeType | undefined>()
  const [versionFilters, setVersionFilters] = useState({ stable: true, rc: false, pre: false })
  const { folder, browseFolder } = useVersionInstallFolder(version, settings.defaultVersionsFolder)
  const installVersion = useInstallVersion()
  const optimum = useOptimumManifest()
  const [withOptimum, setWithOptimum] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const buildFieldId = useId()

  useEffect(() => {
    setVersion(gameVersions.find((gv) => versionFilters[gv.type]))
  }, [gameVersions, versionFilters])

  /**
   * Whether Optimum can be offered for what is selected right now.
   *
   * Two things have to hold: a manifest was read for this machine, and the
   * overlay it describes was published for the version in the table. The second
   * is the launcher's alone to enforce, since the patch itself never checks it.
   */
  const optimumAvailable = optimum.manifest !== undefined && version !== undefined && supportsGameVersion(optimum.manifest, version.version)

  // A version the overlay does not cover is the one refusal that changes as the
  // player moves down the table, so the choice falls back rather than sticking.
  useEffect(() => {
    if (!optimumAvailable) setWithOptimum(false)
  }, [optimumAvailable])

  /** The one calm line under a choice that cannot be taken. Empty while it can. */
  const optimumUnavailableReason = optimumAvailable
    ? ""
    : optimum.reason !== undefined
      ? t(describeOptimumManifestFailure(optimum.reason))
      : optimum.manifest !== undefined
        ? t("features.versions.optimumNoBuildForVersion")
        : ""

  const handleInstallVersion = (): Promise<void> => installVersion(version, folder, withOptimum && optimum.manifest ? optimum.manifest : undefined)

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
                            <TableBodyRow key={`${gv.version}-${gv.type}`} selected={version?.version === gv.version} onClick={() => setVersion(gv)}>
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
                <FormLabel content={t("features.versions.labelBuild")} />
              </FormHead>

              <FormBody>
                <fieldset className="flex flex-col gap-1 text-sm">
                  <legend className="sr-only">{t("features.versions.labelBuild")}</legend>

                  <div className="flex items-center gap-2">
                    <Input type="radio" id={`${buildFieldId}-official`} name={`${buildFieldId}-build`} checked={!withOptimum} onChange={() => setWithOptimum(false)} className="cursor-pointer" />
                    <label htmlFor={`${buildFieldId}-official`} className="cursor-pointer">
                      {t("features.versions.buildOfficial")}
                    </label>
                  </div>

                  <div className="flex items-center gap-2">
                    <Input
                      type="radio"
                      id={`${buildFieldId}-optimum`}
                      name={`${buildFieldId}-build`}
                      checked={withOptimum}
                      disabled={!optimumAvailable}
                      onChange={() => setWithOptimum(true)}
                      className={optimumAvailable ? "cursor-pointer" : "cursor-not-allowed"}
                    />
                    <label htmlFor={`${buildFieldId}-optimum`} className={optimumAvailable ? "cursor-pointer" : "cursor-not-allowed text-zinc-400"}>
                      {optimum.manifest ? `Optimum ${optimum.manifest.optimumVersion}` : "Optimum"}
                    </label>
                  </div>

                  {optimumUnavailableReason && <p className="text-xs text-zinc-400 pl-1">{optimumUnavailableReason}</p>}
                </fieldset>
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("generic.folder")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup alignment="x">
                  <FormButton onClick={browseFolder} title={t("generic.browse")} variant="secondary" className="px-2 py-1">
                    <PiMagnifyingGlassDuotone />
                  </FormButton>
                  <FormInputText placeholder={t("features.versions.versionFolder")} value={folder} readOnly className="w-full" />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>
          </FormGroupWrapper>

          <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
            <FormLinkButton to="/versions" title={t("generic.goBack")} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
            <FormButton onClick={handleInstallVersion} title={t("generic.install")} variant="primary" size="md" icon={<PiDownloadDuotone />} />
          </ButtonsWrapper>
        </FromWrapper>
      </div>
    </ScrollableContainer>
  )
}

export default AddVersion
