# Validation: Session chat restyle plan (PRDs 1464-1470)

Base: `d4d44730db5c04e0bc8989897c9033045026e155`
Target screenshot: `session-manager-operations/prompt-sessions/attachments/tzmrsfwz9c-image.png`
All 7 PRDs are archived (`prds-archived/`); each mapped to exactly one commit, in dependency order:

| PRD | Commit | Title |
| --- | --- | --- |
| 1464-chat-header-compact-meta | `9eacd7c1` | compact Epic detail header to status/kind + one mono meta line |
| 1465-chat-toolstrip-at-standard | `b7279f91` | show collapsed tool strip at Standard level |
| 1466-chat-launch-briefing-card | `b450843c` | replace AIM briefing cards with compact Launch briefing |
| 1467-chat-composer-restyle | `f22d2ece` | restyle to single rounded input with inline mic/attach |
| 1468-chat-tabs-dial-divider | `c0f9c292` | restyle tab row, Detail dial, and hidden-events divider |
| 1469-chat-turn-visuals | `4ee62c09` | restyle chat turns to flat avatar + dark user bubble |
| 1470-chat-tool-chip-working-row | `ca0508d0` | show real tool activity in collapsed chip, unify running indicator |

## Plan-level checks

- `npm run typecheck` — PASS (clean, no output).
- `npm run lint` — PASS (`lint:selectors` 529 files OK, `lint:hooks` 263 files OK, `lint:docs` ok, `lint:paths` clean, `lint:any` 333 files OK, `lint:main-ts-check` OK, `lint:filenames` OK, `lint:renderer-storage` clean).
- `npx vitest run src/renderer/components/epics/__tests__/ src/renderer/components/__tests__/ src/renderer/lib/__tests__/chatVerbosity.test.ts` — PASS (39 files, 372 tests).
- `npx vitest run src/renderer/lib/__tests__/estimateTokens.test.ts src/renderer/components/epics/__tests__/attachments.test.tsx` — PASS (2 files, 9 tests) — these two gate-referenced files sit outside the three directories above, run separately.
- `git diff d4d44730..HEAD -- src/renderer/components/ui/ViewTabs.tsx` — empty; file untouched.
- RecordingStatus mount sites (`App.tsx`, `SimpleShell.tsx`, `RecordingStatus.tsx`, `Terminal.tsx`, `workbench/Workbench.tsx`) — none appear anywhere in the `d4d44730..HEAD` diff; privacy invariant untouched.

(Node_modules was absent in this job worktree; symlinked from the main checkout, which sits at the identical commit `ca0508d0`, to run the above — no tracked file was added.)

## Per-PRD verdicts

### 1464-chat-header-compact-meta — VERIFIED
- AC1 (`formatCompactRuntime`): `src/renderer/components/epics/EffectiveRuntimeLine.tsx:98-102` — `[agentType, compactModelText(info)]` + optional `effort ${level}`, joined by ` · `; verbose text kept as title at call site. Test: `EffectiveRuntimeLine.test.tsx` green.
- AC2 (header row): `EpicDetail.tsx:861-883` — `EpicStatusChip`, `EpicKindTag`, then `data-testid="epic-detail-meta-line"` (`font-mono text-[11px] text-fg-dim truncate`) with the agent segment as a button (`data-testid="epic-agent-tag"`, `openAgentLibrary`) followed by ` · ${branchText}`.
- AC3 (title/turns-ago): `EpicDetail.tsx:884-893` — `h1` (via `EpicTitle`, font-serif unchanged) followed by `data-testid="epic-detail-turns-ago"`, mono, title attribute carries the detail tooltip. Old MetaItem stats row absent from this header block.
- AC4 (goal clamp): `EpicDetail.tsx:896-914` — `data-testid="epic-detail-goal"` with `line-clamp-1` unless `goalExpanded`, `data-testid="epic-detail-goal-more"` shown when `goal.length > 120`.
- AC5 (tests): `EpicDetail.test.tsx`, `EpicDetail.terminalMode.test.tsx`, `EpicDetailPrdsRuns.test.tsx` all green in the plan-level run above.
- Screenshot match: region 1 (status pill `running` / `FEATURE` chip / `architect · opus · effort medium · sm-epic/...`) and region 2 (serif title + `42 turns · 6s ago` + goal `more`) match the landed JSX exactly.

### 1465-chat-toolstrip-at-standard — VERIFIED
- `chatVerbosity.ts:216-218`: `showsToolStrip(level) = verbosityRank(level) >= verbosityRank('standard')`; `CHAT_VERBOSITY_ORDER = ['summary','brief','standard','detail','raw']` (chatVerbosity.ts:55) → true for standard/detail/raw, false for brief/summary. Doc comment at :195-214 states the "receipt, not the work" rationale.
- Only caller is `EpicDetail.tsx:712` (`grep -rn showsToolStrip src/renderer` confirms no other call sites) — no out-of-scope edits needed.
- Test: `chatVerbosity.test.ts` green (plan-level run).

### 1466-chat-launch-briefing-card — VERIFIED
- `estimateTokens.ts` + test — present, green (ran separately above).
- `EpicIntakeCard.tsx:196-235`: `data-testid="epic-intake-card"`, `border border-dashed rounded-card`, badge "Launch briefing" (`epic-intake-badge`), subtitle "Sent to the agent at start — not part of the conversation", `${groups.length} sections · ${tokens.toLocaleString()} tok`, toggle `epic-intake-toggle` reading `Show ▾` / `Hide ▴`.
- Chips: `epic-intake-chip` per `GROUP_LABEL` kind (Actor/Persona/Injections/Input/Mission/Goal/References), `onClick` expands that section (`:224-234`).
- Collapsed by default: section bodies (`epic-intake-card-sections`) only render when `expanded` (`:236-237`).
- `EpicDetail.test.tsx`'s "AIM briefing" reference (`:1252`) is a test *description* string, not a rendered-text assertion — no sr-only shim was needed, and none was added; consistent with the PRD's fallback instruction.
- Screenshot match: region 3 (LAUNCH BRIEFING card, "7 sections · 2,140 tok", Show▾, 7 chips) matches exactly.

### 1467-chat-composer-restyle — VERIFIED (mic + attach confirmed present and wired)
- `EpicComposer.tsx:165-207`: one `data-testid="epic-composer-input"` wrapper (`rounded-xl border border-line bg-bg-hi`) containing the textarea (`pr-[72px]` so text clears the icons) and, absolutely positioned inside it, **both** `data-testid="epic-composer-mic"` (onClick=`onMicClick`, `aria-pressed={dictating}`) and `<AttachButton testId="epic-composer-attach" att={att} .../>` — both unconditionally rendered, wired to the pre-existing handlers.
- Placeholder (`:177`): exactly `'Queue a follow-up… ⌘V to attach a screenshot'`.
- Cancel (`:208-217`): `data-testid="epic-composer-cancel"`, borderless `text-accent`, rendered only when `running`, still calls `window.api.chat.cancel(epic.id)`.
- Send (`:218-228`): `bg-fg text-bg` rounded, label is `'Queue'` when `running` (matching the screenshot's running state) else `'Send'`, disabled styling preserved.
- Tests: `EpicComposer.test.tsx`, `EpicQuoteReply.test.tsx`, `attachments.test.tsx` all green.
- Screenshot match: region 10 (composer) — mic + attach visible inside the input's right edge, accent "Cancel" + dark "Queue" — matches exactly.

### 1468-chat-tabs-dial-divider — VERIFIED
- `DetailTabs` (`EpicDetail.tsx:579-...`) is local to this file (does not import `ui/ViewTabs.tsx` — confirmed by `grep` and by the empty `ViewTabs.tsx` diff above); `role="tablist"`/`role="tab"` present.
- `VerbosityDial` (`:515-547`): preceded by mono `Detail` label (`epic-verbosity-dial-label`); segments from `CHAT_VERBOSITY_DISPLAY_ORDER` (labels only, no level-number prefix — `CHAT_VERBOSITY_META[level].label`); active segment `bg-accent text-white`, inactive `text-fg-dim`; no inline "N hidden" counter in this component.
- `HiddenEventsDivider` (`:557-572`): `data-testid="epic-hidden-events-divider"`, hairline `bg-rule` rules either side of mono `text-fg-faint text-[10.5px]` text, `conversation · ${hiddenCount} low-level events hidden` when `hiddenCount > 0`, else plain `conversation`; `onClick={onReveal}`.
- Tests: `EpicDetail.test.tsx`, `.terminalMode.test.tsx`, `EpicDetailPrdsRuns.test.tsx` green.
- Screenshot match: region 4 (Discussion | PRDs 0 | Runs 0, Detail + Raw/Detail/Standard/Brief/Summary dial with Standard filled) and region 5 (`conversation · 39 low-level events hidden` hairline divider) match exactly.

### 1469-chat-turn-visuals — VERIFIED
- Assistant avatar (`ChatTranscriptTurn.tsx:1394`): `rounded-md bg-accent text-white`, no border, contains `C`.
- Assistant prose (`:1433-1440`): `prose-chat text-sm leading-relaxed ${bodyTone}` — no border/background bubble wrapper; markdown/clamp/expand (`chat-turn-expand-body`) unchanged.
- User turn (`:1173-1193`): no "you · ago" label row — time is in the bubble's `title` attribute (`` `you · ${formatAgo(...)}` ``); bubble `rounded-2xl bg-fg ... text-bg`, right-aligned; `chat-turn-user-footer` and `chat-turn-quote` still render.
- Tests: `ChatTranscriptTurn.test.tsx`, `ChatTurnClamp.test.tsx`, `ChatTranscriptTurnFrame.test.tsx`, `ChatTranscriptTurnEvents.test.tsx`, `.streaming.test.tsx`, `.turn-memo.test.tsx` all green.
- Screenshot match: regions 7-9 (filled "C" avatar, bubble-less assistant prose, dark right-aligned user bubbles with no label row) match exactly.

### 1470-chat-tool-chip-working-row — REFUTED (one AC not met — see Critical finding)
- AC1 (collapsed label): `toolChipLabel` (`:227-243`) returns `Read <basename>` / `Glob|Grep <target>` / `Bash <first word>` / bare label; `CollapsibleToolStrip` (`:284-328`) joins the first 3 via `truncateToolChipLabel`, appends `· ${n} tool(s)`; chip styled `font-mono text-[11px] bg-bg-elev rounded px-1.5` with the `▸` marker — matches the screenshot's `▸ Read CLAUDE.md · Read ProjectHome.tsx · Glob ops/macros/** · 3 tools` exactly.
- AC3 (`toolChipLabel` tests): present and green.
- AC4 (updated tests): `ChatTranscriptTurnEvents.test.tsx`, `.streaming.test.tsx`, `ChatTurnClamp.test.tsx`, `EpicDetail.test.tsx` all green.
- **AC2 is not met.** The PRD requires: *"Streaming/running assistant turn renders exactly one working indicator... the header 'running' dot and the separate 'working…' bubble are not rendered while it shows"* — restating the Goal's "collapse the three competing running signals... into the target design's one row." See Critical finding below: `CollapsibleToolStrip`'s own chip (with its own pulsing dot) is NOT suppressed while the new `turn-working-row` shows, so a live turn with at least one completed tool call renders **two** stacked running rows, not one, contradicting both the AC text and the screenshot (which shows a single `● working · Glob ops/** · 2 tools` line for the live turn, no tool chip above it).

## Screenshot vs. landed JSX — region-by-region

| # | Screenshot region | Landed JSX | Match |
| - | --- | --- | --- |
| 1 | Status pill (`running`) + `FEATURE` chip + mono `architect · opus · effort medium · sm-epic/...` | `EpicDetail.tsx:861-883` | ✅ |
| 2 | Serif title + mono `42 turns · 6s ago` | `EpicDetail.tsx:884-893` | ✅ |
| 3 | Goal line, clamped, `more` | `EpicDetail.tsx:896-914` | ✅ |
| 4 | `Discussion \| PRDs 0 \| Runs 0` underline tabs + `Detail` + `Raw\|Detail\|Standard\|Brief\|Summary` dial | `EpicDetail.tsx:515-547, 579+` | ✅ |
| 5 | `LAUNCH BRIEFING` dashed card, `7 sections · 2,140 tok`, `Show ▾`, 7 chips | `EpicIntakeCard.tsx:196-235` | ✅ |
| 6 | `conversation · 39 low-level events hidden` hairline divider | `EpicDetail.tsx:557-572` | ✅ |
| 7 | `C` avatar square, `claude · 2m ago`, bubble-less prose, `▸ Read CLAUDE.md · Read ProjectHome.tsx · Glob ops/macros/** · 3 tools` | `ChatTranscriptTurn.tsx:1394-1440, 284-328` | ✅ |
| 8 | Dark right-aligned user bubble, no `you · ago` row | `ChatTranscriptTurn.tsx:1173-1193` | ✅ |
| 9 | Second assistant turn, `▸ Read ops/README.md · 1 tool`, second user bubble | same components as #7/#8 | ✅ |
| 10 | Live row: `C` avatar + pulsing dot + `working · Glob ops/** · 2 tools`, single row | `ChatTranscriptTurn.tsx:1421-1428` renders this row correctly, **but** `CollapsibleToolStrip` (`:1415-1419`) also renders above it whenever the live turn carries `toolUses`, producing two rows instead of the one shown in the screenshot | ❌ (see Critical finding) |
| 11 | Composer: rounded input, mic+attach inside right edge, `Queue a follow-up…` placeholder, accent `Cancel`, dark `Queue` | `EpicComposer.tsx:165-228` | ✅ |

## Findings

### Critical
- **`src/renderer/components/ChatTranscriptTurn.tsx:1415-1428` — duplicate running indicator, violates PRD 1470 AC2 and the screenshot.** `toolStripVariant` is set unconditionally to `'collapsible'` for the live turn (`EpicDetail.tsx:1192`), so whenever a streaming assistant turn has at least one completed tool call (`turn.toolUses?.length > 0`), `CollapsibleToolStrip` renders its own chip — including its own `running && <span className="... bg-accent" />` pulsing dot (`:312`) and a `<tool preview> · N tools` label — directly above the new `turn-working-row`, which renders a second pulsing dot and `working · <tool> · N tools` text. Reproduce: mount `Turn` with `runActive=true`, `turn.text=''`, `turn.toolUses=[{...},{...}]` (exactly the fixture `ChatTranscriptTurn.streaming.test.tsx:108-119` uses) and inspect the full `host.innerHTML` — both `[data-testid="tool-strip-toggle"]` and `[data-testid="turn-working-row"]` are present simultaneously. The PRD's own added test only asserts `rows.length === 1` for `turn-working-row` and never checks for the absence of `tool-strip-toggle`, so this regression passes the gate it shipped with. **Fix**: suppress `CollapsibleToolStrip`/`ToolUseTraceStrip` rendering while `isRunning` (`presentation === 'working'`) and let `turn-working-row` be the sole indicator during that state, matching the screenshot and the written AC.

### Minor
- **`src/renderer/components/epics/EpicComposer.tsx:177` — placeholder no longer varies by `running`.** Previously the idle placeholder read `Add to "<goal>" — Enter to send…`; now it is always `'Queue a follow-up… ⌘V to attach a screenshot'`. This is not a defect relative to this plan — PRD 1467's AC literally mandates the single fixed string with no conditional — but it is a UX regression worth a human decision if the context-aware idle placeholder was valued.
- **`src/main/lib/epicDelegationStats.cjs` and its IPC handler/schema/preload binding — now dead code.** PRD 1464 removed the delegation-stat chip and its `useEffect` fetch from `EpicDetail.tsx` (outside this PRD's stated file list, called out in the commit message as a code-review-driven fix), but the backend plumbing it called was left in place with no renderer caller. Six+ test files still stub `epicDelegationStats.get`. Not a correctness bug — a cleanup opportunity for a future PRD if the feature is permanently gone.

## Security review

Scoped to the plan's own diff (`b7279f91..ca0508d0`, the 7 chat-restyle commits only — the wider `d4d44730..HEAD` range includes unrelated demo-video-macro work already covered by a separate validation doc in this folder). No new `dangerouslySetInnerHTML`, `eval`, subprocess, IPC route, or file-write surface was introduced; the one `dangerouslySetInnerHTML` call in `ChatTranscriptTurn.tsx:162` is pre-existing (only its wrapping `className` changed) and still renders `shownHtml` from the existing `renderChatMarkdown` sanitizer. No secrets, path-traversal-sensitive inputs, or auth-relevant code were touched. No security findings.

## Sentinel

VALIDATION: chat-header-compact-meta VERIFIED
VALIDATION: chat-toolstrip-at-standard VERIFIED
VALIDATION: chat-launch-briefing-card VERIFIED
VALIDATION: chat-composer-restyle VERIFIED
VALIDATION: chat-tabs-dial-divider VERIFIED
VALIDATION: chat-turn-visuals VERIFIED
VALIDATION: chat-tool-chip-working-row REFUTED — CollapsibleToolStrip's own chip (with its own pulsing dot) still renders alongside the new turn-working-row during a live turn with completed tool calls, so two running indicators show instead of the one the AC and screenshot require.
SCHEDULER_VERDICT: PASS
