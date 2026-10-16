import { describe, expect, it, onTestFinished } from "vitest"
import { act, renderHook } from "@testing-library/react"

import { useDateFormat } from "@renderer/hooks/useDateFormat"
import { changeLanguage } from "@renderer/i18n"

/** 4 October 2026 on the clock of whatever time zone the suite runs in. */
const MOMENT = new Date(2026, 9, 4, 13, 54, 56).getTime()

describe("useDateFormat", () => {
  it("writes a moment the way the current language does, and follows a switch without a remount", async () => {
    const { result } = renderHook(() => useDateFormat())

    expect(result.current.formatDateTime(MOMENT)).toMatch(/^10\/4\/2026/)

    onTestFinished(async () => {
      await changeLanguage("en-US")
    })
    await act(async () => {
      expect(await changeLanguage("fr-FR")).toBe(true)
    })

    expect(result.current.formatDateTime(MOMENT)).toMatch(/^04\/10\/2026/)
  })

  it("hands its options to toLocaleString", () => {
    const { result } = renderHook(() => useDateFormat())

    expect(result.current.formatDateTime(MOMENT, { dateStyle: "long" })).toBe("October 4, 2026")
  })

  it("reads a date out of the ModDB's text, and out of nothing else", () => {
    const { formatDate } = renderHook(() => useDateFormat()).result.current

    expect(formatDate("2024-05-01 10:00:00")).toBe("5/1/2024")
    // A release with no date, or one that does not parse, has no date to show, and never "Invalid Date".
    expect(formatDate("")).toBeUndefined()
    expect(formatDate("not a date")).toBeUndefined()
    // Both of these would read as the epoch if anything but text were let through.
    expect(formatDate(null)).toBeUndefined()
    expect(formatDate(0)).toBeUndefined()
  })
})
