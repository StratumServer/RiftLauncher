import { useTranslation, Trans } from "react-i18next"
import { PiWarningDuotone } from "react-icons/pi"

import { compareGameVersionsDesc } from "@renderer/utils/gameVersionOrder"
import { FormBody, FormHead, FormLabel, FromGroup } from "@renderer/components/ui/FormComponents"
import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import { LinkButton } from "@renderer/components/ui/Buttons"
import type { InstallationVersionStatus } from "@domain/installations/versionReference"

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export interface GameVersionPickerProps {
  gameVersions: GameVersionType[]
  version: GameVersionType | undefined
  onSelect: (version: GameVersionType) => void
  /** The unresolved Installation reference. Undefined means AddInstallation or a linked edit. */
  unresolvedVersion?: { version: string; status: Exclude<InstallationVersionStatus, "linked"> }
}

/** The game version table shared by AddInstallation and EditInstallation. */
export function GameVersionPicker({ gameVersions, version, onSelect, unresolvedVersion }: Readonly<GameVersionPickerProps>): JSX.Element {
  const { t } = useTranslation()

  return (
    <FromGroup>
      <FormHead>
        <FormLabel content={t("features.versions.labelGameVersion")} />
      </FormHead>

      <FormBody>
        {unresolvedVersion !== undefined && (
          <div className="flex items-center justify-center gap-2 rounded-sm bg-orange-500/10 border border-orange-500/30 px-3 py-2 text-sm text-orange-300">
            <PiWarningDuotone className="text-lg shrink-0" />
            <span>
              {unresolvedVersion.status === "unset"
                ? t("features.versions.noVersionSetPickOne")
                : unresolvedVersion.status === "unlinked"
                  ? t("features.versions.versionUnlinkedPickOne")
                  : t("features.versions.versionNotInstalledPickAnother", { version: unresolvedVersion.version })}
            </span>
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
                        <LinkButton title={t("components.mainMenu.versionsTitle")} to="/versions" variant="link">
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
              .sort((a, b) => compareGameVersionsDesc(a.version, b.version))
              .map((gv) => (
                <TableBodyRow key={gv.id} onClick={() => onSelect(gv)} selected={version?.id === gv.id}>
                  <TableCell className="w-full">
                    <div className="flex items-center justify-between gap-2">
                      <span>{gv.label}</span>
                      {gameVersions.some((other) => other.id !== gv.id && other.version === gv.version) && <span className="text-xs text-zinc-400">{folderName(gv.path)}</span>}
                    </div>
                  </TableCell>
                </TableBodyRow>
              ))}
          </TableBody>
        </TableWrapper>
      </FormBody>
    </FromGroup>
  )
}
