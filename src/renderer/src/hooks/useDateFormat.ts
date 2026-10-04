import { useTranslation } from "react-i18next"

interface DateFormat {
  /** A moment, date and time, on the player's own clock. `options` is `toLocaleString`'s, for a screen that wants a longer spelling. */
  formatDateTime: (when: number, options?: Intl.DateTimeFormatOptions) => string
  /** A date alone from the text the ModDB sends, or nothing when it sent none that parses, so a row says nothing rather than "Invalid Date". */
  formatDate: (when: unknown) => string | undefined
}

/**
 * The one place that decides which language a date is written in.
 *
 * The order of day and month is the one thing a reader cannot guess: "4/10/2026" is 4 October to a
 * Spanish reader and 10 April to an English one. Four screens used to pin a Spanish locale of their
 * own whatever the language was, and Manage Worlds pinned none, so it wrote the system's (#616). A
 * screen that formats through here has no locale to get wrong.
 *
 * The language is `resolvedLanguage`, the one the page's strings were found in, so a date never
 * speaks a language the sentence around it does not.
 */
export function useDateFormat(): DateFormat {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage

  return {
    formatDateTime: (when, options) => new Date(when).toLocaleString(language, options),
    formatDate: (when) => {
      if (typeof when !== "string") return undefined
      const date = new Date(when)
      return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString(language)
    }
  }
}
