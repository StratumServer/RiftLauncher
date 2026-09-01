// Runs once per test file in the renderer-dom Vitest project (jsdom
// environment only -- the node project never loads this file).
import { afterEach, beforeEach } from "vitest"
import { cleanup } from "@testing-library/react"
import { clearQueryCache } from "@renderer/features/mods/hooks/useQueryMods"

// useQueryMods keeps its result cache at module scope. Reset it for every
// renderer-dom test so one file cannot leak a cached response into another.
beforeEach(() => {
  clearQueryCache()
})

// jsdom does not implement matchMedia. motion/react (framer-motion) reads it
// to resolve the user's reduced-motion preference on every mount.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }) as MediaQueryList
}

// jsdom does not implement Element.scrollTo either. ScrollableContainer's ref
// (ListMods' search-reset, StickyMenu's "go to top") calls it straight after
// every successful query, so leaving it missing does not fail loudly: it
// throws inside whatever try/catch happens to wrap that call, which quietly
// turns "the query worked" into "the query returned nothing" instead.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = (): void => {}
}

// jsdom does define window.scrollTo, but only as a stub that logs "Not
// implemented: Window's scrollTo() method" to stderr on every call, so this
// one has to be overwritten rather than guarded on. motion/react reaches it
// while resolving a height: "auto" keyframe (DropdownSection's open/close
// animation, on the info and help page among others): it parks the page
// scroll, measures, then puts the scroll back. Nothing under test depends on
// the page having scrolled, and the noise buries real warnings.
window.scrollTo = (): void => {}

// jsdom does not implement IntersectionObserver. motion/react's useInView
// (every GridItem card) reads it on mount; missing it throws during the
// commit phase and takes the whole subtree down with it, with no error
// boundary in these tests to contain it.
if (!window.IntersectionObserver) {
  class NoopIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null
    readonly rootMargin: string = ""
    readonly thresholds: ReadonlyArray<number> = []
    observe = (): void => {}
    unobserve = (): void => {}
    disconnect = (): void => {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  window.IntersectionObserver = NoopIntersectionObserver as unknown as typeof IntersectionObserver
}

// jsdom does not implement ResizeObserver. @headlessui/react's Listbox/Menu
// (the mods filter dropdowns) reads it to track the anchor button's size as
// soon as one is opened, so any test that clicks a filter open needs it.
if (!window.ResizeObserver) {
  class NoopResizeObserver implements ResizeObserver {
    observe = (): void => {}
    unobserve = (): void => {}
    disconnect = (): void => {}
  }
  window.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
}

afterEach(() => {
  cleanup()
})
