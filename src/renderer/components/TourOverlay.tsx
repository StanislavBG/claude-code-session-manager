/**
 * First-run guided tour overlay.
 *
 * Adapted from Unleashed's WelcomeTour but trimmed to our actual UI surface
 * (TabBar / LeftNav / StatusBar / mic / scheduler) and rewired to the zustand
 * tour store rather than per-instance state. Triggered automatically on first
 * launch (App.tsx checks localStorage `sm.tour.completedAt`) and re-runnable
 * via the command palette (`tour:start`).
 *
 * Rendering model: full-screen fixed overlay with a CSS box-shadow "spotlight"
 * cutout around the active step's target element. We measure the target via
 * `getBoundingClientRect` and place the tooltip on the requested side, clamped
 * to the viewport. If the target is missing (e.g. the user navigated away mid-
 * tour and the LeftNav scheduler section is collapsed), we fall back to a
 * centered tooltip with no spotlight — the step text still makes sense.
 *
 * Complexity: O(steps) total. Each step's positioning is O(1).
 *
 * Privacy: no data leaves the renderer; tour completion is purely localStorage.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTour } from '../state/tour'
import { log } from '../lib/logger'

type Position = 'center' | 'top' | 'bottom' | 'left' | 'right'

interface TourStep {
  id: string
  title: string
  body: string
  /** CSS selector — typically `[data-testid="…"]`. Omit for centered intro. */
  target?: string
  position: Position
}

/**
 * Ordered tour steps. Each step's `target` MUST exist in the DOM when its
 * step is active OR the step must declare `position: 'center'` and omit
 * `target` to render as a plain centered tooltip.
 *
 * The selectors below are real testids added to existing components — see
 * the patch list in the PR description for exact files.
 */
export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  {
    id: 'welcome',
    title: 'Welcome to Session Manager',
    body: "A 30-second tour so you know where everything lives. You can re-run this any time from the command palette.",
    position: 'center',
  },
  {
    id: 'tabs',
    title: 'Session tabs',
    body: "Each tab is a separate Claude session with its own working directory. Click + new to open another, drag to reorder.",
    target: '[data-testid="tour-tabbar"]',
    position: 'bottom',
  },
  {
    id: 'leftnav',
    title: 'Left navigation',
    body: "Switch between Terminal, Settings, Skills, MCP servers, History and more. Live dots show which sections are active right now.",
    target: '[data-testid="tour-leftnav"]',
    position: 'right',
  },
  {
    id: 'voice',
    title: 'Push-to-talk dictation',
    body: "Hold the configured hotkey (F1 by default) to dictate into the terminal. You can also click the mic.",
    target: '[data-testid="mic-button"]',
    position: 'right',
  },
  {
    id: 'scheduler',
    title: 'PRD scheduler',
    body: "Drop a Markdown plan in this project's session-manager-operations/scheduler/prds/ and the scheduler runs it as a token-budget-managed claude -p job.",
    target: '[data-testid="tour-scheduler"]',
    position: 'right',
  },
  {
    id: 'mainpane-actions',
    title: 'Session actions',
    body: "Press ⌘K / Ctrl+K to open the command palette — restart this session, broadcast a prompt to multiple tabs, or attach a long-running watcher command whose stdout streams back as toasts.",
    position: 'center',
  },
  {
    id: 'statusbar',
    title: 'Status bar',
    body: "Model, 5-hour usage, branch, last activity, and the active working directory. Click restart-app to reload the whole app.",
    target: '[data-testid="tour-statusbar"]',
    position: 'top',
  },
  {
    id: 'new-session',
    title: 'Start a new session',
    body: "Pick any project directory to spin up another claude session. Tabs persist across reboots — they auto-resume on next launch.",
    target: '[data-testid="tour-new-session"]',
    position: 'top',
  },
]

const TOOLTIP_W = 360
const TOOLTIP_H = 220
const PAD = 16

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function positionFor(rect: DOMRect | null, pos: Position): React.CSSProperties {
  if (!rect || pos === 'center') {
    return {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    }
  }
  const vw = window.innerWidth
  const vh = window.innerHeight
  switch (pos) {
    case 'top':
      return {
        position: 'fixed',
        top: clamp(rect.top - TOOLTIP_H - PAD, PAD, vh - TOOLTIP_H - PAD),
        left: clamp(rect.left + rect.width / 2 - TOOLTIP_W / 2, PAD, vw - TOOLTIP_W - PAD),
      }
    case 'bottom':
      return {
        position: 'fixed',
        top: clamp(rect.bottom + PAD, PAD, vh - TOOLTIP_H - PAD),
        left: clamp(rect.left + rect.width / 2 - TOOLTIP_W / 2, PAD, vw - TOOLTIP_W - PAD),
      }
    case 'left':
      return {
        position: 'fixed',
        top: clamp(rect.top + rect.height / 2 - TOOLTIP_H / 2, PAD, vh - TOOLTIP_H - PAD),
        left: clamp(rect.left - TOOLTIP_W - PAD, PAD, vw - TOOLTIP_W - PAD),
      }
    case 'right':
      return {
        position: 'fixed',
        top: clamp(rect.top + rect.height / 2 - TOOLTIP_H / 2, PAD, vh - TOOLTIP_H - PAD),
        left: clamp(rect.right + PAD, PAD, vw - TOOLTIP_W - PAD),
      }
  }
}

export function TourOverlay() {
  const open = useTour((s) => s.open)
  const currentStep = useTour((s) => s.currentStep)
  const next = useTour((s) => s.next)
  const prev = useTour((s) => s.prev)
  const complete = useTour((s) => s.complete)
  const setStepCount = useTour((s) => s.setStepCount)

  // Publish the step count once so the store knows when "next" should
  // become "complete". TOUR_STEPS is module-level so this only fires once.
  useEffect(() => { setStepCount(TOUR_STEPS.length) }, [setStepCount])

  const [rect, setRect] = useState<DOMRect | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const step = TOUR_STEPS[currentStep] ?? TOUR_STEPS[0]
  const isFirst = currentStep === 0
  const isLast = currentStep === TOUR_STEPS.length - 1

  // Measure the target whenever the step changes or the window resizes.
  // useLayoutEffect so the spotlight paints in the same frame as the step
  // change rather than a flash of mispositioned tooltip.
  useLayoutEffect(() => {
    if (!open) return
    let cancelled = false

    const measure = () => {
      if (cancelled) return
      if (!step.target) {
        setRect(null)
        return
      }
      const el = document.querySelector(step.target)
      if (!el) {
        setRect(null)
        return
      }
      setRect(el.getBoundingClientRect())
    }

    // First measurement next tick — gives the DOM a beat to settle if the
    // step transition coincided with a layout change (e.g. opening the
    // scheduler section).
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [open, step.target, currentStep])

  // Keyboard shortcuts. Esc skips, Arrow keys / Enter navigate.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        log.info('tour', 'skipped', { step: step.id })
        complete()
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        next()
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prev()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, next, prev, complete, step.id])

  // Log step transitions for debugging. No PII — the tour is purely UI.
  useEffect(() => {
    if (open) log.info('tour', 'step', { index: currentStep, id: step.id })
  }, [open, currentStep, step.id])

  if (!open) return null

  const tooltipStyle = positionFor(rect, step.position)
  const progress = ((currentStep + 1) / TOUR_STEPS.length) * 100

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      data-testid="tour-overlay"
      className="fixed inset-0 z-[200]"
    >
      {/* Backdrop. When we have a target rect we use a CSS box-shadow trick:
       *  paint a small transparent rectangle and rely on a huge outer shadow
       *  to dim everything else. Cleaner than four overlay rectangles and
       *  much cheaper than canvas. */}
      {rect ? (
        <div
          aria-hidden="true"
          className="absolute rounded-md pointer-events-none transition-all"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: '0 0 0 4000px rgba(0, 0, 0, 0.65), 0 0 0 2px rgba(204, 120, 92, 0.55)',
          }}
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-black/65"
        />
      )}

      {/* Tooltip card. */}
      <div
        ref={tooltipRef}
        style={{ ...tooltipStyle, width: TOOLTIP_W }}
        className="bg-bg-elev border border-line rounded-lg shadow-2xl p-4 text-fg"
        data-testid="tour-tooltip"
      >
        <div className="flex items-start justify-between mb-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-faint mb-0.5">
              Step {currentStep + 1} of {TOUR_STEPS.length}
            </div>
            <h3 id="tour-title" className="text-sm font-semibold text-fg">
              {step.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => { log.info('tour', 'skipped', { step: step.id }); complete() }}
            className="text-fg-faint hover:text-fg p-1 -m-1"
            aria-label="Skip tour"
            data-testid="tour-close"
          >
            ×
          </button>
        </div>

        <p id="tour-body" className="text-xs text-fg-dim leading-relaxed mb-3">
          {step.body}
        </p>

        {/* Progress bar */}
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={TOUR_STEPS.length}
          aria-valuenow={currentStep + 1}
          className="h-1 bg-bg rounded-full overflow-hidden mb-3"
        >
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => { log.info('tour', 'skipped', { step: step.id }); complete() }}
            className="text-[11px] text-fg-faint hover:text-fg-dim underline"
            data-testid="tour-skip"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                type="button"
                onClick={prev}
                className="px-3 py-1 rounded border border-line text-xs text-fg hover:bg-bg-hi"
                data-testid="tour-prev"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="px-3 py-1 rounded bg-accent text-bg text-xs font-medium hover:opacity-90"
              data-testid="tour-next"
            >
              {isLast ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
