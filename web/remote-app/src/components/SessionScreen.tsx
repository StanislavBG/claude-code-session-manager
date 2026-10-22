import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelaySocket } from '../ws';
import { useStore } from '../store';
import { getTranscript, listSessionPrds } from '../remoteApi';
import type { ChatMessage, RemoteSession, SendChatResult, SessionPrd } from '../types';
import StatePane from './StatePane';
import MicPane from './MicPane';

export type SessionTarget =
  | { kind: 'main'; mainTabId: string; title: string }
  | { kind: 'epic'; session: RemoteSession };

const POLL_MS = 4000;
const MAX_POLLS_PER_SEND = 45;

const PENDING_LABEL: Record<SendChatResult['disposition'], string> = {
  queued: 'Queued — another turn is running',
  sent: 'Sent',
  unconfirmed: 'Sent — waiting for your computer to confirm',
};

interface Pending {
  text: string;
  disposition: SendChatResult['disposition'];
  sentAt: number;
}

interface Props {
  socket: RelaySocket | null;
  deviceId: string;
  projectCwd: string;
  target: SessionTarget;
  onBack: () => void;
}

/** Phone equivalent of opening an Epic: transcript, PRDs, live state and a composer. */
export default function SessionScreen({ socket, deviceId, projectCwd, target, onBack }: Props) {
  const isEpic = target.kind === 'epic';
  const sendTarget = isEpic ? target.session.epicId : target.mainTabId;
  const liveTabId: string | null = isEpic ? target.session.claudeSessionId : target.mainTabId;
  const subscribeCwd = isEpic ? target.session.spawnCwd || projectCwd : projectCwd;
  const title = isEpic ? target.session.title : target.title;
  const status = isEpic ? target.session.status : null;

  const liveState = useStore((s) => (liveTabId ? s.stateByTab[liveTabId] : undefined));

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prds, setPrds] = useState<SessionPrd[]>([]);
  const [prdError, setPrdError] = useState<string | null>(null);
  const [prdsOpen, setPrdsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pollCount = useRef(0);
  const olderLoaded = useRef(false);

  const loadTranscript = useCallback(async () => {
    if (!socket) return;
    try {
      const r = await getTranscript(socket, deviceId, { cwd: projectCwd, sessionKey: sendTarget, limit: 10 });
      const page = r?.messages ?? [];
      setMessages((prev) => {
        if (page.length === 0) return prev;
        const floor = Math.min(...page.map((m) => m.ts));
        const ids = new Set(page.map((m) => m.uuid));
        return [...prev.filter((m) => m.ts < floor && !ids.has(m.uuid)), ...page];
      });
      if (!olderLoaded.current) {
        setHasMore(r?.hasMore === true);
        setNextBefore(r?.nextBefore ?? null);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [socket, deviceId, projectCwd, sendTarget]);

  const loadEarlier = useCallback(async () => {
    if (!socket || nextBefore === null || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const r = await getTranscript(socket, deviceId, { cwd: projectCwd, sessionKey: sendTarget, limit: 10, before: nextBefore });
      const page = r?.messages ?? [];
      olderLoaded.current = true;
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.uuid));
        return [...page.filter((m) => !ids.has(m.uuid)), ...prev];
      });
      setHasMore(r?.hasMore === true);
      setNextBefore(r?.nextBefore ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingEarlier(false);
    }
  }, [socket, deviceId, projectCwd, sendTarget, nextBefore, loadingEarlier]);

  useEffect(() => { void loadTranscript(); }, [loadTranscript]);

  const handleSent = useCallback((prompt: string, result: SendChatResult) => {
    pollCount.current = 0;
    setPending({ text: prompt.trim(), disposition: result.disposition, sentAt: Date.now() });
  }, []);

  // The pending bubble goes away once the transcript echoes the prompt.
  useEffect(() => {
    if (!pending) return;
    if (messages.some((m) => m.role === 'user' && m.text.includes(pending.text))) setPending(null);
  }, [messages, pending]);

  // Re-fetch when the live state settles (turn finished / needs input).
  const firstState = useRef(true);
  useEffect(() => {
    if (firstState.current) { firstState.current = false; return; }
    if (liveState === 'idle' || liveState === 'awaiting-input') void loadTranscript();
  }, [liveState, loadTranscript]);

  const polling = !!pending || liveState === 'thinking' || liveState === 'running';
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      if (pollCount.current >= MAX_POLLS_PER_SEND) { clearInterval(id); return; }
      pollCount.current += 1;
      void loadTranscript();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [polling, loadTranscript]);

  useEffect(() => {
    if (!socket || !isEpic) return;
    let cancelled = false;
    listSessionPrds(socket, deviceId, { cwd: projectCwd, epicId: sendTarget })
      .then((r) => { if (!cancelled) { setPrds(r?.prds ?? []); setPrdError(null); } })
      .catch((e) => { if (!cancelled) setPrdError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [socket, deviceId, projectCwd, sendTarget, isEpic]);

  useEffect(() => {
    if (!socket || !liveTabId) return;
    socket.sendCommand('cmd:session:subscribe', deviceId, { tabId: liveTabId, cwd: subscribeCwd })?.catch?.(() => {});
    return () => {
      socket.sendCommand('cmd:session:unsubscribe', deviceId, { tabId: liveTabId })?.catch?.(() => {});
    };
  }, [socket, deviceId, liveTabId, subscribeCwd]);

  useEffect(() => { bottomRef.current?.scrollIntoView?.({ block: 'end' }); }, [messages, pending]);

  const disabledReason =
    status === 'proposed' ? 'This session is proposed — approve it on your computer first.'
      : status === 'completed' ? 'This session is completed.'
        : undefined;

  return (
    <div className="flex flex-col h-dvh text-ink" data-testid="session-screen">
      <header className="flex items-center gap-3 px-3 h-12 border-b border-edge bg-paper flex-shrink-0">
        <button onClick={onBack} data-track="session-back" aria-label="Back" className="min-h-touch min-w-touch text-ink active:text-accent">‹ Back</button>
        <span className="flex-1 font-serif text-lg font-semibold truncate">{title}</span>
        <button onClick={() => void loadTranscript()} data-track="session-refresh" className="min-h-touch text-sm text-ink-soft active:text-accent">Refresh</button>
        {status && <span className="text-xs font-mono text-ink-soft" data-testid="session-status">{status}</span>}
      </header>

      {liveTabId && <StatePane tabId={liveTabId} />}

      {isEpic && (
        <section className="border-b border-edge bg-panel px-3.5 py-2 flex-shrink-0">
          <button onClick={() => setPrdsOpen((o) => !o)} data-track="session-prds-toggle" aria-expanded={prdsOpen} className="text-sm font-medium text-ink">
            PRDs ({prds.length})
          </button>
          {prdError && <div className="text-xs text-accent mt-1" role="alert">{prdError}</div>}
          {prdsOpen && (
            <ul className="mt-1 text-sm" data-testid="prd-list">
              {prds.map((p) => (
                <li key={p.slug} className="flex justify-between gap-2">
                  <span className="truncate">{p.title}</span>
                  <span className="font-mono text-xs text-ink-mute">{p.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="flex-1 overflow-y-auto rm-scroll px-3.5 py-3 space-y-2" data-testid="transcript">
        {error && <div className="text-xs text-accent" role="alert">{error}</div>}
        {hasMore && (
          <button
            onClick={() => void loadEarlier()}
            disabled={loadingEarlier}
            data-track="session-load-earlier"
            className="block mx-auto text-xs font-mono text-ink-soft border border-edge rounded-full px-3 py-1 disabled:opacity-50"
          >
            Load earlier
          </button>
        )}
        {messages.map((m) => (
          <div
            key={m.uuid}
            data-testid="chat-message"
            data-role={m.role}
            className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[14.5px] whitespace-pre-wrap break-words ${
              m.role === 'user' ? 'ml-auto bg-accent text-white' : `mr-auto bg-card border border-edge text-ink${m.live ? ' opacity-70 italic' : ''}`
            }`}
          >
            {m.text}
          </div>
        ))}
        {pending && (
          <div className="max-w-[85%] ml-auto" data-testid="pending-message">
            <div className="rounded-2xl px-3.5 py-2 text-[14.5px] whitespace-pre-wrap break-words bg-accent text-white opacity-70">{pending.text}</div>
            <div className="text-[11px] text-ink-mute text-right mt-0.5" data-testid="pending-label">{PENDING_LABEL[pending.disposition]}</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <MicPane socket={socket} deviceId={deviceId} target={sendTarget} disabledReason={disabledReason} onSent={handleSent} />
    </div>
  );
}
