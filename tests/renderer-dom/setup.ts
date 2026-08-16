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

afterEach(() => {
  cleanup()
})
