// Shared cwd/name → color-dot hash, extracted out of sched-primitives.tsx so
// the Almanac Scheduler design and the History analytics view share exactly
// one hash→palette mapping instead of drifting copies.

export const PROJ_DOTS = ['#6f7d52', '#b85c34', '#8a7a60', '#e4b85a', '#5f6f86', '#4f7d72', '#8a5a6e']

export function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0
  return h
}

export function projectColorFor(key: string): string {
  return PROJ_DOTS[hashStr(key) % PROJ_DOTS.length]
}
