import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { peakRssBytes } from "@domain/sessions/sampling"

/**
 * One session's series, drawn as inline SVG (#461).
 *
 * No chart library: two polylines and an axis is not a dependency, and the launcher has no other
 * chart to share one with. Memory and CPU sit on one time axis, memory solid and CPU dashed, so
 * the two are told apart by shape as well as by lightness.
 *
 * The memory axis starts at zero on purpose. Scaling it to the range of the readings would turn
 * ordinary noise into a cliff, and the one claim the flag makes is about proportion: a quarter more
 * memory has to look like a quarter more.
 */

const SPARKLINE_WIDTH = 96
const SPARKLINE_HEIGHT = 24

const CHART_WIDTH = 560
const CHART_HEIGHT = 220
const CHART_PADDING = 8

/** A CPU axis never shorter than one whole core, so a quiet session does not read as a busy one. */
const MIN_CPU_AXIS = 100

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** Bytes as a player reads them. Two significant places past a gibibyte, none below it. */
export function formatBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(2)} GiB` : `${Math.round(bytes / MIB)} MiB`
}

/** A duration as hours, minutes and seconds, dropping the parts that are zero. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60

  return [hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : "", hours === 0 && seconds > 0 ? `${seconds}s` : ""].filter(Boolean).join(" ") || "0s"
}

/** Turns readings into one `points` attribute, flat when there is nothing to scale against. */
function polylinePoints(samples: readonly PlaySample[], value: (sample: PlaySample) => number, ceiling: number, width: number, height: number, padding: number): string {
  const span = samples[samples.length - 1]?.t ?? 0
  const usableWidth = width - padding * 2
  const usableHeight = height - padding * 2

  return samples
    .map((sample, index) => {
      const x = padding + (span > 0 ? (sample.t / span) * usableWidth : (index / Math.max(1, samples.length - 1)) * usableWidth)
      const y = padding + usableHeight - (ceiling > 0 ? Math.min(1, value(sample) / ceiling) * usableHeight : 0)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
}

/**
 * The shape of one session's memory, at row size.
 *
 * Decorative: the row it sits in already carries the date, the length and the peak in text, so
 * this adds nothing a reader would otherwise miss and is hidden from assistive technology.
 */
export function SessionSparkline({ session }: Readonly<{ session: PlaySession }>): JSX.Element {
  const points = useMemo(() => polylinePoints(session.samples, (sample) => sample.rssBytes, peakRssBytes(session.samples), SPARKLINE_WIDTH, SPARKLINE_HEIGHT, 2), [session])

  return (
    <svg aria-hidden="true" focusable="false" viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`} className="w-24 h-6 shrink-0 text-zinc-200" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/**
 * The full chart, with the same readings offered again as a table for anyone who cannot read a
 * line. The table is the accessible equivalent, not a summary: it carries every point the line is
 * drawn from.
 */
export function SessionMemoryChart({ session }: Readonly<{ session: PlaySession }>): JSX.Element {
  const { t } = useTranslation()

  const peak = peakRssBytes(session.samples)
  const cpuCeiling = Math.max(MIN_CPU_AXIS, ...session.samples.map((sample) => sample.cpuPercent ?? 0))
  const hasCpu = session.samples.some((sample) => sample.cpuPercent !== undefined)

  const memoryPoints = polylinePoints(session.samples, (sample) => sample.rssBytes, peak, CHART_WIDTH, CHART_HEIGHT, CHART_PADDING)
  const cpuPoints = polylinePoints(session.samples, (sample) => sample.cpuPercent ?? 0, cpuCeiling, CHART_WIDTH, CHART_HEIGHT, CHART_PADDING)

  return (
    <div className="w-full flex flex-col gap-2">
      <svg
        role="img"
        aria-label={t("features.sessions.chartLabel", { peak: formatBytes(peak), duration: formatDuration(session.endedAt - session.startedAt) })}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="w-full h-56"
        preserveAspectRatio="none"
      >
        {hasCpu && (
          <g className="text-zinc-400">
            <polyline points={cpuPoints} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          </g>
        )}
        <g className="text-zinc-200">
          <polyline points={memoryPoints} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </g>
      </svg>

      <p className="text-xs text-zinc-400 text-left">
        {hasCpu ? t("features.sessions.chartLegend", { peak: formatBytes(peak) }) : t("features.sessions.chartLegendMemoryOnly", { peak: formatBytes(peak) })}
      </p>

      <table className="sr-only">
        <caption>{t("features.sessions.tableCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("features.sessions.tableTime")}</th>
            <th scope="col">{t("features.sessions.tableMemory")}</th>
            <th scope="col">{t("features.sessions.tableCpu")}</th>
          </tr>
        </thead>
        <tbody>
          {session.samples.map((sample) => (
            <tr key={sample.t}>
              <td>{formatDuration(sample.t)}</td>
              <td>{formatBytes(sample.rssBytes)}</td>
              <td>{sample.cpuPercent === undefined ? t("features.sessions.cpuNotMeasured") : `${Math.round(sample.cpuPercent)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
