/**
 * epicIntake — turns the New Epic form's fields into the two strings a new
 * Epic needs, from one source so they can never disagree:
 *
 *   - `goalText`      — the Epic's stored identity (what the queue, Scheduler
 *                       chips and composer header display).
 *   - `openingPrompt` — the first message sent into the Epic's claude session
 *                       automatically at creation, so the Epic opens already
 *                       waiting on the agent instead of on the user retyping
 *                       what they just entered.
 *
 * The title is the session's GOAL; the sub-header (goal field) is the FIRST
 * INSTRUCTION. References are appended as trailing lines to both.
 */

export interface EpicIntakeFields {
  /** Epic title — optional; becomes the session's goal line. */
  title: string
  /** The objective / first instruction. Required (the form gates on it). */
  goal: string
  /** Absolute paths of attached references. */
  referencePaths?: string[]
}

export interface EpicIntake {
  goalText: string
  openingPrompt: string
}

/** File names are user/filesystem controlled and can contain newlines — strip
 *  them so a crafted name can't forge an extra structural line. */
function singleLine(s: string): string {
  return s.replace(/\r?\n/g, ' ')
}

function withReferences(body: string, referencePaths: string[]): string {
  const lines = referencePaths.map((p) => `Reference: ${singleLine(p)}`)
  return lines.length ? `${body}\n\n${lines.join('\n')}` : body
}

/**
 * Compose an Epic's stored `goalText` and its auto-sent opening prompt.
 *
 * Complexity: O(n) in the number of references.
 */
export function composeEpicIntake({ title, goal, referencePaths = [] }: EpicIntakeFields): EpicIntake {
  const trimmedTitle = singleLine(title.trim())
  const trimmedGoal = goal.trim()

  const body = trimmedTitle ? `${trimmedTitle}\n\n${trimmedGoal}` : trimmedGoal
  // The opening prompt names the title as the goal explicitly, so the agent
  // reads it as the objective rather than as the first line of the request.
  const promptBody = trimmedTitle ? `Goal: ${trimmedTitle}\n\n${trimmedGoal}` : trimmedGoal

  return {
    goalText: withReferences(body, referencePaths),
    openingPrompt: withReferences(promptBody, referencePaths),
  }
}
