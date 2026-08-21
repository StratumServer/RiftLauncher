import { useCallback, useRef, useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import ModListCard from "@renderer/features/mods/components/ModListCard"

// Runs i18n.ts's module-level init, the same way tests/renderer-dom/helpers/render.tsx
// does for suites that go through renderWithProviders. ModListCard's own useTranslation()
// call needs an instance registered or every t() call falls back to the raw key.
import "@renderer/i18n"

/**
 * modsGridMemoization.test.tsx (the suite this one exists alongside) mocks ModListCard
 * itself and wraps ITS OWN mock function in `memo()` before asserting the mock only ran
 * once. That proves memo works on a spy, not that the real export is memoized: mutating the
 * real ModListCard.tsx to drop its `memo()` wrapper leaves that suite green, since the mock
 * module the test actually imports never changes.
 *
 * This suite imports the real, unmocked ModListCard and wraps the `mod` object it renders
 * in a Proxy that counts property reads instead. Only the component's own function body
 * ever reads a property off `mod` (JSX interpolations like `mod.name`, `mod.author`);
 * memo's bailout check is `Object.is(prevProps.mod, nextProps.mod)`, comparing the Proxy
 * reference itself without touching a property on it. So the read count only advances when
 * ModListCard's body actually runs, which is exactly the fact a memo test needs to pin.
 */
function makeMod(overrides: Partial<DownloadableModOnListType> = {}): DownloadableModOnListType {
  return {
    modid: 123,
    assetid: 123,
    downloads: 42,
    follows: 7,
    trendingpoints: 0,
    comments: 1,
    name: "Better Ruins",
    summary: "More interesting ruins.",
    modidstrs: ["betterruins"],
    author: "Someone",
    urlalias: null,
    side: "both",
    type: "mod",
    logo: "",
    tags: [],
    lastreleased: "",
    ...overrides
  }
}

function countingProxy<T extends object>(target: T, onRead: () => void): T {
  return new Proxy(target, {
    get(obj, prop, receiver): unknown {
      onRead()
      return Reflect.get(obj, prop, receiver)
    }
  })
}

/**
 * Every prop but `isFav` stays referentially and value-stable across a Harness re-render:
 * `mod` is created once via useRef, `installed` is a fixed primitive, and the three
 * callbacks are useCallback with an empty dependency array. `isFav` is the one prop a test
 * can flip on purpose, to prove the read counter actually detects a real re-render instead
 * of being wired to something that can never fire.
 */
function Harness({ onModRead }: { onModRead: () => void }): JSX.Element {
  const [tick, setTick] = useState(0)
  const [isFav, setIsFav] = useState(false)
  const mod = useRef(countingProxy(makeMod(), onModRead)).current
  const onSelect = useCallback((): void => {}, [])
  const onToggleFav = useCallback((): void => {}, [])
  const onOpenModDb = useCallback((): void => {}, [])

  return (
    <div>
      <button onClick={() => setTick((t) => t + 1)}>bump unrelated state</button>
      <button onClick={() => setIsFav((f) => !f)}>toggle isFav</button>
      <span>tick: {tick}</span>
      <ModListCard mod={mod} installed={false} isFav={isFav} onSelect={onSelect} onToggleFav={onToggleFav} onOpenModDb={onOpenModDb} />
    </div>
  )
}

describe("ModListCard memoization (real export, unmocked)", () => {
  it("does not read the mod prop again when the parent re-renders for an unrelated reason", async () => {
    const user = userEvent.setup()
    let readCount = 0

    render(<Harness onModRead={() => readCount++} />)
    const baseline = readCount
    expect(baseline).toBeGreaterThan(0)

    await user.click(screen.getByRole("button", { name: "bump unrelated state" }))
    await user.click(screen.getByRole("button", { name: "bump unrelated state" }))

    screen.getByText("tick: 2")
    // The parent re-rendered twice; ModListCard's own props never changed, so memo should
    // have skipped its body both times and the read count should sit exactly where it started.
    expect(readCount).toBe(baseline)
  })

  it("does read the mod prop again once isFav actually changes, as a positive control", async () => {
    const user = userEvent.setup()
    let readCount = 0

    render(<Harness onModRead={() => readCount++} />)
    const baseline = readCount
    expect(baseline).toBeGreaterThan(0)

    await user.click(screen.getByRole("button", { name: "toggle isFav" }))

    // Proves the counter can detect a re-render at all: a real prop change must push the
    // count past baseline, or the first test would pass vacuously against a broken harness.
    expect(readCount).toBeGreaterThan(baseline)
  })
})
