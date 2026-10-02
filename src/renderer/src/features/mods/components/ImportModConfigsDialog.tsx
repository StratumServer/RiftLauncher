import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { PiCheckCircleDuotone, PiFolderOpenDuotone, PiXCircleDuotone } from "react-icons/pi"

import { applyModConfigs } from "@renderer/features/moddb/adapters/modsManager"
import { useModConfigs } from "@renderer/features/mods/hooks/useModConfigs"
import { useOpenPathInExplorer } from "@renderer/features/installations/hooks/usePathActions"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/**
 * How many failures are spelled out, which is the only list here that is a report rather than a
 * question. The rows above are never cut: a file the player cannot see is a file the player cannot
 * agree to, and the pack already caps how many can arrive.
 */
const MAX_LISTED_FAILURES = 50

/** What an apply did, held while the dialog shows it rather than in a toast that has already gone. */
type AppliedSummary = Extract<ApplyModConfigsResult, { ok: true }>

/**
 * What a modpack's mod configs get before any of them reach an Installation.
 *
 * A modpack is a stranger's file and a mod config is the one part of an Installation that belongs
 * to the player rather than to the game, so this dialog is the whole of the permission: every config
 * the pack carries is listed, each one is a checkbox, and nothing is written until they press the
 * button.
 *
 * The boxes are not all ticked and they are not all clear, which is the one place this dialog
 * deliberately parts company with `ImportServersDialog` next door. That one is all-ON because adding
 * an address to your own launcher discloses nothing. Here a tick means overwriting a config somebody
 * may have spent an evening tuning, so a file this Installation already has starts clear and says
 * so, and a file it has never seen starts ticked because a config the pack carries and nobody has
 * is the one thing the pack is actually for.
 *
 * The comparison folds case, because `Config.json` and `config.json` are one file on NTFS and on
 * APFS and two on Linux, and a dialog that called the second one new would tick a box that
 * overwrites the first. The listing arrives already normalised to `/` between directories by the
 * host, which is the same shape a pack's keys are validated into, so nothing here re-derives it.
 */
function ImportModConfigsDialog({
  settings,
  installation,
  close
}: Readonly<{
  /** The configs the pack carried, or null when it carried none and this dialog stays shut. */
  settings: Record<string, ModConfigEntry> | null
  installation: InstallationType | undefined
  close: () => void
}>): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const openPathInExplorer = useOpenPathInExplorer()

  const { listing, refresh } = useModConfigs(installation?.path ?? "")
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [applied, setApplied] = useState<AppliedSummary | null>(null)

  const carried = useMemo(() => Object.keys(settings ?? {}), [settings])

  /** The names this Installation already has, folded the way the file systems that merge case fold them. */
  const existing = useMemo(() => new Set((listing?.ok ? listing.configs : []).map((entry) => entry.name.toLowerCase())), [listing])

  useEffect(() => {
    // A new pack is a new question, and this dialog stays mounted between packs. Without this the
    // second import opened on the first one's summary, and the listing read when the page loaded
    // decided which boxes were ticked for a folder that had changed since: a config the previous
    // import wrote, or the game rewrote, was called one this Installation has never seen and was
    // ticked to be written over.
    setApplied(null)
    refresh()
  }, [settings, refresh])

  useEffect(() => {
    if (!listing?.ok) {
      setChosen([])
      return
    }
    setChosen(carried.filter((key) => !existing.has(key.toLowerCase())))
  }, [listing, carried, existing])

  const listed = listing?.ok ? listing.configs : []

  function writeChosen(): void {
    if (!installation || !settings) return close()

    // Object.entries rather than indexing: a Record<string, T> indexed by an arbitrary string is a
    // T that may be undefined, and this list is built from the record's own keys, which is exactly
    // what entries already walked.
    const files = Object.entries(settings)
      .filter(([name]) => chosen.includes(name))
      .map(([name, entry]) => ({ name, text: entry.text, sha256: entry.sha256 }))
    if (files.length === 0) return close()

    void applyModConfigs(installation.path, files)
      .then((result) => {
        if (!result.ok) {
          if (result.reason === "playing") addNotification(t("features.mods.importModConfigsPlaying"), "error")
          else if (result.reason === "busy") addNotification(t("features.mods.importModConfigsBusy"), "error")
          else if (result.reason === "no-backups-folder") addNotification(t("features.mods.importModConfigsNoBackupsFolder"), "error")
          else if (result.reason === "insufficient-space") addNotification(t("features.mods.importModConfigsInsufficientSpace"), "error")
          else addNotification(t("features.mods.importModConfigsUnreadable"), "error")
          return
        }

        addNotification(t("features.mods.importModConfigsWritten", { count: result.applied.length }), result.failed.length > 0 ? "warning" : "success")
        setApplied(result)
      })
      .catch(() => {
        // The channel rejects on malformed input rather than answering with a refusal, so a rejection
        // is a designed outcome and not a crash. Answering it here is the difference between a player
        // who is told and a button press that vanishes.
        addNotification(t("features.mods.importModConfigsUnreadable"), "error")
      })
  }

  function reasonFor(reason: ApplyFailureReason): string {
    if (reason === "digest-mismatch") return t("features.mods.importModConfigsReasonDigest")
    if (reason === "copy-failed") return t("features.mods.importModConfigsReasonCopy")
    if (reason === "not-landed") return t("features.mods.importModConfigsReasonNotLanded")
    return t("features.mods.importModConfigsReasonWrite")
  }

  if (applied) {
    return (
      <PopupDialogPanel title={t("features.mods.importModConfigsTitle")} isOpen={settings !== null} close={close}>
        <>
          <p>{t("features.mods.importModConfigsWritten", { count: applied.applied.length })}</p>
          {applied.skipped.length > 0 && <p className="text-sm text-zinc-300">{t("features.mods.importModConfigsSkipped", { count: applied.skipped.length })}</p>}

          {applied.failed.length > 0 && (
            <ul className="w-full flex flex-col gap-1 text-left">
              {applied.failed.slice(0, MAX_LISTED_FAILURES).map((entry) => (
                <li key={entry.name} className="rounded-sm bg-zinc-950/50 px-2 py-1">
                  <span className="block truncate font-bold">{entry.name}</span>
                  <span className="block text-sm text-zinc-300">{reasonFor(entry.reason)}</span>
                </li>
              ))}
            </ul>
          )}

          <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
            {applied.backupFolder && (
              <FormButton title={t("generic.openOnFileExplorer")} onClick={() => openPathInExplorer(applied.backupFolder)} variant="secondary" size="md" icon={<PiFolderOpenDuotone />} />
            )}
            <FormButton title={t("features.mods.summaryClose")} onClick={close} variant="primary" size="md" icon={<PiCheckCircleDuotone />} />
          </ButtonsWrapper>
        </>
      </PopupDialogPanel>
    )
  }

  return (
    <PopupDialogPanel title={t("features.mods.importModConfigsTitle")} isOpen={settings !== null} close={close}>
      <>
        <p>{t("features.mods.importModConfigsDesc", { count: carried.length })}</p>

        {/* Nothing is listed until the host has answered. An answer that has not arrived is not an
            empty folder, and rendering an empty list would tick every row below as new. Every carried
            file does get a row once it has: a capped list would be a lie twice over, since the files
            past the cap would be written with no row to agree to, and the line counting them reads as
            "not offered" while the answer would be "written anyway". */}
        {listing === undefined ? null : !listing.ok ? (
          <p>{listing.reason === "playing" ? t("features.mods.importModConfigsPlaying") : t("features.mods.importModConfigsUnreadable")}</p>
        ) : (
          <ul className="w-full max-h-[20rem] overflow-y-auto flex flex-col gap-1 text-left">
            {carried.map((name) => (
              <li key={name} className="flex items-center gap-2 rounded-sm bg-zinc-950/50 px-2 py-1">
                <Input
                  id={`import-mod-config-${name}`}
                  type="checkbox"
                  checked={chosen.includes(name)}
                  onChange={(e) => setChosen((current) => (e.target.checked ? [...current, name] : current.filter((key) => key !== name)))}
                />
                <label htmlFor={`import-mod-config-${name}`} className="flex-1 overflow-hidden">
                  <span className="block truncate font-bold">{name}</span>
                  <span className="block truncate text-sm text-zinc-300">
                    {existing.has(name.toLowerCase()) ? t("features.mods.importModConfigsReplaces") : t("features.mods.importModConfigsNew")}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {/* Only when the host answered. A listing that failed renders as an empty one here, and the
            player would read "the folder is empty" under "the folder could not be read". */}
        {listing?.ok && <p className="text-sm text-zinc-300">{listed.length > 0 ? t("features.mods.importModConfigsHave", { count: listed.length }) : t("features.mods.importModConfigsHaveNone")}</p>}

        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("features.mods.importModConfigsSkip")} onClick={close} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
          <FormButton title={t("features.mods.importModConfigsApply")} onClick={writeChosen} variant="primary" size="md" icon={<PiCheckCircleDuotone />} disabled={chosen.length === 0} />
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ImportModConfigsDialog
