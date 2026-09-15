import { FiLoader } from "react-icons/fi"
import { PiArrowClockwise, PiX } from "react-icons/pi"
import { useTranslation } from "react-i18next"

import type { ResolvedSuggestion } from "@domain/mods/suggestions"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { GridGroup, GridWrapper } from "@renderer/components/ui/Grid"
import ModListCard, { type ModCardAction } from "@renderer/features/mods/components/ModListCard"
import { quickInstallKey } from "@renderer/features/mods/hooks/useInstalledModActions"

function reasonText(suggestion: ResolvedSuggestion, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (suggestion.reason.kind) {
    case "other-installation":
      return t("features.mods.suggestionsReasonOtherInstallation")
    case "matching-tags":
      return t("features.mods.suggestionsReasonMatchingTags", { count: suggestion.reason.tags.length })
    case "trending":
      return t("features.mods.suggestionsReasonTrending")
    case "popular":
      return t("features.mods.suggestionsReasonPopular")
    case "recent":
      return t("features.mods.suggestionsReasonRecent")
    case "catalog":
      return t("features.mods.suggestionsReasonCatalog")
  }
}

/** The opt-in and compact suggestion row above the ordinary ModDB grid. */
function ModSuggestions({
  consent,
  installation,
  suggestions,
  loading,
  selecting,
  pickedIds,
  isModFav,
  isBusy,
  onEnable,
  onRefresh,
  onDismiss,
  onAddAll,
  onSelect,
  onToggleFav,
  onOpenModDb,
  onAction
}: Readonly<{
  consent: boolean | null
  installation: InstallationType | undefined
  suggestions: readonly ResolvedSuggestion[]
  loading: boolean
  selecting: boolean
  pickedIds?: ReadonlySet<number>
  isModFav: (mod: DownloadableModOnListType) => boolean
  isBusy: (key: string) => boolean
  onEnable: () => void
  onRefresh: () => void
  onDismiss: (listingId: number) => void
  onAddAll: (mods: readonly DownloadableModOnListType[]) => void | Promise<void>
  onSelect: (mod: DownloadableModOnListType) => void
  onToggleFav: (mod: DownloadableModOnListType) => void
  onOpenModDb: (mod: DownloadableModOnListType) => void
  onAction: (mod: DownloadableModOnListType, action: ModCardAction) => void | Promise<unknown>
}>): JSX.Element | null {
  const { t } = useTranslation()

  if (!installation || consent === false) return null

  if (consent === null) {
    return (
      <section className="mx-auto w-full max-w-4xl rounded-md border border-vsl/30 bg-zinc-950/40 p-4 text-center">
        <h2 className="text-lg font-bold">{t("features.mods.suggestionsOptInTitle")}</h2>
        <p className="mx-auto mt-1 max-w-2xl text-sm text-zinc-300">{t("features.mods.suggestionsOptInBody")}</p>
        <FormButton title={t("features.mods.suggestionsOptInButton")} variant="primary" className="mt-3" onClick={onEnable}>
          {t("features.mods.suggestionsOptInButton")}
        </FormButton>
      </section>
    )
  }

  if (!loading && suggestions.length === 0) return null

  const headingId = "mod-suggestions-heading"
  return (
    <section role="region" aria-labelledby={headingId} className="mx-auto w-full max-w-6xl">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-2">
        <div>
          <h2 id={headingId} className="text-lg font-bold">
            {t("features.mods.suggestionsTitle", { installation: installation.name })}
          </h2>
          <p className="text-xs text-zinc-400">{t("features.mods.suggestionsFooter")}</p>
        </div>
        <div className="flex items-center gap-2">
          <FormButton title={t("features.mods.suggestionsRefresh")} variant="ghost" onClick={onRefresh} disabled={loading}>
            <PiArrowClockwise />
          </FormButton>
          <FormButton title={t("features.mods.suggestionsAddAll")} variant="primary" onClick={() => onAddAll(suggestions.map(({ mod }) => mod))} disabled={loading || suggestions.length === 0}>
            {t("features.mods.suggestionsAddAll")}
          </FormButton>
        </div>
      </div>

      <GridWrapper>
        <GridGroup>
          {loading && <FiLoader aria-label={t("features.mods.suggestionsLoading")} className="animate-spin text-3xl text-zinc-400" />}
          {suggestions.map((suggestion) => (
            <ModListCard
              key={suggestion.mod.modid}
              mod={suggestion.mod}
              installed={false}
              isFav={isModFav(suggestion.mod)}
              onSelect={onSelect}
              onToggleFav={onToggleFav}
              onOpenModDb={onOpenModDb}
              installationId={installation.id}
              busy={isBusy(quickInstallKey(suggestion.mod.modid))}
              onAction={onAction}
              picked={selecting ? pickedIds?.has(suggestion.mod.modid) : undefined}
              footer={
                <div className="flex items-center justify-between gap-2 px-2 pb-2 text-xs text-zinc-300">
                  <span>{reasonText(suggestion, t)}</span>
                  <FormButton
                    title={t("features.mods.suggestionsDismiss")}
                    ariaLabel={t("features.mods.suggestionsDismiss")}
                    variant="ghost"
                    className="shrink-0 p-1"
                    onClick={(event) => {
                      event.stopPropagation()
                      onDismiss(suggestion.mod.modid)
                    }}
                  >
                    <PiX />
                  </FormButton>
                </div>
              }
            />
          ))}
        </GridGroup>
      </GridWrapper>
    </section>
  )
}

export default ModSuggestions
