import { describe, expect, it, onTestFinished } from "vitest"

import i18n, { changeLanguage } from "@renderer/i18n"

// What i18n.ts leaves on the root element as it loads, read before any test switches the language.
const languageAtStart = document.documentElement.lang

/**
 * #612: the root element declares the language of the text on screen, which is what a screen
 * reader picks its pronunciation rules from (WCAG 3.1.1). It follows i18next itself, so the
 * language the launcher starts in, the one restored at start and every switch from the Config
 * page all land on it.
 */
describe("document language (#612)", () => {
  it("declares the language the launcher starts in", () => {
    expect(languageAtStart).toBe("en-US")
  })

  it("follows a switch to French and back", async () => {
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })

    expect(await changeLanguage("fr-FR")).toBe(true)
    expect(document.documentElement.lang).toBe("fr-FR")

    expect(await changeLanguage("en-US")).toBe(true)
    expect(document.documentElement.lang).toBe("en-US")
  })

  it("keeps the language on screen when a switch is refused", async () => {
    expect(await changeLanguage("xx-XX")).toBe(false)
    expect(document.documentElement.lang).toBe("en-US")
  })

  it("declares a valid BCP 47 tag for every language the launcher offers", async () => {
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })

    for (const code of Object.keys(i18n.options.resources ?? {})) {
      expect(await changeLanguage(code)).toBe(true)
      expect(document.documentElement.lang).toBe(code)
      expect(() => Intl.getCanonicalLocales(code)).not.toThrow()
    }
  })
})
