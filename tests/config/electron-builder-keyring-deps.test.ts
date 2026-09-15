import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"
import { listUnder } from "./ymlBlock"

/**
 * Guards the keyring dependencies in electron-builder.yml.
 *
 * Electron's safeStorage reaches the session keyring through libsecret, and with nothing answering
 * it falls back to a store whose key ships in the binary, which src/ipc/accountStore.ts refuses.
 * A packaged build without libsecret therefore cannot remember a login at all, which is how a
 * Debian player on KDE ended up logging in again on every start (#481).
 *
 * Both `depends` lists REPLACE electron-builder's own defaults rather than adding to them
 * (app-builder-lib, FpmTarget.getDefaultDepends), and so does `recommends`. So the danger these
 * cases actually guard is not a missing libsecret so much as a default quietly dropped while
 * spelling one out: every entry is pinned, not just the new one.
 */

const YML = readFileSync(resolve(__dirname, "../../electron-builder.yml"), "utf8")

describe("electron-builder Linux package dependencies", () => {
  it("keeps every deb dependency, libsecret included", () => {
    assert.deepEqual(listUnder(YML, "deb", "depends"), ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0"])
  })

  it("recommends a keyring daemon on deb without requiring one, and keeps the default recommends beside it", () => {
    // A hard dependency here would put GNOME Keyring on a KDE desktop that already has KWallet
    // answering the same interface.
    assert.deepEqual(listUnder(YML, "deb", "recommends"), ["libappindicator3-1", "gnome-keyring"])
  })

  it("keeps every rpm dependency, libsecret included", () => {
    assert.deepEqual(listUnder(YML, "rpm", "depends"), ["gtk3", "libnotify", "nss", "libXScrnSaver", "(libXtst or libXtst6)", "xdg-utils", "at-spi2-core", "(libuuid or libuuid1)", "libsecret"])
  })

  it("keeps the note saying why gnome-keyring cannot be a weak dependency on rpm", () => {
    assert.match(YML, /electron-builder has no weak-dependency key for rpm/)
  })
})
