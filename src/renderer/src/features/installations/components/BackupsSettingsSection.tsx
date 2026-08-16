import { useTranslation } from "react-i18next"

import { FormBody, FormHead, FormLabel, FromGroup, FormFieldDescription, FormFieldGroupWithDescription, FormGroupWrapper, FormInputNumber, FormToggle } from "@renderer/components/ui/FormComponents"

export interface BackupsSettingsSectionProps {
  backupsLimit: number
  onBackupsLimitChange: (backupsLimit: number) => void
  backupsAuto: boolean
  onBackupsAutoChange: (backupsAuto: boolean) => void
  compressionLevel: number
  onCompressionLevelChange: (compressionLevel: number) => void
}

/** The Backups FormGroupWrapper shared by AddInstallation and EditInstallation. */
export function BackupsSettingsSection({ backupsLimit, onBackupsLimitChange, backupsAuto, onBackupsAutoChange, compressionLevel, onCompressionLevelChange }: BackupsSettingsSectionProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <FormGroupWrapper title={t("generic.backups")}>
      <FromGroup>
        <FormHead>
          <FormLabel content={t("features.backups.backupsAmount")} />
        </FormHead>

        <FormBody>
          <FormFieldGroupWithDescription>
            <FormInputNumber placeholder={t("features.backups.backupsLimit")} value={backupsLimit} onChange={(e) => onBackupsLimitChange(Number(e.target.value))} min={0} max={10} className="w-full" />
            <FormFieldDescription content={t("generic.minMaxAmmount", { min: 0, max: 10 })} />
          </FormFieldGroupWithDescription>
        </FormBody>
      </FromGroup>

      <FromGroup className="items-center">
        <FormHead>
          <FormLabel content={t("features.backups.automaticBackups")} className="max-h-6" />
        </FormHead>

        <FormBody>
          <FormFieldGroupWithDescription alignment="x">
            <FormToggle title={t("features.backups.backupsAuto")} value={backupsAuto} onChange={onBackupsAutoChange} />
            <FormFieldDescription content={t("features.backups.backupsAuto")} />
          </FormFieldGroupWithDescription>
        </FormBody>
      </FromGroup>

      <FromGroup>
        <FormHead>
          <FormLabel content={t("generic.compression")} />
        </FormHead>

        <FormBody>
          <FormFieldGroupWithDescription>
            <FormInputNumber
              placeholder={t("features.backups.compressionLevel")}
              value={compressionLevel}
              onChange={(e) => onCompressionLevelChange(Number(e.target.value))}
              min={0}
              max={9}
              className="w-full"
            />
            <FormFieldDescription content={`${t("generic.minMaxAmmount", { min: 0, max: 9 })} · ${t("features.backups.compressionLevelDesc")}`} />
          </FormFieldGroupWithDescription>
        </FormBody>
      </FromGroup>
    </FormGroupWrapper>
  )
}
