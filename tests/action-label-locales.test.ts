import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * An action button that is handed `icon` renders its `title` as visible text rather than as a
 * tooltip, so a key that some locale is missing no longer degrades quietly to a hover string:
 * it puts an English word in the middle of a translated screen. This walks the components for
 * every key that reaches the screen that way and holds all fourteen locales to it.
 *
 * It deliberately checks presence and emptiness only. Whether a translation is *good* is a
 * translator's call, not a test's; what a test can hold is that nobody ships a label with no
 * translation at all.
 */

const RENDERER = resolve(__dirname, "..", "src", "renderer", "src")
const LOCALES = join(RENDERER, "locales")

/** Matches a self-closing action element, tolerating one level of `{...}` inside its attributes. */
const ACTION = /<(?:FormButton|FormLinkButton|NormalButton|LinkButton)\b((?:[^<>]|\{[^{}]*\})*?)\/>/gs
const TRANSLATION_KEY = /"([a-zA-Z]+(?:\.[a-zA-Z]+)+)"/g

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.name.endsWith(".tsx") ? [path] : []
  })
}

function visibleActionLabelKeys(): string[] {
  const keys = new Set<string>()
  for (const file of tsxFiles(RENDERER)) {
    const source = readFileSync(file, "utf8")
    for (const action of source.matchAll(ACTION)) {
      const attrs = action[1] as string
      if (!attrs.includes("icon=")) continue
      for (const key of attrs.matchAll(TRANSLATION_KEY)) keys.add(key[1] as string)
    }
  }
  return [...keys].sort()
}

function lookup(locale: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), locale)
}

describe("labels a player actually reads on an action button", () => {
  it("resolves in every locale the launcher ships", () => {
    const keys = visibleActionLabelKeys()
    assert.ok(keys.length > 0, "found no action buttons rendering a label, this test has lost its subject")

    const files = readdirSync(LOCALES)
      .filter((file) => file.endsWith(".json"))
      .sort()
    assert.ok(files.length > 1, "expected the launcher's locale files under " + LOCALES)

    for (const file of files) {
      const locale = JSON.parse(readFileSync(join(LOCALES, file), "utf8")) as Record<string, unknown>
      for (const key of keys) {
        const value = lookup(locale, key)
        assert.equal(typeof value, "string", `${file} is missing ${key}, which ships as visible button text`)
        assert.ok((value as string).trim().length > 0, `${file} has an empty ${key}`)
      }
    }
  })
})
