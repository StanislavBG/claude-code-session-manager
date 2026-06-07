import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { RelaySocket } from '../ws';

// base64 → Uint8Array (handles non-Latin-1 bytes correctly for xterm.js)
function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// string → base64 via UTF-8 encoding (handles emoji, box-drawing, etc.)
function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface Props {
  deviceId: string;
  socket: RelaySocket | null;
  disabled: boolean;
}

// Control sequences sent by on-screen keys
const KEY_SEQUENCES: Record<string, string> = {
  ESC: '\x1b',
  TAB: '\t',
  'CTRL+C': '\x03',
  'CTRL+Z': '\x1a',
  'CTRL+D': '\x04',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
};

export default function TerminalPane({ deviceId, socket, disabled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const [spawned, setSpawned] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // Mount the terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: {
        background: '#0f172a',
        foreground: '#f1f5f9',
        cursor: '#6366f1',
        selectionBackground: '#334155',
        black: '#1e293b',
        brightBlack: '#475569',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#f1f5f9',
        brightWhite: '#ffffff',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      macOptionIsMeta: true,
      allowProposedApi: false,
      scrollback: 3000,
      // Keyboard input is handled through the hidden input overlay on mobile
      disableStdin: false,
    });

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Subscribe to PTY data from relay
  useEffect(() => {
    if (!socket) return;

    const unsub = socket.on('event:pty:data', (msg) => {
      const p = msg.payload as { tabId?: string; data?: string } | undefined;
      if (p?.tabId !== tabIdRef.current) return;
      if (p?.data && termRef.current) {
        // PTY data is base64-encoded (ADR §10.3); write as Uint8Array so
        // xterm.js interprets the bytes as UTF-8 rather than Latin-1.
        termRef.current.write(b64ToBytes(p.data));
      }
    });

    const unsubExit = socket.on('event:pty:exit', (msg) => {
      const p = msg.payload as { tabId?: string } | undefined;
      if (p?.tabId !== tabIdRef.current) return;
      termRef.current?.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
      setSpawned(false);
      tabIdRef.current = null;
    });

    return () => {
      unsub();
      unsubExit();
    };
  }, [socket]);

  // Resize relay when viewport changes (handles soft keyboard open/close)
  useEffect(() => {
    const vvp = window.visualViewport;
    if (!vvp) return;

    const onResize = () => {
      const fit = fitRef.current;
      if (!fit || !termRef.current) return;
      fit.fit();
      const dims = fit.proposeDimensions();
      if (dims && socket && tabIdRef.current) {
        socket.sendCommand('cmd:pty:resize', deviceId, {
          tabId: tabIdRef.current,
          cols: dims.cols,
          rows: dims.rows,
        }).catch(() => {});
      }
    };

    vvp.addEventListener('resize', onResize);
    return () => vvp.removeEventListener('resize', onResize);
  }, [socket, deviceId]);

  // Forward hidden input events to PTY
  const handleInput = useCallback(() => {
    const input = inputRef.current;
    if (!input || !socket || !tabIdRef.current || disabled) return;
    const text = input.value;
    input.value = '';
    if (!text) return;
    // Encode as UTF-8 → base64 to handle emoji and non-Latin-1 input
    const encoded = textToB64(text);
    socket.sendCommand('cmd:pty:write', deviceId, {
      tabId: tabIdRef.current,
      data: encoded,
    }).catch(() => {});
  }, [socket, deviceId, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!socket || !tabIdRef.current || disabled) return;

      // Forward special key combos
      let seq: string | null = null;
      if (e.key === 'Backspace') {
        seq = '\x7f';
      } else if (e.key === 'Enter') {
        seq = '\r';
      } else if (e.key === 'Escape') {
        seq = '\x1b';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        seq = '\t';
      } else if (e.key === 'ArrowUp') {
        seq = '\x1b[A';
      } else if (e.key === 'ArrowDown') {
        seq = '\x1b[B';
      } else if (e.key === 'ArrowLeft') {
        seq = '\x1b[D';
      } else if (e.key === 'ArrowRight') {
        seq = '\x1b[C';
      } else if (e.ctrlKey && e.key === 'c') {
        seq = '\x03';
      } else if (e.ctrlKey && e.key === 'z') {
        seq = '\x1a';
      } else if (e.ctrlKey && e.key === 'd') {
        seq = '\x04';
      }

      if (seq) {
        e.preventDefault();
        const encoded = textToB64(seq);
        socket.sendCommand('cmd:pty:write', deviceId, {
          tabId: tabIdRef.current,
          data: encoded,
        }).catch(() => {});
      }
    },
    [socket, deviceId, disabled],
  );

  const spawnTerminal = useCallback(async () => {
    if (!socket || disabled) return;
    setSpawnError(null);
    try {
      const tabId = crypto.randomUUID();
      const fit = fitRef.current;
      const dims = fit?.proposeDimensions() ?? { cols: 80, rows: 24 };
      await socket.sendCommand('cmd:pty:spawn', deviceId, {
        tabId,
        cols: dims.cols,
        rows: dims.rows,
      });
      tabIdRef.current = tabId;
      setSpawned(true);
      // Focus hidden input so soft keyboard appears
      inputRef.current?.focus();
    } catch (e) {
      setSpawnError(e instanceof Error ? e.message : 'Failed to spawn terminal');
    }
  }, [socket, deviceId, disabled]);

  const sendKey = useCallback(
    (seq: string) => {
      if (!socket || !tabIdRef.current || disabled) return;
      const encoded = textToB64(seq);
      socket.sendCommand('cmd:pty:write', deviceId, {
        tabId: tabIdRef.current,
        data: encoded,
      }).catch(() => {});
    },
    [socket, deviceId, disabled],
  );

  const focusInput = useCallback(() => {
    if (spawned) inputRef.current?.focus();
  }, [spawned]);

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* On-screen key bar (PRIOR-ART §11) */}
      <div
        className="flex items-center gap-1 px-2 py-1 bg-slate-800 border-b border-slate-700 overflow-x-auto flex-shrink-0"
        aria-label="Terminal key shortcuts"
      >
        {Object.entries(KEY_SEQUENCES).map(([label, seq]) => (
          <button
            key={label}
            onPointerDown={(e) => {
              e.preventDefault(); // prevent keyboard hide on iOS
              sendKey(seq);
            }}
            className="
              flex-shrink-0 min-h-touch px-2.5 rounded text-xs font-mono
              text-slate-300 bg-slate-700 active:bg-slate-600
              border border-slate-600
            "
            aria-label={`Send ${label}`}
            disabled={disabled || !spawned}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Terminal canvas */}
      <div
        className="flex-1 relative overflow-hidden p-1"
        onClick={focusInput}
        aria-label="Terminal"
        role="region"
      >
        <div ref={containerRef} className="h-full w-full" />

        {/* Hidden input overlay for mobile keyboard capture */}
        <input
          ref={inputRef}
          type="text"
          className="absolute opacity-0 pointer-events-none w-0 h-0"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-hidden="true"
          tabIndex={-1}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />

        {/* Spawn overlay */}
        {!spawned && !disabled && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/90">
            {spawnError && (
              <p className="text-red-400 text-sm" role="alert">{spawnError}</p>
            )}
            <button
              onClick={spawnTerminal}
              className="
                min-h-touch px-6 rounded-xl bg-indigo-600 text-white
                font-medium text-sm active:bg-indigo-700
              "
              data-testid="new-terminal-btn"
            >
              New Terminal
            </button>
          </div>
        )}

        {disabled && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/80">
            <p className="text-slate-500 text-sm">Device offline</p>
          </div>
        )}
      </div>
    </div>
  );
}
