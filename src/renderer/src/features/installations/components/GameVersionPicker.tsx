import { useTranslation, Trans } from "react-i18next"
import semver from "semver"

import { FormBody, FormHead, FormLabel, FromGroup } from "@renderer/components/ui/FormComponents"
import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import { LinkButton } from "@renderer/components/ui/Buttons"

export interface GameVersionPickerProps {
  gameVersions: GameVersionType[]
  version: GameVersionType | undefined
  onSelect: (version: GameVersionType) => void
}

/** The game version table shared by AddInstallation and EditInstallation. */
export function GameVersionPicker({ gameVersions, version, onSelect }: GameVersionPickerProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <FromGroup>
      <FormHead>
        <FormLabel content={t("features.versions.labelGameVersion")} />
      </FormHead>

      <FormBody>
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
