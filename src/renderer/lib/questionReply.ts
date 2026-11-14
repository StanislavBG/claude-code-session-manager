/**
 * questionReply.ts — builds the single reply prompt the Epic question card
 * sends back once the human has resolved every question.
 *
 * Flow: the agent ends a turn with `<<<SM_NEEDS_INPUT>>>` + `{"questions":[...]}`
 * (see `STOP_SIGNAL_INSTRUCTION` in `src/main/chatRunner.cjs`). The Epic
 * "NEEDS YOUR DECISION" card lets the human resolve each question on its own —
 * a typed answer or "You decide" (optionally with a note). When all are
 * resolved, this module turns the questions + resolutions into one prompt,
 * which the card sends through `useChat.send`.
 *
 * Pure: no imports from state or components.
 */

export type QuestionResolution =
  | { kind: 'answer'; text: string }
  | { kind: 'delegate'; note?: string }

const DELEGATE_LINE =
  'Answer: You decide — make the call you judge best and tell me what you chose.'

function answerLine(resolution: QuestionResolution, index: number): string {
  if (resolution.kind === 'answer') {
    const text = resolution.text.trim()
    if (!text) throw new Error(`composeQuestionReply: answer ${index + 1} is empty`)
    return `Answer: ${text}`
  }
  const note = (resolution.note ?? '').trim()
  return note ? `${DELEGATE_LINE} My note: ${note}` : DELEGATE_LINE
}

export function composeQuestionReply(
  questions: string[],
  resolutions: QuestionResolution[],
): string {
  if (questions.length === 0) {
    throw new Error('composeQuestionReply: no questions')
  }
  if (resolutions.length !== questions.length) {
    throw new Error(
      `composeQuestionReply: ${resolutions.length} resolutions for ${questions.length} questions`,
    )
  }
  const lines: string[] = [
    questions.length === 1 ? 'Answer to your question:' : 'Answers to your questions:',
  ]
  questions.forEach((question, i) => {
    lines.push('', `${i + 1}. ${question}`, answerLine(resolutions[i], i))
  })
  return lines.join('\n')
}
