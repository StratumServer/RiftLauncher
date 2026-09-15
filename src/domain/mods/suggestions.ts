import { evaluateModCompatibility, newestCompatibleRelease, type ModCompatibilityVerdict } from "./compatibility"
import { listingDeclaresModid, installedCopiesOf } from "./installedFilters"
import { readModSide } from "./modinfo"

/** The number of cards shown in the suggestions row. */
export const MAX_SUGGESTIONS = 6

/** The maximum number of detail pages one refresh may ask the ModDB for. */
export const MAX_SUGGESTION_DETAIL_LOOKUPS = 20

/** Dismissed listing ids are history, not an unbounded event log. */
export const MAX_DISMISSED_MOD_SUGGESTIONS = 1_000

/** Named weights keep the heuristic small enough to audit and change deliberately. */
export const SUGGESTION_SCORE_WEIGHTS = {
  categoryOverlap: 32,
  trending: 24,
  // Popularity is useful context, but a catalog counter must not drown out a direct category match.
  popularity: 8,
  recency: 16
} as const

const DOWNLOAD_LOG_CEILING = 1_000_000
const FOLLOW_LOG_CEILING = 100_000
const TRENDING_LOG_CEILING = 1_000
const RECENCY_HALF_LIFE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1_000

/** The local data needed to rank one Installation without reading from disk. */
export interface SuggestionInstallation {
  readonly id: string
  readonly version: string
  readonly mods: readonly InstalledModType[]
}

/** The signal values are exposed so the explanation can be checked against the score. */
export interface SuggestionSignals {
  readonly categoryOverlap: number
  readonly trending: number
  readonly popularity: number
  readonly recency: number
  readonly otherInstallation: boolean
}

export type SuggestionReason =
  | { readonly kind: "other-installation" }
  | { readonly kind: "matching-tags"; readonly tags: readonly string[] }
  | { readonly kind: "trending" }
  | { readonly kind: "popular" }
  | { readonly kind: "recent" }
  | { readonly kind: "catalog" }

/** A catalog listing with its local, explainable ranking result. */
export interface RankedSuggestion {
  readonly mod: DownloadableModOnListType
  readonly score: number
  readonly signals: SuggestionSignals
  readonly reason: SuggestionReason
}

/** A ranked listing whose detail proved compatible with the target game version. */
export interface ResolvedSuggestion extends RankedSuggestion {
  readonly detail: DownloadableModType
  readonly compatibility: ModCompatibilityVerdict
}

export interface RankSuggestionsInput {
  readonly catalog: readonly DownloadableModOnListType[]
  readonly installation: SuggestionInstallation
  readonly otherInstallations: readonly SuggestionInstallation[]
  readonly targetGameVersion: string
  readonly dismissedListingIds: readonly number[]
  /** Epoch milliseconds. Defaults to the wall clock for production; tests pass a fixed value. */
  readonly now?: number
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Maps an untrusted catalog counter onto 0..1 without letting it flatten every other signal. */
function boundedLog(value: unknown, ceiling: number): number {
  const positive = positiveNumber(value)
  return Math.min(1, Math.log1p(positive) / Math.log1p(ceiling))
}

function recency(lastReleased: unknown, now: number): number {
  if (typeof lastReleased !== "string") return 0
  const released = Date.parse(lastReleased)
  if (!Number.isFinite(released)) return 0

  const ageDays = Math.max(0, now - released) / DAY_MS
  return 1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS)
}

function compatibleGameVersion(version: string, target: string): boolean {
  return evaluateModCompatibility([version], target) !== "undeclared"
}

function categoryTagsForInstallation(catalog: readonly DownloadableModOnListType[], mods: readonly InstalledModType[]): Set<string> {
  const tags = new Set<string>()
  for (const listing of catalog) {
    if (!mods.some((mod) => listingDeclaresModid(listing.modidstrs, mod.modid))) continue
    for (const tag of listing.tags) tags.add(tag.toLowerCase())
  }
  return tags
}

function otherInstallationMatch(mod: DownloadableModOnListType, input: RankSuggestionsInput): boolean {
  return input.otherInstallations.some(
    (other) => compatibleGameVersion(other.version, input.targetGameVersion) && other.mods.some((installed) => installed.enabled && listingDeclaresModid(mod.modidstrs, installed.modid))
  )
}

function reasonFor(signals: SuggestionSignals, matchingTags: readonly string[]): SuggestionReason {
  if (signals.otherInstallation) return { kind: "other-installation" }

  const weighted: Array<{ value: number; reason: SuggestionReason }> = [
    { value: signals.categoryOverlap, reason: { kind: "matching-tags", tags: matchingTags } },
    { value: signals.trending, reason: { kind: "trending" } },
    { value: signals.popularity, reason: { kind: "popular" } },
    { value: signals.recency, reason: { kind: "recent" } }
  ]
  const winning = weighted.reduce((best, signal) => (signal.value > best.value ? signal : best), { value: 0, reason: { kind: "catalog" } })
  return winning.reason
}

/**
 * Ranks a complete ModDB catalog locally.
 *
 * This is intentionally a sum of bounded signals, with one separate tier for a compatible enabled
 * copy from another Installation. It never reads a file or makes a request, so every suggestion can
 * be explained from the data the caller already owns.
 */
export function rankSuggestions(input: RankSuggestionsInput): RankedSuggestion[] {
  const dismissed = new Set(input.dismissedListingIds)
  const installedHere = input.installation.mods
  const installedTags = categoryTagsForInstallation(input.catalog, installedHere)
  const now = input.now ?? Date.now()

  return input.catalog
    .filter((mod) => typeof mod.type === "string" && mod.type.toLowerCase() === "mod")
    .filter((mod) => {
      const side = readModSide(typeof mod.side === "string" ? mod.side : undefined)
      return side === "client" || side === "both"
    })
    .filter((mod) => !dismissed.has(mod.modid))
    .filter((mod) => installedCopiesOf(mod.modidstrs, installedHere).length === 0)
    .map((mod) => {
      const matchingTags = mod.tags.filter((tag) => installedTags.has(tag.toLowerCase()))
      const categoryOverlap = Math.min(matchingTags.length, 3) / 3
      const trending = boundedLog(mod.trendingpoints, TRENDING_LOG_CEILING)
      const popularity = boundedLog(mod.downloads, DOWNLOAD_LOG_CEILING) * 0.6 + boundedLog(mod.follows, FOLLOW_LOG_CEILING) * 0.4
      const recent = recency(mod.lastreleased, now)
      const otherInstallation = otherInstallationMatch(mod, input)
      const signals: SuggestionSignals = { categoryOverlap, trending, popularity, recency: recent, otherInstallation }
      const score =
        categoryOverlap * SUGGESTION_SCORE_WEIGHTS.categoryOverlap +
        trending * SUGGESTION_SCORE_WEIGHTS.trending +
        popularity * SUGGESTION_SCORE_WEIGHTS.popularity +
        recent * SUGGESTION_SCORE_WEIGHTS.recency

      return { mod, score, signals, reason: reasonFor(signals, matchingTags) }
    })
    .sort((one, other) => {
      if (one.signals.otherInstallation !== other.signals.otherInstallation) return one.signals.otherInstallation ? -1 : 1
      if (one.score !== other.score) return other.score - one.score
      return one.mod.modid - other.mod.modid
    })
}

export interface ResolveSuggestionsInput {
  readonly candidates: readonly RankedSuggestion[]
  readonly targetGameVersion: string
  readonly getDetail: (listingId: number) => Promise<DownloadableModType | undefined>
  readonly signal?: AbortSignal
  /** Maximum number of compatible details to retain. Defaults to the visible row size. */
  readonly maxSuggestions?: number
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Confirms the ranked head one detail at a time, preserving rank order and respecting both budgets.
 * A cancellation returns no partial row because a stale refresh must never repaint over a newer one.
 */
export async function resolveSuggestions(input: ResolveSuggestionsInput): Promise<ResolvedSuggestion[]> {
  const accepted: ResolvedSuggestion[] = []
  const candidates = input.candidates.slice(0, MAX_SUGGESTION_DETAIL_LOOKUPS)
  const maxSuggestions = input.maxSuggestions ?? MAX_SUGGESTIONS

  for (const candidate of candidates) {
    if (isCancelled(input.signal)) return []

    let detail: DownloadableModType | undefined
    try {
      detail = await input.getDetail(candidate.mod.modid)
    } catch {
      detail = undefined
    }

    if (isCancelled(input.signal)) return []
    if (!detail) continue

    const release = newestCompatibleRelease(detail.releases, input.targetGameVersion)
    if (!release) continue

    accepted.push({ ...candidate, detail, compatibility: evaluateModCompatibility(release.tags, input.targetGameVersion) })
    if (accepted.length >= maxSuggestions) break
  }

  return accepted
}
