/**
 * Cross-component draft-text handoff for a freshly created Epic: BuildButton's
 * advanced ("discuss first") path creates the Epic and selects it, but wants
 * EpicComposer — mounted a beat later once EpicsWorkspace re-renders with the
 * new selection — to open with the opening prompt sitting in the composer as
 * editable, unsent text instead of firing it immediately.
 *
 * Mirrors promptSessionDeepLink.ts's pending-value pattern: a module-level
 * value set synchronously before `onSelect`, consumed once by the composer's
 * existing epic.id-keyed reset effect so no new prefill mechanism is needed.
 */

let pending: { epicId: string; text: string } | null = null

export function setPendingEpicDraft(epicId: string, text: string): void {
  pending = { epicId, text }
}

/** Reads and unconditionally clears the pending draft — call once from the
 *  consumer's epic.id-keyed reset effect. Returns null (without disturbing a
 *  still-pending draft for a different epic) when `epicId` doesn't match, so
 *  an unrelated Epic mounting first can't steal or drop someone else's draft. */
export function takePendingEpicDraft(epicId: string): string | null {
  if (!pending) return null
  if (pending.epicId !== epicId) return null
  const text = pending.text
  pending = null
  return text
}
