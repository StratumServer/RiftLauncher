import { describe, expect, it, afterEach } from "vitest"
import { render, act } from "@testing-library/react"

import { GridWrapper, GridGroup, GridItem } from "@renderer/components/ui/Grid"

/**
 * A controllable stand-in for the browser's IntersectionObserver, replacing the always-noop
 * one tests/renderer-dom/setup.ts installs globally (which never fires a callback, so it
 * can't exercise the once:true path at all). Runs motion/react's real inView()
 * implementation against it, unmocked: this proves the actual library wiring, not just that
 * GridItem passes the right prop.
 */
class FakeIntersectionObserver implements IntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly root: Element | Document | null = null
  readonly rootMargin: string = ""
  readonly thresholds: ReadonlyArray<number> = []
  observedElements = new Set<Element>()
  unobserveCalls: Element[] = []

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(el: Element): void {
    this.observedElements.add(el)
  }

  unobserve(el: Element): void {
    this.observedElements.delete(el)
    this.unobserveCalls.push(el)
  }

  disconnect(): void {
    this.observedElements.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  trigger(el: Element, isIntersecting: boolean): void {
    this.callback([{ target: el, isIntersecting } as IntersectionObserverEntry], this)
  }
}

describe("GridItem in-view tracking", () => {
  afterEach(() => {
    FakeIntersectionObserver.instances = []
  })

  it("unobserves a card once it has been seen, instead of watching it forever", () => {
    const realIntersectionObserver = window.IntersectionObserver
    window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver

    try {
      const { container } = render(
        <GridWrapper>
          <GridGroup>
            <GridItem>card content</GridItem>
          </GridGroup>
        </GridWrapper>
      )

      expect(FakeIntersectionObserver.instances).toHaveLength(1)
      const observer = FakeIntersectionObserver.instances[0]
      const cardElement = container.querySelector("li") as Element
      expect(observer.observedElements.has(cardElement)).toBe(true)

      act(() => {
        observer.trigger(cardElement, true)
      })

      // once: true means the entry handler returns no "leave" callback, which is exactly
      // what makes motion's inView() call unobserve on this element (see
      // node_modules/motion's render/dom/viewport/index.mjs). A real IntersectionObserver
      // fires no further callbacks for a target after unobserve(), so that single call is
      // the whole story; this fake only stands in for the browser's dispatch, not that
      // guarantee, so re-triggering it manually isn't a scenario a real browser produces.
      expect(observer.unobserveCalls).toEqual([cardElement])
    } finally {
      window.IntersectionObserver = realIntersectionObserver
    }
  })
})
