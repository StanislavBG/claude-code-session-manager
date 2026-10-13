import { memo, useState } from 'react'
import { VoiceButton } from '../../../VoiceButton'
import type { MemoryRow } from './model'

type AskResult = { ok: boolean; answer: string; citations: string[] } | null

interface Props {
  rows: MemoryRow[]
  context: string | null
  onClearContext: () => void
  onAsk: (question: string, context: string | null) => Promise<AskResult>
  onOpen: (name: string) => void
  onReverify: () => void
  onDraft: (text: string) => void
}

type Turn =
  | { kind: 'answer'; question: string; answer: string; citations: string[] }
  | { kind: 'draft'; question: string; text: string }

const CHIPS = ['What changed this week?', 'Find contradictions', 'Summarize stale memories', 'remember …']
const CTX_CHIPS = ['Is this still accurate?', 'What links here?', 'Summarize it']
const REMEMBER = /^remember\b[\s:,-]*/i
const BTN = 'text-xs font-medium h-[26px] px-2.5 rounded-[5px] bg-fg text-bg'

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export const AskView = memo(function AskView({
  rows, context, onClearContext, onAsk, onOpen, onReverify, onDraft,
}: Props) {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [turn, setTurn] = useState<Turn | null>(null)

  const send = async () => {
    const q = input.trim()
    if (!q || pending) return
    if (/^remember\b/i.test(q)) {
      setTurn({ kind: 'draft', question: q, text: capitalise(q.replace(REMEMBER, '')) })
      setInput('')
      return
    }
    setPending(true)
    let res: AskResult = null
    try {
      res = await onAsk(q, context)
    } catch {
      res = null
    }
    setPending(false)
    if (!res || !res.ok) return
    setTurn({ kind: 'answer', question: q, answer: res.answer, citations: res.citations })
    setInput('')
  }

  const cited = turn?.kind === 'answer'
    ? turn.citations.map((slug) => ({ slug, row: rows.find((r) => r.slug === slug || r.name === slug) }))
    : []
  const staleCount = cited.filter((c) => c.row?.stale).length

  return (
    <div data-testid="mx-ask" className="flex flex-col h-full min-h-0">
      <div className="px-7 py-4 border-b border-rule-structural flex items-center gap-2.5">
        <span className="font-serif text-[20px]">Ask</span>
        <span className="text-xs text-fg-dim flex-1">
          Search and edit this scope's memories in plain language. Answers cite the files they used.
        </span>
        {context && (
          <span data-testid="mx-ask-context" className="flex items-center gap-1.5 pl-2 pr-1 py-[3px] border border-rule rounded-[5px] bg-bg-elev text-xs">
            About <span className="font-mono text-[11.5px]">{context}</span>
            <button aria-label="Clear context" onClick={onClearContext} className="px-1.5 text-fg-dim hover:text-accent">×</button>
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto px-7 py-6 flex flex-col gap-5 max-w-[820px]">
        {!turn && !pending && (
          <div className="my-auto flex flex-col gap-1.5 text-fg-dim text-[13px]">
            <span className="font-serif text-[20px] text-fg">What do you want to know?</span>
            <span>Ask about a symptom, a file or a past decision, or start with "remember" to save something new.</span>
          </div>
        )}
        {turn && (
          <div className="self-end max-w-[520px] px-3.5 py-2.5 rounded-[10px] bg-fg text-bg text-[14px]">{turn.question}</div>
        )}
        {turn?.kind === 'answer' && (
          <div className="flex flex-col gap-2.5 text-[14px] leading-[1.65] text-fg max-w-[680px]">
            <p className="m-0">{turn.answer}</p>
            <div className="flex flex-wrap gap-1.5 items-center">
              {cited.map((c, i) => (
                <button
                  key={c.slug}
                  data-testid={`mx-ask-cite-${c.slug}`}
                  onClick={() => onOpen(c.row?.name ?? c.slug)}
                  className="flex items-center gap-1.5 px-[9px] py-1 border border-rule-structural rounded-[5px] bg-bg text-xs hover:border-fg"
                >
                  <span className="font-mono text-[10.5px] text-accent">[{i + 1}]</span>
                  <span>{c.slug}</span>
                  {c.row && <span className="text-fg-dim">{c.row.ageDays}d</span>}
                  {c.row?.stale && <span className="text-[9.5px] font-semibold px-1 rounded-[3px] bg-butter/40 text-honey-dark">STALE</span>}
                </button>
              ))}
            </div>
            {staleCount > 0 && (
              <div className="px-3 py-2.5 rounded-md bg-butter/40 text-[12.5px] text-fg flex items-center gap-2.5">
                <span className="flex-1">
                  {staleCount} of these {staleCount === 1 ? 'is' : 'are'} flagged stale. Re-verify against the current code?
                </span>
                <button onClick={onReverify} className={BTN}>Re-verify</button>
              </div>
            )}
          </div>
        )}
        {turn?.kind === 'draft' && (
          <div className="max-w-[560px] border border-rule rounded-lg bg-bg-hi p-3.5 flex flex-col gap-2">
            <span data-testid="mx-ask-draft" className="text-[10px] tracking-[.08em] text-sage-dark font-semibold">DRAFT MEMORY · NOT SAVED YET</span>
            <span className="font-serif text-base">{turn.text}</span>
            <div className="flex gap-2">
              <button onClick={() => onDraft(turn.text)} className={`${BTN} h-7 px-3`}>Review draft</button>
              <span className="text-xs text-fg-dim self-center">Opens it in the editor before anything is written</span>
            </div>
          </div>
        )}
        {pending && <span className="text-xs text-fg-dim">Thinking…</span>}
      </div>
      <div className="px-7 pt-3 pb-4 border-t border-rule-structural flex flex-col gap-2.5">
        <div className="flex gap-1.5 flex-wrap items-center">
          {(context ? CTX_CHIPS : CHIPS).map((c) => (
            <button
              key={c}
              onClick={() => setInput(c)}
              className="px-2.5 py-1 border border-rule-structural rounded-[14px] text-xs text-fg-dim hover:bg-bg-elev"
            >
              {c}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <input
            data-testid="mx-ask-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
            placeholder="Ask, or say “remember …” to add a memory"
            className="flex-1 h-11 border border-rule rounded-md bg-bg-hi px-3 text-[13px] text-fg focus:outline-none focus:border-fg-faint"
          />
          <VoiceButton />
          <button
            data-testid="mx-ask-send"
            onClick={() => void send()}
            disabled={pending}
            className="h-11 px-4 rounded-md bg-accent text-white text-[13px] font-medium disabled:opacity-40"
          >
            Send
          </button>
          <span className="text-[10px] text-fg-faint">uses Claude</span>
        </div>
      </div>
    </div>
  )
})
