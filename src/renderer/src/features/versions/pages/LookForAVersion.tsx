import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { PiFloppyDiskBackDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useLookForAVersion } from "@renderer/features/versions/hooks/useLookForAVersion"

import {
  ButtonsWrapper,
  FormButton,
  FormBody,
  FormLabel,
  FormHead,
  FormLinkButton,
  FromGroup,
  FromWrapper,
  FormInputText,
  FormFieldGroup,
  FormGroupWrapper
} from "@renderer/components/ui/FormComponents"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

function LookForAVersion(): JSX.Element {
  const { t } = useTranslation()
  const { folder, versionFound, detectFolder, addVersion } = useLookForAVersion()

  const scrollRef = useRef<HTMLDivElement | null>(null)

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.versions"), to: "/versions" },
                { name: t("breadcrumbs.lookForAVersion"), to: "/versions/look-for-a-version" }
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
                <FormLabel content={t("generic.folder")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup alignment="x">
                  <FormButton onClick={detectFolder} title={t("generic.browse")} className="px-2 py-1">
                    <PiMagnifyingGlassDuotone />
                  </FormButton>
                  <FormInputText value={folder} placeholder={t("generic.folder")} readOnly className="w-full" />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.versions.versionFound")} />
              </FormHead>

              <FormBody>
                <FormInputText value={versionFound} readOnly placeholder={t("features.versions.versionFound")} />
              </FormBody>
            </FromGroup>
          </FormGroupWrapper>

          <ButtonsWrapper className="text-lg">
            <FormLinkButton to="/versions" title={t("generic.cancel")} type="error" className="p-2">
              <PiXCircleDuotone />
            </FormLinkButton>
            <FormButton onClick={addVersion} title={t("generic.add")} type="success" className="p-2">
              <PiFloppyDiskBackDuotone />
            </FormButton>
          </ButtonsWrapper>
        </FromWrapper>
      </div>
    </ScrollableContainer>
  )
}

export default LookForAVersion
