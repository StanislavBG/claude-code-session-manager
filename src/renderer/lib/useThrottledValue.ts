import { useEffect, useRef, useState } from 'react'

/**
 * Trailing-edge throttle: while `enabled`, the returned value updates at most
 * once per `ms`, and the latest value always lands. When disabled the input is
 * returned as-is, so flipping off (e.g. a stream finishing) renders the final
 * value immediately.
 */
export function useThrottledValue<T>(value: T, ms: number, enabled = true): T {
  const [throttled, setThrottled] = useState(value)
  const latest = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  latest.current = value
  // While disabled `throttled` isn't tracking the input. Remember that, so a
  // later false->true flip returns the live value and re-syncs state in an
  // effect — no setState (and so no extra render) on every disabled render.
  const stale = useRef(false)
  if (!enabled && throttled !== value) stale.current = true

  useEffect(() => {
    if (enabled && stale.current) {
      stale.current = false
      setThrottled(latest.current)
      return
    }
    if (!enabled || timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      setThrottled(latest.current)
    }, ms)
  }, [value, ms, enabled])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    },
    [],
  )

  return enabled && !stale.current ? throttled : value
}
