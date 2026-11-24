import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { deviceLabel } from '../devices';
import { getBoxes, patchBox, deleteBox, type FeedbackBox } from '../api';
import { keyFingerprint, snippetFor } from '../feedbackSnippet';

/**
 * The signed-in account's feedback widgets ("websites"), shown in the device picker below the
 * paired computers. One collapsed row until opened; nothing at all when there are none.
 * Creating a widget stays on the desktop — its private key is made there.
 */
export default function WebsitesList() {
  const deviceMeta = useStore((s) => s.deviceMeta);
  const [boxes, setBoxes] = useState<FeedbackBox[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getBoxes();
      if (r.ok) setBoxes(r.data);
    } catch {
      // A failed list read just keeps the section hidden; there is nothing to manage.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (boxes.length === 0) return null;

  const copy = async (b: FeedbackBox) => {
    setErr(null);
    try {
      const fp = await keyFingerprint(b.publicKey);
      await navigator.clipboard.writeText(snippetFor(b.boxId, fp));
      setCopiedId(b.boxId);
    } catch (e: any) {
      setErr(e?.message ? `Copy failed: ${e.message}` : 'Copy failed');
    }
  };

  const toggle = async (b: FeedbackBox) => {
    setBusyId(b.boxId); setErr(null);
    const r = await patchBox(b.boxId, { state: b.state === 'open' ? 'paused' : 'open' });
    if (r.ok) setBoxes((xs) => xs.map((x) => (x.boxId === b.boxId ? { ...x, ...r.data } : x)));
    else setErr(`Could not update ${b.label}: ${r.error}`);
    setBusyId(null);
  };

  const remove = async (b: FeedbackBox) => {
    if (!window.confirm(`Delete ${b.label}? The widget on its sites stops working and pending feedback is lost.`)) return;
    setBusyId(b.boxId); setErr(null);
    const r = await deleteBox(b.boxId);
    if (r.ok) setBoxes((xs) => xs.filter((x) => x.boxId !== b.boxId));
    else setErr(`Could not delete ${b.label}: ${r.error}`);
    setBusyId(null);
  };

  return (
    <section data-testid="websites-list" className="mb-4 border-t border-edge pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="websites-toggle"
        data-track="websites-toggle"
        className="w-full flex items-center py-1.5 text-left text-sm font-semibold text-ink"
      >
        <span className="flex-1">Websites ({boxes.length})</span>
        <span className="text-xs text-ink-mute">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div data-testid="websites-body">
          <p className="mt-1 mb-2 text-xs text-ink-mute">
            New widgets are created from Session Manager on the desktop (Project Home &gt; Feedback, or ask your agent).
          </p>
          <ul className="divide-y divide-edge">
            {boxes.map((b) => (
              <li key={b.boxId} data-testid={`website-row-${b.boxId}`} className="py-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-sm font-semibold text-ink truncate">{b.label}</span>
                  <span
                    data-testid={`website-state-${b.boxId}`}
                    className={`text-xs font-mono ${b.state === 'open' ? 'text-sage' : 'text-ink-mute'}`}
                  >
                    {b.state}
                  </span>
                </div>
                <p className="text-xs text-ink-mute truncate">
                  {b.allowedOrigins.length ? b.allowedOrigins.join(', ') : 'No sites allowed yet'}
                </p>
                <p className="text-xs text-ink-mute truncate">
                  {b.pending} pending · on {deviceLabel(b.deviceId, deviceMeta[b.deviceId])}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => copy(b)}
                    data-testid={`website-copy-${b.boxId}`}
                    data-track="websites-copy-snippet"
                    className="px-2 py-1.5 rounded-lg text-xs text-ink-soft hover:text-ink border border-edge"
                  >
                    {copiedId === b.boxId ? 'Copied' : 'Copy snippet'}
                  </button>
                  <button
                    onClick={() => toggle(b)}
                    disabled={busyId !== null}
                    data-testid={`website-pause-${b.boxId}`}
                    data-track="websites-pause-resume"
                    className="px-2 py-1.5 rounded-lg text-xs text-ink-soft hover:text-ink border border-edge disabled:opacity-50"
                  >
                    {b.state === 'open' ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    onClick={() => remove(b)}
                    disabled={busyId !== null}
                    data-testid={`website-delete-${b.boxId}`}
                    data-track="websites-delete"
                    className="px-2 py-1.5 rounded-lg text-xs text-ink-soft hover:text-ink border border-edge disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
        </div>
      )}
    </section>
  );
}
