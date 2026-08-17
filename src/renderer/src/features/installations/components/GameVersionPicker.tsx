import { useTranslation, Trans } from "react-i18next"
import semver from "semver"
import { PiWarningDuotone } from "react-icons/pi"

import { FormBody, FormHead, FormLabel, FromGroup } from "@renderer/components/ui/FormComponents"
import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import { LinkButton } from "@renderer/components/ui/Buttons"

export interface GameVersionPickerProps {
  gameVersions: GameVersionType[]
  version: GameVersionType | undefined
  onSelect: (version: GameVersionType) => void
  /** An Installation's VS Version that is no longer installed, if any. Warns instead of
   *  letting the empty selection look like a glitch (#118). Unused by AddInstallation. */
  missingVersion?: string
}

/** The game version table shared by AddInstallation and EditInstallation. */
export function GameVersionPicker({ gameVersions, version, onSelect, missingVersion }: GameVersionPickerProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <FromGroup>
      <FormHead>
        <FormLabel content={t("features.versions.labelGameVersion")} />
      </FormHead>

      <FormBody>
        {missingVersion && (
          <div className="flex items-center justify-center gap-2 rounded-sm bg-orange-500/10 border border-orange-500/30 px-3 py-2 text-sm text-orange-300">
            <PiWarningDuotone className="text-lg shrink-0" />
            <span>{t("features.versions.versionNotInstalledPickAnother", { version: missingVersion })}</span>
          </div>
        )}

        <TableWrapper>
          <TableHead>
            <TableHeadRow>
              <TableCell className="w-full text-center">{t("generic.version")}</TableCell>
            </TableHeadRow>
          </TableHead>

          <TableBody className="max-h-[14rem]">
            {gameVersions.length < 1 && (
              <div className="w-full p-1 flex flex-col items-center justify-center">
                <p>{t("features.versions.noVersionsFound")}</p>
                <p className="text-zinc-400 text-sm flex gap-1 items-center flex-wrap justify-center">
                  <Trans
                    i18nKey="features.versions.noVersionsFoundDesc"
                    components={{
                      link: (
                        <LinkButton title={t("components.mainMenu.versionsTitle")} to="/versions" className="text-vsl">
                          {t("components.mainMenu.versionsTitle")}
                        </LinkButton>
                      )
                    }}
                  />
                </p>
              </div>
            )}
            {gameVersions
              .slice()
              .sort((a, b) => semver.rcompare(a.version, b.version))
              .map((gv) => (
                <TableBodyRow key={gv.version} onClick={() => onSelect(gv)} selected={version?.version === gv.version}>
                  <TableCell className="w-full">{gv.version}</TableCell>
                </TableBodyRow>
              ))}
          </TableBody>
        </TableWrapper>
      </FormBody>
    </FromGroup>
  )
}
