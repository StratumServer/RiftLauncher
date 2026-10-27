import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { PiCheckCircleDuotone, PiWarningDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useExportModpack } from "@renderer/features/mods/hooks/useExportModpack"
import { useModConfigs } from "@renderer/features/mods/hooks/useModConfigs"
import { defaultChosenModConfigs, diagnoseModConfigKey, findCollidingModConfigKeys, maxExportableModConfigs, showDefaultIgnorables } from "@domain/mods/modConfigs"

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
 * Files start ticked by default when every valid config fits within the pack's remaining entry
 * capacity (2,000 entries across mods, servers, and configs together). When the folder holds more
 * valid configs than the pack can carry, none start ticked so the player can choose the subset to
 * carry without having to untick thousands of files first. This is the one place this deliberately
 * parts company with `ImportModConfigsDialog` next door. There a tick meant overwriting a file the
 * player may have spent an evening on, so it started clear. Here the tick means sharing a file the
 * player has already said they want to share by ticking the box that opened this dialog. The warning
 * is what makes that safe, and every row is a way to say no to one of them.
 *
 * Files that a pack cannot carry (a name Windows refuses, an unreadable non-UTF-8 file name, or one
 * that carries hidden Unicode characters, or a name that collides with another config in letter case)
 * and symbolic links display why under their name. Unsupported, unreadable, and linked rows are
 * disabled, while colliding rows start unticked: unticking a colliding config leaves it out of the
 * export instead of failing.
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

  const maxConfigs = useMemo(
    () => maxExportableModConfigs(installedMods.length, includeServers ? (installation.servers?.length ?? 0) : 0),
    [installedMods.length, includeServers, installation.servers]
  )

  const collidingLower = useMemo(() => {
    if (!listing?.ok) return new Set<string>()
    return findCollidingModConfigKeys(listing.configs.map((entry) => entry.name))
  }, [listing])

  const rows = useMemo(() => {
    if (!listing?.ok) return []
    return listing.configs.map((entry) => ({
      name: entry.name,
      issue: diagnoseModConfigKey(entry.name, collidingLower)
    }))
  }, [listing, collidingLower])

  const validCount = useMemo(() => rows.filter((row) => row.issue === undefined).length, [rows])
  const chosenSet = useMemo(() => new Set(chosen), [chosen])

  useEffect(() => {
    // Asked again on every open, because this dialog outlives the page's own listing: a config the
    // game wrote since the page loaded would otherwise be missing from the rows and would travel in
    // the pack with nothing to agree to.
    if (open) refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    if (!listing?.ok) {
      setChosen([])
      return
    }
    setChosen(
      defaultChosenModConfigs(
        listing.configs.map((entry) => entry.name),
        collidingLower,
        maxConfigs
      )
    )
  }, [open, listing, collidingLower, maxConfigs])

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
            {validCount > maxConfigs && <p className="text-sm text-zinc-300">{t("features.mods.importModConfigsHave", { count: listing.configs.length })}</p>}
            <p>{chosen.length === 0 ? t("features.mods.exportModConfigsDescZero") : t("features.mods.exportModConfigsDesc", { count: chosen.length })}</p>

            <p className="flex items-start gap-2 text-sm text-zinc-300">
              <PiWarningDuotone className="mt-0.5 shrink-0" />
              <span>{t("features.mods.exportModConfigsWarning")}</span>
            </p>

            <ul className="w-full max-h-[20rem] overflow-y-auto flex flex-col gap-1 text-left">
              {rows.map(({ name, issue }) => {
                const isChosen = chosenSet.has(name)
                return (
                  <li key={name} className="flex items-center gap-2 rounded-sm bg-zinc-950/50 px-2 py-1">
                    <Input
                      id={`export-mod-config-${name}`}
                      type="checkbox"
                      checked={isChosen}
                      disabled={issue === "bad-name" || issue === "hidden-character" || (!isChosen && chosen.length >= maxConfigs)}
                      onChange={(e) =>
                        setChosen((current) => {
                          if (!e.target.checked) return current.filter((key) => key !== name)
                          return current.length >= maxConfigs || current.includes(name) ? current : [...current, name]
                        })
                      }
                    />
                    <label htmlFor={`export-mod-config-${name}`} className="flex-1 overflow-hidden">
                      <span className="block truncate font-bold">{name}</span>
                      {issue && (
                        <span className="block truncate text-sm text-zinc-300">
                          {issue === "hidden-character" ? showDefaultIgnorables(name) : issue === "bad-name" ? t("features.mods.exportModConfigsBadName") : t("features.mods.exportModConfigsCollides")}
                        </span>
                      )}
                    </label>
                  </li>
                )
              })}
              {listing.linked.map((name) => (
                <li key={`linked-${name}`} className="flex items-center gap-2 rounded-sm bg-zinc-950/50 px-2 py-1">
                  <Input id={`export-mod-config-${name}`} type="checkbox" checked={false} disabled />
                  <label htmlFor={`export-mod-config-${name}`} className="flex-1 overflow-hidden">
                    <span className="block truncate font-bold">{name}</span>
                    <span className="block truncate text-sm text-zinc-300">{t("features.mods.exportModConfigsLinked")}</span>
                  </label>
                </li>
              ))}
              {listing.unreadable?.map((name) => (
                <li key={`unreadable-${name}`} className="flex items-center gap-2 rounded-sm bg-zinc-950/50 px-2 py-1">
                  <Input id={`export-mod-config-${name}`} type="checkbox" checked={false} disabled />
                  <label htmlFor={`export-mod-config-${name}`} className="flex-1 overflow-hidden">
                    <span className="block truncate font-bold">{name}</span>
                    <span className="block truncate text-sm text-zinc-300">{t("features.mods.exportModConfigsUnreadableName")}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("features.mods.exportModConfigsSkip")} onClick={() => run(undefined)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
          <FormButton
            title={t("features.mods.exportModConfigsApply")}
            onClick={() => run(chosen)}
            variant="primary"
            size="md"
            icon={<PiCheckCircleDuotone />}
            disabled={chosen.length === 0 || chosen.length > maxConfigs}
          />
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ExportModConfigsDialog
