import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

import i18n from "@renderer/i18n"
import ModSuggestions from "@renderer/features/mods/components/ModSuggestions"

/**
 * #663: i18next escaped every value it put into a sentence, and React escaped the finished
 * sentence once more when it rendered it as text, so a name or a path holding an apostrophe, a
 * quote, an ampersand, an angle bracket or a slash reached the screen as an entity. An Installation
 * named Bob's World read "Bob&#39;s World". Nothing in the renderer hands a sentence to the page as
 * HTML, so React's escaping is the only one needed and a value goes through as written.
 */

// One value holding every character i18next's default escaping rewrites.
const AWKWARD = `Bob's "Big" World & <Co>/Sub`

const INSTALLATION: InstallationType = {
  id: "install-a",
  name: AWKWARD,
  icon: "",
  path: "/games/a",
  version: "1.22.7",
  gameVersionId: null,
  startParams: "",
  backupsLimit: 3,
  backupsAuto: false,
  compressionLevel: 6,
  backups: [],
  lastTimePlayed: -1,
  totalTimePlayed: 0,
  mesaGlThread: false,
  envVars: ""
}

const noop = (): void => {}

describe("interpolated values (#663)", () => {
  it("come back from the app's own i18n module as written", () => {
    expect(i18n.t("features.mods.suggestionsTitle", { installation: AWKWARD })).toBe(`Suggested for ${AWKWARD}`)
  })

  it("reach the screen as written, in a component that sets no override of its own", () => {
    render(
      <ModSuggestions
        consent={true}
        folded={false}
        installation={INSTALLATION}
        suggestions={[]}
        loading={false}
        selecting={false}
        isModFav={() => false}
        isBusy={() => false}
        onEnable={noop}
        onNoThanks={noop}
        onToggleFold={noop}
        onTurnOff={noop}
        onRefresh={noop}
        onDismiss={noop}
        onAddAll={noop}
        onSelect={noop}
        onToggleFav={noop}
        onOpenModDb={noop}
        onAction={noop}
      />
    )

    expect(screen.getByRole("heading", { name: `Suggested for ${AWKWARD}` })).toBeTruthy()
  })
})
