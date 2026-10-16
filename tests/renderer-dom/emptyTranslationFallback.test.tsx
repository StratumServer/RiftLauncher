import { describe, expect, it, onTestFinished } from "vitest"

import i18n, { changeLanguage } from "@renderer/i18n"

const KEY = "features.sessionReport.warningCount"

/**
 * #680: Weblate writes a plural form that has not been translated yet as an empty string. i18next
 * counted that as a translation, so the sentence for that count rendered as nothing at all. An
 * empty value now counts as missing and the English sentence for the same count shows instead.
 *
 * No locale file holds an empty value today, so each test puts one into the app's own i18n module
 * and takes it out again.
 */
describe("an empty translation (#680)", () => {
  it.each([
    // The case in the issue: the language keeps the forms it has, and the one it still lacks reads "".
    { locale: "de-DE", form: "_other", count: 2, english: "2 warnings" },
    // English picks its own form for the count: 21 is "one" in Russian and "other" in English.
    { locale: "ru-RU", form: "_one", count: 21, english: "21 warnings" }
  ])("shows the English sentence when the $locale $form form is empty and the count is $count", async ({ locale, form, count, english }) => {
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })
    expect(await changeLanguage(locale)).toBe(true)

    // The language is on screen and the form has a sentence of its own before it is emptied.
    const before = i18n.t(KEY, { count })
    expect(before).not.toBe("")
    expect(before).not.toBe(english)

    const own = i18n.getResource(locale, "translation", `${KEY}${form}`) as string
    onTestFinished(() => {
      i18n.addResource(locale, "translation", `${KEY}${form}`, own)
    })
    i18n.addResource(locale, "translation", `${KEY}${form}`, "")

    expect(i18n.t(KEY, { count })).toBe(english)
  })
})
