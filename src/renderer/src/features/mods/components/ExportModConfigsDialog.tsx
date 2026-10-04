import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { PiCheckCircleDuotone, PiWarningDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useExportModpack } from "@renderer/features/mods/hooks/useExportModpack"
import { useModConfigs } from "@renderer/features/mods/hooks/useModConfigs"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/**
 * What a modpack carries before any of it reaches a file.
 *
 * The checkbox in the action bar asks "should this pack carry configs", and that is not a question a
 * player can answer with one tick: a config folder holds their server list, their keybinds and, in
 * some Mods, an API key, and the pack is a file they are about to hand to somebody. So the tick opens
 * this, every file gets a row, and the pack carries the rows that are left ticked.
 *
 * Everything starts ticked, which is the one place this deliberately parts company with
 * `ImportModConfigsDialog` next door. There a tick meant overwriting a file the player may have spent
 * an evening on, so it started clear. Here the tick means sharing a file the player has already said
 * they want to share by ticking the box that opened this dialog, and a dialog that started with
 * everything clear would turn "include my configs" into a list to assemble by hand. The warning is
 * what makes that safe, and every row is a way to say no to one of them.
 *
 * This is also the way around a file the pack cannot carry. A config that is not UTF-8, or whose name
 * Windows refuses, stops the whole export, and until this dialog existed the only answer was to go
 * and rename or delete it: the refusal named the file and nothing offered to leave it out.
 */
function ExportModConfigsDialog({
  open,
  installation,
  installedMods,
  includeServers,
  close
}: Readonly<{
  /** Whether the picker is showing. It stays mounted between exports, so this is the whole of the state. */
  open: boolean
  installation: InstallationType
  /** The Mods the pack will carry, already narrowed to the enabled ones by the caller. */
  installedMods: InstalledModType[]
  includeServers: boolean
  close: () => void
}>): JSX.Element {
  const { t } = useTranslation()
  const exportModpack = useExportModpack()

  const { listing, refresh } = useModConfigs(installation.path)
  const [chosen, setChosen] = useState<readonly string[]>([])

  useEffect(() => {
    // Asked again on every open, because this dialog outlives the page's own listing: a config the
    // game wrote since the page loaded would otherwise be missing from the rows and would travel in
    // the pack with nothing to agree to.
    if (open) refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    setChosen(listing?.ok ? listing.configs.map((entry) => entry.name) : [])
  }, [open, listing])

  /**
   * Closes first and exports after, so the save dialog is the only thing in front of the player.
   *
   * @param configNames The rows that were ticked, or undefined for a pack that carries no configs at
   *   all. The second one skips the read entirely rather than reading a folder to select nothing
   *   from it.
   */
  function run(configNames: readonly string[] | undefined): void {
    close()
    void exportModpack({ installedMods, installation, includeServers, includeConfigs: configNames !== undefined, configNames })
  }

  return (
    <PopupDialogPanel title={t("features.mods.exportModConfigsTitle")} isOpen={open} close={close}>
      <>
        {/* Nothing is listed until the host has answered, the same way the import dialog waits. An
            answer that has not arrived is not an empty folder, and an empty list here would read as
            "this Installation has no configs" while the pack was still going to carry them. */}
        {listing === undefined ? null : !listing.ok ? (
          <p>{listing.reason === "playing" ? t("features.mods.exportModConfigsPlaying") : t("features.mods.exportModConfigsUnreadable")}</p>
        ) : (
          <>
            <p>{t("features.mods.exportModConfigsDesc", { count: listing.configs.length })}</p>

            <p className="flex items-start gap-2 text-sm text-zinc-300">
              <PiWarningDuotone className="mt-0.5 shrink-0" />
              <span>{t("features.mods.exportModConfigsWarning")}</span>
            </p>

            <ul className="w-full max-h-[20rem] overflow-y-auto flex flex-col gap-1 text-left">
              {listing.configs.map((entry) => (
                <li key={entry.name} className="flex items-center gap-2 rounded-sm bg-zinc-950/50 px-2 py-1">
                  <Input
                    id={`export-mod-config-${entry.name}`}
                    type="checkbox"
                    checked={chosen.includes(entry.name)}
                    onChange={(e) => setChosen((current) => (e.target.checked ? [...current, entry.name] : current.filter((key) => key !== entry.name)))}
                  />
                  <label htmlFor={`export-mod-config-${entry.name}`} className="flex-1 overflow-hidden">
                    <span className="block truncate font-bold">{entry.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("features.mods.exportModConfigsSkip")} onClick={() => run(undefined)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
          <FormButton title={t("features.mods.exportModConfigsApply")} onClick={() => run(chosen)} variant="primary" size="md" icon={<PiCheckCircleDuotone />} disabled={chosen.length === 0} />
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ExportModConfigsDialog
