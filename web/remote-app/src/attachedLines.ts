/**
 * Splits the trailing `Attached: <abs path>` lines (written by the desktop's composeAttachedPrompt / EpicComposer)
 * off a transcript message so the UI can render them as compact chips. Only a trailing run is peeled — an
 * `Attached:` line followed by other text stays in the body.
 */
export interface AttachedRef {
  path: string;
  label: string;
}

const ATTACHED_RE = /^Attached: (.+)$/;
const ID_PREFIX_RE = /^[0-9a-z]{6,12}-/i;

export function attachmentLabel(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const stripped = base.replace(ID_PREFIX_RE, '');
  return stripped || base;
}

export function splitAttachedLines(text: string): { body: string; attachments: AttachedRef[] } {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  const paths: string[] = [];
  let i = end;
  while (i > 0) {
    const m = ATTACHED_RE.exec(lines[i - 1].replace(/\r$/, ''));
    if (!m) break;
    paths.unshift(m[1].trim());
    i -= 1;
  }
  if (paths.length === 0) return { body: text, attachments: [] };
  return {
    body: lines.slice(0, i).join('\n').trim(),
    attachments: paths.map((path) => ({ path, label: attachmentLabel(path) })),
  };
}
