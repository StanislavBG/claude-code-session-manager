import { act } from 'react-dom/test-utils'

/**
 * Flushes `count` microtask turns inside `act()` — the shared pattern every
 * jsdom component test uses to let chained `.then()`s (mock IPC → state →
 * render) settle before asserting on the DOM. `count` should be at least as
 * deep as the longest promise chain under test.
 */
export function flushAsync(count = 4) {
  return act(async () => {
    for (let i = 0; i < count; i++) {
      await Promise.resolve()
    }
  })
}
