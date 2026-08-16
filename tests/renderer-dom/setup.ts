// Runs once per test file in the renderer-dom Vitest project (jsdom
// environment only -- the node project never loads this file).
import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

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

afterEach(() => {
  cleanup()
})
