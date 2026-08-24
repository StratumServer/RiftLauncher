import type { ReactElement } from "react"
import { useTranslation, Trans } from "react-i18next"

import { FormBody, FormHead, FormLabel, FromGroup, FormFieldGroupWithDescription, FormInputText, FormFieldDescription, FormGroupWrapper, FormToggle } from "@renderer/components/ui/FormComponents"

export interface AdvancedSettingsSectionProps {
  startParams: string
  onStartParamsChange: (startParams: string) => void
  /**
   * The startParamsDesc Trans "link". Add renders it with NormalButton (title
   * tooltip, button chrome) while Edit renders a bare headlessui Button: a
   * pre-existing difference between the two pages that this component leaves
   * to its caller instead of papering over.
   */
  startParamsLink: ReactElement
  mesaGlThread: boolean
  onMesaGlThreadChange: (mesaGlThread: boolean) => void
  envVars: string
  onEnvVarsChange: (envVars: string) => void
}

/** The Advanced FormGroupWrapper shared by AddInstallation and EditInstallation. */
export function AdvancedSettingsSection({
  startParams,
  onStartParamsChange,
  startParamsLink,
  mesaGlThread,
  onMesaGlThreadChange,
  envVars,
  onEnvVarsChange
}: Readonly<AdvancedSettingsSectionProps>): JSX.Element {
  const { t } = useTranslation()

  return (
    <FormGroupWrapper title={t("generic.advanced")} startOpen={false}>
      <FromGroup>
        <FormHead>
          <FormLabel content={t("features.installations.labelStartParams")} />
        </FormHead>

        <FormBody>
          <FormFieldGroupWithDescription>
            <FormInputText value={startParams} onChange={(e) => onStartParamsChange(e.target.value)} placeholder={t("features.installations.startParams")} />
            <FormFieldDescription content={<Trans i18nKey="features.installations.startParamsDesc" components={{ link: startParamsLink }} />} />
          </FormFieldGroupWithDescription>
        </FormBody>
      </FromGroup>

      <FromGroup className="items-center">
        <FormHead>
          <FormLabel content={t("features.installations.mesaGlThread")} className="max-h-6" />
        </FormHead>

        <FormBody>
          <FormFieldGroupWithDescription alignment="x">
            <FormToggle title={t("features.installations.mesaGlThreadDesc")} value={mesaGlThread} onChange={onMesaGlThreadChange} />
            <FormFieldDescription content={t("features.installations.mesaGlThreadDesc")} />
          </FormFieldGroupWithDescription>
        </FormBody>
      </FromGroup>

      <FromGroup>
        <FormHead>
          <FormLabel content={t("features.installations.envVars")} />
        </FormHead>

        <FormBody>
          <FormFieldGroupWithDescription>
            <FormInputText value={envVars} onChange={(e) => onEnvVarsChange(e.target.value)} placeholder={t("features.installations.envVarsPlaceholder")} />
            <FormFieldDescription content={t("features.installations.envVarsDesc")} />
          </FormFieldGroupWithDescription>
        </FormBody>
      </FromGroup>
    </FormGroupWrapper>
  )
}
