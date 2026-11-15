# Validation: phone composer plan (3163, 3164, 3165)

Base: 989bdb7f1f07be5c62178be7dd9885f4d45a0971; HEAD c4f4b73c. Commits: aaca17e1 (3163), 455db596 (3164), c4f4b73c (3165).
Node modules are absent in the job worktree, so gates were run from the main checkout /home/bilko/Projects/session-manager. It was at the same HEAD with a clean web/remote-app.

## phone-session-screen-fills-main — VERIFIED
- SessionScreen.tsx:163 root `flex-1 min-h-0 flex flex-col text-ink`, data-testid kept; grep finds no h-dvh/h-screen/100vh. Transcript div :192 has `min-h-0`.
- :56 `transcriptRef`; :150-156 effect sets `el.scrollTop = el.scrollHeight`; no scrollIntoView and no bottomRef (grep clean).
- Spec seeds a long transcript; the 4 spec tests (390x844, 375x667, tall-header, 375x667 multi-line) pass. The reachability helper and the 59px header test are present.
- web/remote-app/CLAUDE.md: +1 line (diff stat).
- Gate: browser spec + session-screen.spec.tsx = 18 passed; typecheck exit 0.

## phone-composer-multiline-chips-fill — VERIFIED
- MicPane.tsx:164-185 `<textarea rows={1}>`, placeholder 'Message this session…', max-h-[136px] overflow-y-auto; Send always rendered (:180-188) with aria-label 'Send message', data-track 'mic-send', disabled on sending/empty/disabledReason.
- :173-177 Enter handler: ignores Shift and isComposing, sends only if finePointer() (:35, guarded). Prompt sent is `text.trim()` (:96).
- :110-115 chips fill (`text + ' ' + q`) and never send; :121 source = voice | chip (chipFill ref) | text; onChange clears chipFill.
- mic-pane.spec.tsx added (17 tests); session-screen and telemetry-mic specs updated.
- Gate: mic-pane + session-screen + telemetry-mic + data-track-unique = 40 passed; typecheck exit 0.

## phone-chain-multiline-send-proof — VERIFIED
- The 375x667 test "a chip only fills the composer, then a typed three-line message grows the composer and reaches the chat queue" passes. It covers the chip leaving the enqueue count unchanged, three Shift+Enter lines, growth, reachability, exactly one new enqueue call with the three-line prompt, and the 'Sent' pending bubble.
- Only the spec file changed for this PRD (no product code).
- Gate: full remote-app suite 36 files, 257 passed / 1 skipped; typecheck exit 0.

## Screenshots (printed by the spec, /tmp/sm-phone-chain-shots-6UtuKD/)
Inspected visually. In each, the textarea and Send button are fully visible at the bottom, below the chips row, with nothing clipped.
- 1-projects.png, 2-sessions.png (not inspected)
- 3-session-after-send.png (390x844, pending 'Sent' bubble)
- 4-session-375x667.png
- 5-session-tall-header.png (header +59px)
- 6-session-375x667-multiline-sent.png (three-line bubble, label 'Sent')

## Combined diff review (7 files, +491/-55; /code-review and /security-review not run, self-reviewed)
Correctness, input handling, secrets, path traversal and helper duplication all checked.
No telemetry carries message text (chips keep data-track-redact; source is an enum). Prompt is trimmed and goes through the unchanged sendChat. No secrets or paths touched.

### Critical
none
### Important
none
### Minor
- Missing: the Gate-less per-PRD files were all present, so no missing-file finding.
- MicPane.tsx:164 + SessionScreen.tsx header/StatePane: at 375x667 the header, status and PRDs rows take about 300 of 667px, so the transcript gets roughly a third of the screen (4-session-375x667.png). The composer is reachable; this is a density observation, not a regression.
- The textarea auto-grow uses a hard `max-h-[136px]` (MicPane.tsx:166), not a computed 6 lines. It is equivalent at 20px line height; it drifts if the font scale changes.
- session-screen.spec.tsx emits React act() warnings (pre-existing style, not failures).
- Gates cannot run inside the job worktree (no web/remote-app node_modules); environment note only.
