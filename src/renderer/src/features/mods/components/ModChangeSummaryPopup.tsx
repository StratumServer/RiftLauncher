import { useTranslation } from "react-i18next"
import { FiExternalLink } from "react-icons/fi"
import { PiArrowRightDuotone, PiCheckCircleDuotone, PiMinusCircleDuotone } from "react-icons/pi"

import { compareVersions } from "@domain/versionNumbers"
import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { useExternalLinks } from "@renderer/features/mods/hooks/useExternalLinks"

function toVersionColor(entry: ModChangeSummaryEntry): string {
  if (!entry.toVersion) return "text-red-400"
  if (entry.fromVersion && compareVersions(entry.toVersion, entry.fromVersion) < 0) return "text-orange-400"
  return "text-green-400"
}

function ModChangeSummaryPopup({ isOpen, close, title, entries }: Readonly<{ isOpen: boolean; close: () => void; title: string; entries: ModChangeSummaryEntry[] }>): JSX.Element {
  const { t } = useTranslation()
  const { openModOnModDb } = useExternalLinks()

  return (
    <PopupDialogPanel title={title} isOpen={isOpen} close={close} fixedWidth={false}>
      <>
        <TableWrapper className="w-[44rem]">
          <TableHead>
            <TableHeadRow>
              <TableCell className="w-5/12">{t("generic.name")}</TableCell>
              <TableCell className="w-5/12">{t("generic.version")}</TableCell>
              <TableCell className="w-2/12 text-center">{t("generic.actions")}</TableCell>
            </TableHeadRow>
          </TableHead>
          <TableBody className="max-h-[20rem]">
            {[...entries]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((entry) => (
                <TableBodyRow key={entry.modid}>
                  <TableCell className="w-5/12 overflow-hidden whitespace-nowrap text-ellipsis">{entry.name}</TableCell>
                  <TableCell className="w-5/12">
                    {entry.alreadyPresent ? (
                      <span className="flex items-center gap-1 text-sm text-zinc-400">
                        <PiMinusCircleDuotone className="shrink-0" />v{entry.toVersion} · {t("features.mods.summaryAlreadyPresent")}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-sm">
                        <span className="text-zinc-400">{entry.fromVersion ? `v${entry.fromVersion}` : t("features.mods.summaryNew")}</span>
                        <PiArrowRightDuotone className="text-zinc-400 shrink-0" />
                        <span className={toVersionColor(entry)}>{entry.toVersion ? `v${entry.toVersion}` : t("features.mods.summaryFailed")}</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="w-2/12 flex justify-center">
                    {Boolean(entry.assetid) && (
                      <NormalButton className="p-1" title={t("features.mods.openOnTheModDB")} onClick={() => entry.assetid && openModOnModDb(entry.assetid)}>
                        <FiExternalLink />
                      </NormalButton>
                    )}
                  </TableCell>
                </TableBodyRow>
              ))}
          </TableBody>
        </TableWrapper>

        <div className="flex justify-center">
          <FormButton title={t("features.mods.summaryClose")} className="p-1 px-4 h-8" onClick={close} type="normal">
            <PiCheckCircleDuotone className="text-xl" />
            <p>{t("features.mods.summaryClose")}</p>
          </FormButton>
        </div>
      </>
    </PopupDialogPanel>
  )
}

export default ModChangeSummaryPopup
