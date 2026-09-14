import { useId, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { PiCaretDownDuotone, PiCaretRightDuotone } from "react-icons/pi"
import clsx from "clsx"

import { checkModHealth } from "@domain/mods/health"
import { sameModid } from "@domain/mods/installedFilters"
import type { ModHealthFinding, ModHealthSection } from "@domain/mods/health"

import type { InstalledModActions } from "@renderer/features/mods/hooks/useInstalledModActions"

import { ListGroup, ListItem, ListWrapper } from "@renderer/components/ui/List"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { NormalButton } from "@renderer/components/ui/Buttons"

/**
 * The fill under every section heading. Two of the four hues below do not clear 4.5:1 on the bare
 * panel (lime-600 reads 3.98:1 there and red-400 4.22:1), which is the same shortfall the detail
 * panel's release rows have and the same fill that answers it (InstalledModDetails' RELEASE_ROW_FILL).
 * tests/text-contrast.test.ts reads the class from here and measures all four hues on it.
 */
const SECTION_HEADING_FILL = "bg-zinc-950/50"

/**
 * The four headings, worst first, each in the hue the release table already gives that verdict
 * (ModReleaseList's COMPATIBILITY_STYLE): red for what will not load, yellow for what nobody has
 * vouched for, lime for an update that is there for the taking.
 */
const SECTIONS: readonly { section: ModHealthSection; titleKey: string; className: string }[] = [
  { section: "blocking", titleKey: "features.mods.healthBlockingTitle", className: "text-red-400" },
  { section: "duplicate", titleKey: "features.mods.healthDuplicateTitle", className: "text-yellow-400" },
  { section: "undeclared", titleKey: "features.mods.healthUndeclaredTitle", className: "text-yellow-400" },
  { section: "update", titleKey: "features.mods.healthUpdateTitle", className: "text-lime-600" }
]

/** Names are read off the ModDB and off file names, so nothing here may be escaped into entities. */
const RAW = { interpolation: { escapeValue: false } }

/**
 * Everything wrong with one Installation's Mods, above the list itself.
 *
 * There is no button to run it. The scan behind this page already fetches every Mod's ModDB detail,
 * so the whole verdict is a derivation of what the page is holding, and a button would only add a
 * state machine plus the question of how stale its last answer is. The panel always describes the
 * last scan, and the reload button at the top of the page is what re-runs it.
 *
 * It opens itself only when something will actually stop the game from loading. Anything less
 * starts collapsed, for #431's reason: nothing pushes the Mod list off the first screen except the
 * one category whose outcome is close to certain.
 *
 * @param installedMods Everything the last scan read, disabled copies included.
 * @param unreadableCount Archives the scan could not read at all, counted rather than left silent.
 * @param gameVersion The Installation's game version, without a leading "v".
 * @param suspended Mod ids the player holds, which drop every finding about them.
 * @param labelOf The Mod's name, with its file name added when a second copy shares it (batch.labelOf).
 * @param actions The per-Mod actions the page already builds: turn on, delete, hold.
 * @param onUpdate Opens the install popup on a mod id, for an update or for a dependency nobody has yet.
 * @param onUpdateAll Update all over the same whole folder the lines above are derived from, wired to
 *   the update section's heading. Handing it the filtered list instead let a search quietly drop Mods
 *   the heading had just listed, and the summary that followed said nothing about them.
 */
function ModHealthPanel({
  installedMods,
  unreadableCount,
  gameVersion,
  suspended,
  labelOf,
  actions,
  onUpdate,
  onUpdateAll
}: Readonly<{
  installedMods: readonly InstalledModType[]
  unreadableCount: number
  gameVersion: string
  suspended: readonly string[]
  labelOf: (iMod: InstalledModType) => string
  actions: InstalledModActions
  onUpdate: (mod: { modid: string; name?: string }) => void
  onUpdateAll: () => void
}>): JSX.Element | null {
  const { t } = useTranslation()
  const bodyId = useId()

  // Null until the player says otherwise, so the panel can open itself when the first scan lands
  // and still do as it is told from the first click onwards.
  const [openedByHand, setOpenedByHand] = useState<boolean | null>(null)

  const findings = useMemo(
    () =>
      checkModHealth({
        mods: installedMods.map((iMod) => ({
          modid: iMod.modid,
          version: iMod.version,
          path: iMod.path,
          enabled: iMod.enabled,
          dependencies: iMod.dependencies,
          releases: iMod._mod?.releases
        })),
        gameVersion,
        suspended
      }),
    [installedMods, gameVersion, suspended]
  )

  const byPath = new Map(installedMods.map((iMod) => [iMod.path, iMod]))

  /** The Mod a finding is about, named the way its row is named. Falls back to the mod id it declares. */
  function nameAt(path: string, modid: string): string {
    const iMod = byPath.get(path)
    return iMod ? labelOf(iMod) : modid
  }

  // A Mod the ModDB never answered for gets neither of the two verdicts that need it, so the
  // count has to be said out loud. Offline and not listed are indistinguishable from here, and
  // the sentence is true of both. Only the copies that are actually checked are counted.
  const notCheckedCount = installedMods.filter((iMod) => iMod.enabled && !iMod._mod).length
  const problems = findings.filter((finding) => finding.section !== "update").length
  const updates = findings.length - problems

  if (findings.length < 1 && notCheckedCount < 1 && unreadableCount < 1) return null

  const open = openedByHand ?? findings.some((finding) => finding.section === "blocking")

  /** The one sentence a finding reads as, already interpolated. */
  function sentence(finding: ModHealthFinding): string {
    const mod = nameAt(finding.path, finding.modid)

    switch (finding.kind) {
      case "dependency-missing":
        return finding.required
          ? t("features.mods.healthDependencyMissingVersion", { mod, dependency: finding.dependency, required: finding.required, ...RAW })
          : t("features.mods.healthDependencyMissing", { mod, dependency: finding.dependency, ...RAW })
      case "dependency-disabled":
        return t("features.mods.healthDependencyDisabled", { mod, dependency: finding.dependency, ...RAW })
      case "dependency-outdated":
        return t("features.mods.healthDependencyOutdated", { mod, dependency: finding.dependency, required: finding.required, found: finding.found, ...RAW })
      case "game-version-below":
        return t("features.mods.healthGameVersionBelow", { mod, required: finding.required, gameVersion, ...RAW })
      case "duplicate-modid":
        return t("features.mods.healthDuplicate", { mod, other: nameAt(finding.other, finding.modid), ...RAW })
      case "undeclared":
        return t("features.mods.healthUndeclaredLine", { mod, gameVersion, ...RAW })
      case "update":
        return t("features.mods.healthUpdateLine", { mod, version: finding.toVersion, ...RAW })
    }
  }

  /** The one action that fixes a finding, or nothing when only the player can decide. */
  function fix(finding: ModHealthFinding): JSX.Element | null {
    const iMod = byPath.get(finding.path)

    switch (finding.kind) {
      case "dependency-missing":
        // The popup takes a mod id and derives the installed copy by find, so a dependency nobody
        // has yet arrives with no old copy and reads as a plain install.
        return (
          <FormButton title={t("features.mods.healthInstallDependency", { dependency: finding.dependency, ...RAW })} onClick={() => onUpdate({ modid: finding.dependency })}>
            {t("features.mods.healthInstallDependency", { dependency: finding.dependency, ...RAW })}
          </FormButton>
        )
      case "dependency-disabled": {
        const copy = installedMods.find((candidate) => !candidate.enabled && sameModid(candidate.modid, finding.dependency))
        if (!copy) return null
        return (
          <FormButton title={t("features.mods.healthEnableDependency")} busy={actions.isBusy(copy.path)} onClick={() => actions.toggleEnabled(copy)}>
            {t("features.mods.healthEnableDependency")}
          </FormButton>
        )
      }
      case "dependency-outdated":
        return (
          <FormButton title={t("features.mods.healthInstallDependency", { dependency: finding.dependency, ...RAW })} onClick={() => onUpdate({ modid: finding.dependency })}>
            {t("features.mods.healthInstallDependency", { dependency: finding.dependency, ...RAW })}
          </FormButton>
        )
      case "duplicate-modid":
        // Delete, never "delete the other one": only the player knows which of the two they meant
        // to keep, so each line offers to remove the copy it is about.
        return iMod ? (
          <FormButton title={t("generic.delete")} busy={actions.isBusy(iMod.path)} onClick={() => actions.requestDelete(iMod)}>
            {t("generic.delete")}
          </FormButton>
        ) : null
      case "update":
        return iMod ? (
          <FormButton title={t("generic.update")} onClick={() => onUpdate(iMod)}>
            {t("generic.update")}
          </FormButton>
        ) : null
      default:
        return null
    }
  }

  return (
    <ListWrapper className="w-full">
      <ListGroup>
        <div className="flex flex-wrap gap-2 items-center justify-center">
          <FormButton title={t("features.mods.healthTitle")} variant="secondary" className="p-1 w-fit h-8" ariaExpanded={open} aria-controls={bodyId} onClick={() => setOpenedByHand(!open)}>
            {open ? <PiCaretDownDuotone className="text-xl" /> : <PiCaretRightDuotone className="text-xl" />}
            <p className="text-lg font-bold">{t("features.mods.healthTitle")}</p>
          </FormButton>

          <p className="text-zinc-400">
            {findings.length < 1
              ? t("features.mods.healthClean")
              : [problems > 0 && t("features.mods.healthProblems", { count: problems }), updates > 0 && t("features.mods.healthUpdates", { count: updates })].filter(Boolean).join(", ")}
          </p>
        </div>

        <div id={bodyId} hidden={!open} className="flex flex-col gap-3">
          {SECTIONS.map(({ section, titleKey, className }) => {
            const lines = findings.filter((finding) => finding.section === section)
            if (lines.length < 1) return null

            return (
              <div key={section} className="flex flex-col gap-1">
                <div className={clsx("flex flex-wrap gap-2 items-center justify-between rounded-sm p-2", SECTION_HEADING_FILL)}>
                  <h3 className={clsx("font-bold", className)}>{t(titleKey)}</h3>
                  {section === "update" && (
                    <FormButton title={t("features.mods.healthUpdateThese")} onClick={onUpdateAll}>
                      {t("features.mods.healthUpdateThese")}
                    </FormButton>
                  )}
                </div>

                <ul className="flex flex-col gap-1">
                  {lines.map((finding) => (
                    <ListItem key={`${finding.kind}-${finding.path}-${"dependency" in finding ? finding.dependency : finding.section}`} className="p-2">
                      <div className="flex flex-wrap gap-2 items-center justify-between">
                        <p className="min-w-0 break-words text-sm">{sentence(finding)}</p>
                        <div className="flex gap-1 items-center shrink-0">
                          {fix(finding)}
                          <NormalButton title={t("features.mods.healthHold")} variant="ghost" onClick={() => actions.toggleSuspended(finding.modid)}>
                            {t("features.mods.healthHold")}
                          </NormalButton>
                        </div>
                      </div>
                    </ListItem>
                  ))}
                </ul>
              </div>
            )
          })}

          {notCheckedCount > 0 && <p className="text-zinc-400 text-sm">{t("features.mods.healthNotChecked", { count: notCheckedCount })}</p>}
          {unreadableCount > 0 && <p className="text-zinc-400 text-sm">{t("features.mods.healthUnreadable", { count: unreadableCount })}</p>}
        </div>
      </ListGroup>
    </ListWrapper>
  )
}

export default ModHealthPanel
