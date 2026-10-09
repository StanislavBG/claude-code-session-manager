// Electron's permission handler (index.cjs) only grants media/audioCapture/
// microphone, so navigator.clipboard.writeText() always rejects here ("Write
// permission denied") and the OS clipboard keeps its OLD contents. Write
// through the main-process IPC path instead.
export async function copyText(text: string): Promise<boolean> {
  try {
    const r = await window.api.clipboard.writeText(text)
    return r?.ok === true
  } catch {
    return false
  }
}
