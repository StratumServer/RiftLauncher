import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

const LOCALES = resolve(__dirname, "..", "src", "renderer", "src", "locales")
const LOGIN_KEYS = [
  "loginTitle",
  "loggingin",
  "wrongtwofa",
  "invalidEmailPass",
  "loggedin",
  "onlyIfEnabledTwoFA",
  "loginDialogTitle",
  "loginAction",
  "requiresTwoFA",
  "loginUnreachable",
  "unexpectedResponse",
  "sessionStoreUnreadable",
  "sessionStoreRebuilt",
  "showPassword",
  "hidePassword",
  "loginPrivacyTitle",
  "loginPrivacySent",
  "loginPrivacyStored",
  "loginPrivacyGame",
  "loginPrivacyPolicy",
  "removeAccountAction"
] as const

function getConfig(locale: unknown): Record<string, unknown> {
  assert.ok(locale && typeof locale === "object", "locale must be an object")
  const features = (locale as Record<string, unknown>).features
  assert.ok(features && typeof features === "object", "locale must define features")
  const config = (features as Record<string, unknown>).config
  assert.ok(config && typeof config === "object", "locale must define features.config")
  return config as Record<string, unknown>
}

describe("login translations", () => {
  it("translates every login string in every locale file", () => {
    const localeFiles = readdirSync(LOCALES)
      .filter((file) => file.endsWith(".json"))
      .sort()

    for (const file of localeFiles) {
      const config = getConfig(JSON.parse(readFileSync(resolve(LOCALES, file), "utf8")))
      for (const key of LOGIN_KEYS) {
        const value = config[key]
        assert.equal(typeof value, "string", file + " is missing features.config." + key)
        assert.ok((value as string).trim().length > 0, file + " has an empty features.config." + key)
      }
    }
  })
})
