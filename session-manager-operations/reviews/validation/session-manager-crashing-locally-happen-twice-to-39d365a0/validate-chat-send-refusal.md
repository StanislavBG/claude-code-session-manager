# Validation: chat-send-reports-a-refused-prompt (PRD 2476)

Base: 16f7151f (given). Commit for the PRD's files: e73b6e7e (only one touching them in base..HEAD).

## chat-send-reports-a-refused-prompt — VERIFIED

- AC1 (await + `{ ok, disposition, reason }`, ok false only on refused): `src/main/chatRunner.cjs:1143-1148` awaits `enqueueExternalPrompt` and sends `ok: outcome.disposition !== 'refused'`, plus disposition and optional reason. 400 path above it is unchanged.
- AC2 (unconfirmed stays ok true): `enqueueExternalPrompt` (`chatRunner.cjs:1082-1101`) resolves `unconfirmed` with `no-window` or `timeout`, never rejects. Route maps that to ok true. Test asserts `{ ok: true, disposition: 'unconfirmed', reason: 'timeout' }`.
- AC3 (docs): `src/main/lib/mcpToolCatalog.cjs:249-250` notes say tabId is an open tab's id or an Epic id, never a Claude session id, and a refused send returns ok false. `scripts/scheduler-mcp-server.cjs:390` tabId description carries the same wording.
- AC4 (tests): `tests/unit/chatRunner.spec.ts` has a refused-send test (`{ ok:false, disposition:'refused', reason:'unknown-tab' }`) and an unconfirmed ack-timeout test, both through the route handler. The happy-path test was updated to the new shape.
- Gate (re-run with all SM_* unset): `npx vitest run tests/unit/chatRunner.spec.ts` gave 44 passed; `npm run typecheck` exited 0.

## Findings

### Critical
none
### Important
none
### Minor
- `src/main/chatRunner.cjs` now exports `settleExternalSend` (test-only need). It is within the PRD's Files list and was disclosed. Low risk.
- The refused test uses a real 20 ms sleep (`chatRunner.spec.ts`) to wait for the broadcast, which could be flaky under heavy load. It passed here.
- Review was a self-review of the diff (no unsafe input handling, secrets, or path handling added).
