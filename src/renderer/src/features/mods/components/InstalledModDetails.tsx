import { useId, useMemo, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { PiXDuotone } from "react-icons/pi"
import { FiExternalLink, FiLoader } from "react-icons/fi"
import clsx from "clsx"

import { evaluateModCompatibility } from "@domain/mods/compatibility"
import { modDescriptionParagraphs } from "@domain/mods/moddb"
import { readModSide, type ModSide } from "@domain/mods/modinfo"

import { useModReleaseCatalog } from "@renderer/features/mods/hooks/useModReleaseCatalog"
import { useExternalLinks } from "@renderer/features/mods/hooks/useExternalLinks"
import { COMPATIBILITY_STYLE } from "@renderer/features/mods/components/ModReleaseList"

import { ListWrapper } from "@renderer/components/ui/List"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { ReloadButton } from "@renderer/components/ui/StickyMenu"

const SIDE_LABEL_KEYS: Readonly<Record<ModSide, string>> = { client: "generic.client", server: "generic.server", both: "generic.both" }

/**
 * The fill under every verdict word. The verdict hues clear 4.5:1 on it and not on the bare panel
 * (lime-600 reads 3.98:1 there), which tests/text-contrast.test.ts reads from here.
 */
const RELEASE_ROW_FILL = "bg-zinc-950/50"

/** A release's date in the player's language, or nothing when the ModDB sent none that parses. */
function releaseDate(created: unknown, language: string | undefined): string | undefined {
  if (typeof created !== "string") return undefined
  const date = new Date(created)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString(language)
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>): JSX.Element {
  return (
    <>
      <dt className="text-zinc-400">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** The verdict word for one release on this Installation, in the same hue the release table uses. */
function Verdict({ tags, gameVersion }: Readonly<{ tags: string[]; gameVersion: string }>): JSX.Element {
  const { t } = useTranslation()
  const style = COMPATIBILITY_STYLE[evaluateModCompatibility(tags, gameVersion)]

  return (
    <span className={clsx("shrink-0 text-xs", style.className)} title={t(style.titleKey)}>
      {t(style.labelKey)}
    </span>
  )
}

/**
 * One installed Mod in full, beside the Manage Mods list: what its own file says, and what the ModDB
 * says about it when it knows it.
 *
 * Read-only on purpose. The row stays on screen next to it with the enable, update and delete
 * actions, so each action has one place. Nothing here raises a notification or writes a log line.
 */
function InstalledModDetails({
  iMod,
  gameVersion,
  headingRef,
  onClose
}: Readonly<{
  iMod: InstalledModType
  /** The Installation's game version, which every verdict is judged against. */
  gameVersion: string
  /** Focused by the page when the player opens the panel, and only then. */
  headingRef: RefObject<HTMLHeadingElement>
  onClose: () => void
}>): JSX.Element {
  const { t, i18n } = useTranslation()
  const { openModOnModDb } = useExternalLinks()
  const headingId = useId()
  const releasesId = useId()

  // The scan already asked the ModDB. Only a Mod it came back without is asked about again, and that
  // lookup is also the only one that can tell a clean 404 from a ModDB that could not be reached.
  const lookup = useModReleaseCatalog(iMod._mod ? null : iMod.modid)
  const detail = iMod._mod ?? lookup.mod ?? undefined

  const moddbParagraphs = useMemo(() => modDescriptionParagraphs(detail?.text), [detail?.text])
  const description = moddbParagraphs.length > 0 ? moddbParagraphs : iMod.description ? [iMod.description] : []

  const side = readModSide(iMod.side)
  const count = new Intl.NumberFormat(i18n.resolvedLanguage)
  const installedRelease = detail?.releases.find((release) => release.modversion === iMod.version)

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    // Every dialog this page opens renders outside the aside's React tree. One rendered inside would
    // bubble its own Escape up to here and close the panel along with itself.
    if (event.key === "Escape") onClose()
  }

  return (
    <aside aria-labelledby={headingId} onKeyDown={onKeyDown} className="w-80 xl:w-96 shrink-0 h-full py-2 pr-2">
      <ListWrapper className="w-full h-full">
        {/* The wrapper's scrim is absolute and h-full: it would scroll away if the wrapper itself scrolled. */}
        <div className="relative h-full overflow-y-auto flex flex-col gap-3 p-1">
          <div className="flex gap-3 items-start">
            <div className={clsx("shrink-0", !iMod.enabled && "opacity-50 grayscale")}>
              {iMod._image ? (
                <img src={`cachemodimg:${iMod._image}`} alt="" className="w-16 h-16 object-cover rounded-sm" />
              ) : (
                <div className="w-16 h-16 bg-zinc-900 rounded-sm shadow-sm shadow-zinc-950" />
              )}
            </div>

            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-bold text-lg break-words">
                {detail?.name ?? iMod.name}
              </h2>
              <p className="text-sm">
                v{iMod.version}
                {!iMod.enabled && (
                  <>
                    <span> · </span>
                    <span className="uppercase tracking-wide text-zinc-300">{t("features.mods.disabledLabel")}</span>
                  </>
                )}
              </p>
            </div>

            <NormalButton title={t("features.mods.closeModDetails")} onClick={onClose} className="p-1 text-lg shrink-0">
              <PiXDuotone />
            </NormalButton>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-sm">
            {iMod.authors && iMod.authors.length > 0 && <Fact label={t("generic.authors")}>{iMod.authors.join(", ")}</Fact>}
            {iMod.contributors && iMod.contributors.length > 0 && <Fact label={t("generic.contributors")}>{iMod.contributors.join(", ")}</Fact>}
            {side && <Fact label={t("features.mods.sideLabel")}>{t(SIDE_LABEL_KEYS[side])}</Fact>}
            {detail?.author && <Fact label={t("generic.author")}>{detail.author}</Fact>}
            {detail?.downloads !== undefined && <Fact label={t("generic.downloads")}>{count.format(detail.downloads)}</Fact>}
            {detail?.follows !== undefined && <Fact label={t("generic.follows")}>{count.format(detail.follows)}</Fact>}
            {detail && detail.tags.length > 0 && <Fact label={t("generic.tags")}>{detail.tags.join(", ")}</Fact>}
          </dl>

          {detail && (
            <NormalButton title={t("features.mods.openOnTheModDB")} onClick={() => openModOnModDb(detail.assetid)} variant="secondary" className="self-start">
              <FiExternalLink />
              <span>{t("features.mods.openOnTheModDB")}</span>
            </NormalButton>
          )}

          {!iMod._mod && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <p role="status" className="flex items-center gap-2">
                {lookup.notFound ? (
                  t("features.mods.notOnModDb")
                ) : lookup.failed ? (
                  t("features.mods.detailsLoadFailed")
                ) : lookup.loading ? (
                  <>
                    <FiLoader className="animate-spin shrink-0" />
                    {t("features.mods.detailsLoading")}
                  </>
                ) : null}
              </p>
              {lookup.failed && !lookup.notFound && <ReloadButton onClick={lookup.retry} reloading={lookup.loading} />}
            </div>
          )}

          {description.length > 0 && (
            <div className="flex flex-col gap-2 text-sm break-words">
              {description.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          )}

          {detail && (
            <>
              <section aria-label={t("features.mods.installedVersion")} className={clsx("flex flex-col gap-1 rounded-sm p-2 text-sm", RELEASE_ROW_FILL)}>
                <p className="flex gap-2 items-baseline">
                  <span className="text-zinc-400">{t("features.mods.installedVersion")}</span>
                  <span className="flex-1 font-bold">{iMod.version}</span>
                  {installedRelease && <Verdict tags={installedRelease.tags} gameVersion={gameVersion} />}
                </p>
                {installedRelease ? <p className="text-xs break-words">{installedRelease.tags.join(", ")}</p> : <p className="text-xs">{t("features.mods.installedReleaseNotListed")}</p>}
              </section>

              <div className="flex flex-col gap-1">
                <h3 id={releasesId} className="text-sm font-bold">
                  {t("features.mods.releases")}
                </h3>
                {/* Read-only: the row's Update button and its popup stay the one way to change version. */}
                <ul aria-labelledby={releasesId} className="flex flex-col gap-1">
                  {detail.releases.map((release, index) => {
                    const date = releaseDate(release.created, i18n.resolvedLanguage)
                    return (
                      <li key={index} className={clsx("flex flex-col gap-1 rounded-sm p-2 text-sm", RELEASE_ROW_FILL)}>
                        <p className="flex gap-2 items-baseline">
                          <span className="font-bold">{release.modversion}</span>
                          <span className="flex-1 text-xs uppercase tracking-wide text-zinc-300">{release.modversion === iMod.version && t("generic.installed")}</span>
                          <Verdict tags={release.tags} gameVersion={gameVersion} />
                        </p>
                        {date && <p className="text-xs text-zinc-400">{date}</p>}
                        {release.tags.length > 0 && <p className="text-xs break-words">{release.tags.join(", ")}</p>}
                      </li>
                    )
                  })}
                </ul>
              </div>
            </>
          )}
        </div>
      </ListWrapper>
    </aside>
  )
}

export default InstalledModDetails
