# web/remote-app/ — relay + E2E rules

Linked from [`CLAUDE.md`](CLAUDE.md). Read before touching the relay path or remote commands.

- Desktop `src/main/webRemote.cjs` is outbound-only (dials the relay, never listens). New commands keep the
  READ/MUTATE tiering (`MUTATE_COMMANDS` gated by default-off `remoteControlEnabled`) and the pair-time pubkey pin.
- E2E wiring rots silently: dropping `App.tsx`'s `socket.initiateE2E(...)` once sent all traffic as plaintext
  (2026-06-08). Tests touching this path must prove only ciphertext (`e2e:box`) crosses the relay.
- The Bilko relay drops any envelope whose `id` is not a UUID (`invalid_envelope`) — batched `ipc:result`
  ids like `<uuid>.<n>` stalled the web UI (2026-11-05). All `config:*` channels are `deny` remotely (`apiSurface.json`).
- Relay limits: 256 KB per message (socket closed past it; chunk at ≤180 KB) and ~1 msg/s sustained
  browser→desktop (batch calls). Browser→desktop messages over 180 KB travel as boxed `e2e:frame` sequences
  (`remoteFrameAssembler.cjs` ⇄ `web/remote-app/src/frames.ts`), sent only to desktops advertising
  `'e2e-frames'` in `event:remote:ready` `capabilities`. Phones keep the drill-down + its `cmd:*` handlers — never retire them.
