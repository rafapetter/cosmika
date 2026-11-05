// Global vitest setup for apps/web tests.
//
// Brings in @testing-library/jest-dom matchers, makes localStorage hermetic
// per-test, and stubs ResizeObserver / matchMedia which jsdom doesn't ship.
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'

// localStorage is jsdom-provided, but we wipe it between tests so suites
// can't leak state through it (session-store reads/writes localStorage).
beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

// jsdom doesn't implement ResizeObserver, used by some Recharts paths.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub

// matchMedia is referenced by responsive components / Tailwind utilities.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// Radix's Select (and anything else built on its popper) calls the Pointer
// Events capture API on open. jsdom ships the events but not these three
// methods, so without them every Select in a test throws instead of opening.
for (const m of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (!Element.prototype[m]) {
    Object.defineProperty(Element.prototype, m, {
      writable: true,
      value: () => false,
    })
  }
}

// jsdom implements no layout, so it has no scrollIntoView. Views that keep a
// growing list pinned to the bottom call it on every update.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}
