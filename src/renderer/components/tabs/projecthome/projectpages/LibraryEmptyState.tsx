/**
 * Project Home v2's empty library — the starter gallery (DESIGN_SPEC §4, renders 07-empty-pages and
 * 08-empty-videos; prototype lines 138–172 and `cards()`). Eyebrow `NO PAGES YET` | `NO VIDEOS YET`,
 * the serif title and text, then one card per PAGE_TEMPLATES | VIDEO_TEMPLATES entry: a 104px
 * preview strip (the template's eyebrow + up to 4 covers | scenes; a video card in its style's
 * colours), name, blurb, preset line, the primary button and Customize. Last, the TIP strip, whose
 * `Review MD network` link switches Project Home to Tools.
 *
 * The primary button quick-launches the template's defaults (`onQuick`). A template whose defaults
 * cannot generate — the page Custom topic, which has no topic yet — reads `Name a topic` and opens the
 * composer on itself (`onCustomize`) instead: the same `canGenerate` rule that disables the
 * composer's own button. Customize always opens the composer on that template.
 *
 * Presentational: PagesPane / VideosPane own the launch and the composer. The root keeps the panes'
 * old `knowledge-page-empty` / `video-page-empty` testid.
 */
import { useState, type ReactNode } from 'react'
import {
  PAGE_TEMPLATES,
  VIDEO_TEMPLATES,
  canGenerate,
  pageDefaults,
  videoDefaults,
  type VideoStyleId,
} from './composerTemplates'

export type LibraryKind = 'page' | 'video'

export interface LibraryEmptyStateProps {
  kind: LibraryKind
  /** Launch the template with its defaults (`pageDefaults` / `videoDefaults`) — no composer. */
  onQuick: (tplId: string) => void
  /** Open the Generate composer on the template. */
  onCustomize: (tplId: string) => void
  /** Switch Project Home to its Tools tab. Without it `Review MD network` is plain text, never a dead link. */
  onGoTools?: () => void
  /** Disables both buttons on every card (no macro, or a launch in flight); the TIP link stays live. */
  disabled?: boolean
  /** The disabled buttons' tooltip — why they are disabled. */
  disabledTitle?: string
  /** This library's launch is in flight: the card quick-launched last reads `Starting…`. */
  starting?: boolean
  /** Shown between the heading and the cards — the last build's failure line. */
  notice?: ReactNode
}

const COPY: Record<LibraryKind, { testId: string; eyebrow: string; title: string; text: string; label: string }> = {
  page: {
    testId: 'knowledge-page-empty',
    eyebrow: 'NO PAGES YET',
    title: 'Start this project’s library',
    text: 'Pages explain the project in writing, grounded in what the builder actually reads. Each starting point below is a pre-built configuration: generate it as-is, or customize it first.',
    label: 'Page templates',
  },
  video: {
    testId: 'video-page-empty',
    eyebrow: 'NO VIDEOS YET',
    title: 'Show the project in under a minute',
    text: 'Videos are short, self-contained animations — 30 seconds or a minute. Each starting point below is a pre-built configuration: generate it as-is, or customize it first.',
    label: 'Video templates',
  },
}

/** A card's preview strip colours: complete literals, never interpolated (Tailwind JIT). */
interface PreviewTone {
  /** Background, text colour and the lines' font. */
  strip: string
  /** The mono eyebrow's colour. */
  eyebrow: string
  /** The 12px dash before each line. */
  dash: string
}

/** Page cards: prototype P2 / I2 / ACC, sans (DESIGN_SPEC §2). */
const PAGE_TONE: PreviewTone = { strip: 'bg-bg-elev text-fg-dim font-sans', eyebrow: 'text-accent-dark', dash: 'bg-accent' }

/**
 * Video cards in their style's colours — prototype STYLES bg / fg / acc / font (lines 840–846). The
 * backgrounds match the VIDEO_STYLES swatches; the #f4b942 accent uses `butter`, the token the Fun
 * swatch already maps that colour to, and it reads on the ink and accent strips.
 */
const VIDEO_TONES: Record<VideoStyleId, PreviewTone> = {
  Auto: { strip: 'bg-bg-elev text-fg font-sans', eyebrow: 'text-accent-dark', dash: 'bg-accent' },
  Professional: { strip: 'bg-fg text-bg font-serif', eyebrow: 'text-butter', dash: 'bg-butter' },
  Fun: { strip: 'bg-butter text-fg font-sans', eyebrow: 'text-accent-dark', dash: 'bg-accent' },
  'Animated whiteboard': { strip: 'bg-bg-hi text-fg-dim font-serif', eyebrow: 'text-sage-dark', dash: 'bg-sage-dark' },
  'Kinetic typography': { strip: 'bg-accent text-bg-hi font-sans', eyebrow: 'text-butter', dash: 'bg-butter' },
}

/** The preview strip shows at most this many covers / scenes. */
const PREVIEW_LINES = 4

interface StarterCard {
  id: string
  name: string
  blurb: string
  /** `<audience> · <length>` | `<kind> · <len>s`. */
  preset: string
  eyebrow: string
  lines: readonly string[]
  tone: PreviewTone
  /** Video cards only: the style the strip shows. */
  style?: VideoStyleId
  /** The defaults cannot generate (no topic yet): the primary button opens the composer instead. */
  needsTopic: boolean
}

/** Prototype `cards()`, from the shared templates; static, so built once. */
const CARDS: Record<LibraryKind, readonly StarterCard[]> = {
  page: PAGE_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    blurb: t.blurb,
    preset: `${t.audience.toLowerCase()} · ${t.length.toLowerCase()}`,
    eyebrow: `PAGE · ${t.page.toUpperCase()}`,
    lines: t.covers.slice(0, PREVIEW_LINES),
    tone: PAGE_TONE,
    needsTopic: !canGenerate('page', t.id, pageDefaults(t.id)),
  })),
  video: VIDEO_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    blurb: t.blurb,
    preset: `${t.kind.toLowerCase()} · ${t.length}s`,
    eyebrow: `${t.length} S · ${t.style.toUpperCase()}`,
    lines: t.scenes.slice(0, PREVIEW_LINES),
    tone: VIDEO_TONES[t.style],
    style: t.style,
    needsTopic: !canGenerate('video', t.id, videoDefaults(t.id)),
  })),
}

const PRIMARY_CLASS =
  'inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-accent px-3 text-[12.5px] font-semibold text-bg-hi cursor-pointer enabled:hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

const CUSTOMIZE_CLASS =
  'inline-flex h-[30px] items-center whitespace-nowrap rounded-[7px] border border-rule-structural bg-bg px-[11px] text-[12.5px] font-semibold text-fg cursor-pointer enabled:hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed'

const TIP_BEFORE = "Generated pages and videos are only as good as the docs behind them. If they're messy, run "
const TIP_LINK = 'Review MD network'
const TIP_AFTER = ' in Tools first.'

export function LibraryEmptyState({
  kind,
  onQuick,
  onCustomize,
  onGoTools,
  disabled = false,
  disabledTitle,
  starting = false,
  notice,
}: LibraryEmptyStateProps) {
  // The card quick-launched last; it reads `Starting…` while `starting`. Customize clears it.
  const [pressed, setPressed] = useState<string | null>(null)
  const copy = COPY[kind]
  const title = disabled ? disabledTitle : undefined

  return (
    <div data-testid={copy.testId} data-kind={kind} className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-[22px] pt-3.5 pb-9">
        <div className="flex flex-col gap-2">
          <span data-testid="library-empty-eyebrow" className="font-mono text-[11px] tracking-[.12em] text-accent-dark">
            {copy.eyebrow}
          </span>
          <h2
            data-testid="library-empty-title"
            className="m-0 font-serif text-[30px] font-semibold leading-[1.12] text-fg"
          >
            {copy.title}
          </h2>
          <p data-testid="library-empty-text" className="m-0 max-w-[64ch] text-pretty text-[14.5px] leading-[1.55] text-fg-faint">
            {copy.text}
          </p>
        </div>
        {notice}
        <ul
          data-testid="library-empty-grid"
          aria-label={copy.label}
          className="m-0 grid list-none gap-3.5 p-0"
          style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))' }}
        >
          {CARDS[kind].map((card) => (
            <li
              key={card.id}
              data-testid="template-card"
              data-tpl={card.id}
              className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-rule-structural bg-bg-hi hover:border-fg-faint"
            >
              <div
                data-testid="template-card-preview"
                data-style={card.style}
                className={`flex h-[104px] flex-none flex-col gap-1.5 overflow-hidden border-b border-rule-structural px-3.5 py-3 ${card.tone.strip}`}
              >
                <span data-testid="template-card-eyebrow" className={`font-mono text-[9.5px] tracking-[.1em] ${card.tone.eyebrow}`}>
                  {card.eyebrow}
                </span>
                {card.lines.map((line, i) => (
                  <span key={i} data-testid="template-card-line" className="flex min-w-0 items-center gap-[7px] text-[12px]">
                    <span aria-hidden="true" className={`h-[1.5px] w-3 flex-none ${card.tone.dash}`} />
                    <span className="truncate">{line}</span>
                  </span>
                ))}
              </div>
              <div className="flex flex-1 flex-col gap-2.5 px-3.5 pt-3 pb-3.5">
                <div className="flex flex-col gap-[3px]">
                  <span data-col="name" className="text-[14.5px] font-semibold text-fg">
                    {card.name}
                  </span>
                  <span data-col="blurb" className="text-pretty text-[12.5px] leading-[1.45] text-fg-faint">
                    {card.blurb}
                  </span>
                </div>
                <span data-col="preset" className="font-mono text-[10.5px] text-fg-faint">
                  {card.preset}
                </span>
                <div className="mt-auto flex gap-2">
                  <button
                    type="button"
                    data-testid="template-card-quick"
                    disabled={disabled}
                    title={title}
                    onClick={() => {
                      if (card.needsTopic) {
                        setPressed(null)
                        onCustomize(card.id)
                        return
                      }
                      setPressed(card.id)
                      onQuick(card.id)
                    }}
                    className={PRIMARY_CLASS}
                  >
                    {card.needsTopic ? 'Name a topic' : starting && pressed === card.id ? 'Starting…' : 'Generate'}
                  </button>
                  <button
                    type="button"
                    data-testid="template-card-customize"
                    disabled={disabled}
                    title={title}
                    onClick={() => {
                      setPressed(null)
                      onCustomize(card.id)
                    }}
                    className={CUSTOMIZE_CLASS}
                  >
                    Customize
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div
          data-testid="library-empty-tip"
          className="flex flex-wrap items-center gap-3 rounded-[10px] bg-bg-elev px-4 py-3 text-[13px] leading-[1.5] text-fg-dim"
        >
          <span data-testid="library-empty-tip-label" className="font-mono text-[10.5px] font-bold tracking-[.1em] text-sage-dark">
            TIP
          </span>
          <span data-testid="library-empty-tip-text" className="min-w-[240px] flex-1">
            {TIP_BEFORE}
            {onGoTools ? (
              <button
                type="button"
                data-testid="library-empty-tools"
                onClick={() => onGoTools()}
                className="font-semibold text-fg underline underline-offset-2 cursor-pointer hover:text-accent-dark"
              >
                {TIP_LINK}
              </button>
            ) : (
              <span className="font-semibold">{TIP_LINK}</span>
            )}
            {TIP_AFTER}
          </span>
        </div>
      </div>
    </div>
  )
}
