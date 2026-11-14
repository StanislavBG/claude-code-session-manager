import { useChat, type ChatTurn } from '../state/chat'
import { useQuestionDrafts, questionCardKey, type QuestionDraft } from '../state/questionDrafts'
import { normalizeQuestions } from '../lib/stopSignal'
import { composeQuestionReply, type QuestionResolution } from '../lib/questionReply'
import type { QuestionCardState } from '../lib/questionCardState'

/**
 * QuestionCard — the body of a needs-input question turn. Each question gets
 * its own answer box plus "You decide"; resolving the last open question sends
 * ONE combined reply (lib/questionReply.ts) through the same useChat.send path
 * the Epic composer uses. Drafts live in state/questionDrafts.ts so they
 * survive unmount. Never imports ChatTranscriptTurn.tsx (circular) — tint
 * classes arrive as props.
 */

const FREE_FORM_LABEL = 'Your reply'
const FREE_FORM_DELEGATE = 'You decide — make the call you judge best and tell me what you chose.'
const EMPTY_TEXT: Record<number, string> = {}
const EMPTY_RESOLVED: Record<number, QuestionResolution> = {}

function questionsOf(turn: ChatTurn): string[] {
  const fromList = normalizeQuestions(turn.questions)
  if (fromList.length > 0) return fromList
  return normalizeQuestions(turn.text.split('\n'))
}

function allResolved(count: number, resolved: Record<number, QuestionResolution>): boolean {
  for (let i = 0; i < count; i++) if (!(i in resolved)) return false
  return true
}

function composePrompt(questions: string[], freeForm: boolean, resolved: Record<number, QuestionResolution>): string {
  const resolutions = questions.map((_, i) => resolved[i])
  if (freeForm) {
    const r = resolutions[0]
    if (r.kind === 'answer') return r.text.trim()
    const note = (r.note ?? '').trim()
    return note ? `${FREE_FORM_DELEGATE} My note: ${note}` : FREE_FORM_DELEGATE
  }
  return composeQuestionReply(questions, resolutions)
}

export function QuestionCard({
  turn,
  tabId,
  sessionId,
  cwd,
  cardState,
  tintClass,
  textClass,
}: {
  turn: ChatTurn
  tabId: string
  sessionId: string
  cwd: string
  cardState: QuestionCardState
  tintClass: string
  textClass: string
}) {
  const key = questionCardKey(tabId, turn)
  // Raw slice only; defaults applied outside the selector (React #185).
  const draft: QuestionDraft | undefined = useQuestionDrafts((s) => s.drafts[key])
  const texts = draft?.text ?? EMPTY_TEXT
  const resolved = draft?.resolved ?? EMPTY_RESOLVED
  const submitted = draft?.submitted

  const parsed = questionsOf(turn)
  const freeForm = parsed.length === 0
  const questions = freeForm ? [FREE_FORM_LABEL] : parsed

  const trySend = () => {
    const current = useQuestionDrafts.getState().drafts[key]
    if (!current || current.submitted) return
    if (!allResolved(questions.length, current.resolved)) return
    const prompt = composePrompt(questions, freeForm, current.resolved)
    // send() toasts its own refusal — no second toast here.
    const result = useChat.getState().send({ tabId, sessionId, cwd, prompt })
    if (result.disposition === 'sent' || result.disposition === 'queued') {
      useQuestionDrafts.getState().markSubmitted(key, result.disposition)
    }
  }

  const resolveAndMaybeSend = (index: number, resolution: QuestionResolution) => {
    const store = useQuestionDrafts.getState()
    store.resolve(key, index, resolution)
    trySend()
  }

  const commitAnswer = (index: number) => {
    const text = (texts[index] ?? '').trim()
    if (!text) return
    resolveAndMaybeSend(index, { kind: 'answer', text })
  }

  const delegate = (index: number) => {
    const note = (texts[index] ?? '').trim()
    resolveAndMaybeSend(index, note ? { kind: 'delegate', note } : { kind: 'delegate' })
  }

  const readOnly = cardState !== 'open' || submitted !== undefined
  const resolvedCount = questions.filter((_, i) => i in resolved).length
  const buttonClass = `rounded-lg border border-current px-3 py-1.5 text-xs font-semibold hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent ${textClass}`

  const renderResolution = (r: QuestionResolution) =>
    r.kind === 'answer' ? (
      <span className="whitespace-pre-wrap">{r.text}</span>
    ) : (
      <span>
        <span className="font-semibold">You decide</span>
        {r.note ? <span className="whitespace-pre-wrap"> — {r.note}</span> : null}
      </span>
    )

  if (readOnly) {
    return (
      <div data-testid="question-card" data-card-state={cardState}>
        <ol className="space-y-2">
          {questions.map((q, i) => (
            <li key={i} data-testid="question-row" className="break-words">
              <div className="whitespace-pre-wrap">{q}</div>
              {resolved[i] ? (
                <div className="mt-1 text-xs opacity-80">{renderResolution(resolved[i])}</div>
              ) : null}
            </li>
          ))}
        </ol>
        <div className={`mt-2 border-t pt-2 text-xs ${tintClass}`}>
          {cardState === 'answered' ? (
            <span data-testid="question-card-answered" className={`rounded border border-current px-2 py-0.5 font-semibold ${textClass}`}>
              Answered
            </span>
          ) : cardState === 'superseded' ? (
            <span data-testid="question-card-superseded" className={`rounded border border-current px-2 py-0.5 font-semibold ${textClass}`}>
              Superseded by a newer question
            </span>
          ) : submitted === 'queued' ? (
            <span data-testid="question-card-queued">Reply queued — it sends when the current run finishes.</span>
          ) : (
            <span data-testid="question-card-sent">Reply sent.</span>
          )}
        </div>
      </div>
    )
  }

  const everyResolved = allResolved(questions.length, resolved)

  return (
    <div data-testid="question-card" data-card-state={cardState}>
      <ol className="space-y-3">
        {questions.map((q, i) => {
          const r = resolved[i]
          const text = texts[i] ?? ''
          return (
            <li key={i} data-testid="question-row" className="break-words">
              <div className="whitespace-pre-wrap">
                {questions.length > 1 ? <span className="font-semibold">{i + 1}. </span> : null}
                {q}
              </div>
              {r ? (
                <div className="mt-1 flex items-start gap-2 text-xs">
                  <div className="min-w-0 flex-1 opacity-90">{renderResolution(r)}</div>
                  <button
                    type="button"
                    data-testid="question-edit"
                    onClick={() => useQuestionDrafts.getState().reopen(key, i)}
                    className={buttonClass}
                  >
                    Edit
                  </button>
                </div>
              ) : (
                <div className="mt-1.5">
                  <textarea
                    data-testid="question-answer-input"
                    aria-label={`Answer to question ${i + 1}`}
                    rows={2}
                    value={text}
                    onChange={(e) => useQuestionDrafts.getState().setText(key, i, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        commitAnswer(i)
                      }
                    }}
                    placeholder="Type your answer — Enter to commit, Shift+Enter for a new line"
                    className="w-full resize-y rounded-md border border-current bg-transparent px-2 py-1.5 text-sm placeholder:text-fg-faint focus:outline-none"
                  />
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="question-answer-submit"
                      onClick={() => commitAnswer(i)}
                      disabled={!text.trim()}
                      className={buttonClass}
                    >
                      Answer
                    </button>
                    <button
                      type="button"
                      data-testid="question-delegate"
                      onClick={() => delegate(i)}
                      title="Let the agent decide — any text typed above is sent as a note"
                      className={buttonClass}
                    >
                      You decide
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <div className={`mt-2 flex flex-wrap items-center gap-2 border-t pt-2 text-xs ${tintClass}`}>
        <span data-testid="question-progress">
          {resolvedCount} of {questions.length} answered · your reply sends when every question has an answer or “You decide”.
        </span>
        {everyResolved ? (
          <button type="button" data-testid="question-send" onClick={trySend} className={buttonClass}>
            Send answers
          </button>
        ) : null}
      </div>
    </div>
  )
}
