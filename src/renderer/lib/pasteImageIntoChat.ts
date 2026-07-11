// Resolves what a clipboard paste into the chat textarea should produce.
// Mirrors Terminal.tsx:146-163 (image-first, text fallback). O(1) apart from the
// O(n) string splice, n = draft length (tiny). Pure except for the injected async deps.
export interface PasteDeps {
  pasteImage: () => Promise<
    | { ok: true; path: string; bytes: number }
    | { ok: false; empty?: true; error?: string }
  >
  readText: () => Promise<string>
}

export interface PasteResult {
  // New textarea value after inserting at the selection range.
  value: string
  // New caret position (end of the inserted text).
  caret: number
  // Toast message to show, or null when none (plain text paste).
  toast: string | null
}

// insert `text` into `value`, replacing [selStart, selEnd).
export function spliceAtSelection(
  value: string,
  selStart: number,
  selEnd: number,
  text: string,
): { value: string; caret: number } {
  const next = value.slice(0, selStart) + text + value.slice(selEnd)
  return { value: next, caret: selStart + text.length }
}

export async function resolveChatPaste(
  deps: PasteDeps,
  draft: string,
  selStart: number,
  selEnd: number,
): Promise<PasteResult> {
  let img: Awaited<ReturnType<PasteDeps['pasteImage']>> | null = null
  try {
    img = await deps.pasteImage()
  } catch {
    img = null
  }
  if (img && img.ok) {
    const insert = img.path + ' '
    const { value, caret } = spliceAtSelection(draft, selStart, selEnd, insert)
    return { value, caret, toast: `Pasted image: ${img.path.split('/').pop()}` }
  }
  const text = await deps.readText()
  const { value, caret } = spliceAtSelection(draft, selStart, selEnd, text)
  return { value, caret, toast: null }
}
