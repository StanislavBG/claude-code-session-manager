# maintaining-md-network skill evaluation

## Contents

- [Scenarios](#scenarios)
- [Drift-check runs](#drift-check-runs)
- [Comparison with the hand-run Bilko review](#comparison-with-the-hand-run-bilko-review)
- [Gaps](#gaps)

Skill under test: plugins/session-manager-dev/skills/maintaining-md-network (SKILL.md, placement.md, audit.md, plan.md, drift-check.md, scripts/drift-check.cjs). Date: 2026-11-06. This record measures; no file in the three projects or the skill was changed.

## Scenarios

The query is the Review MD network macro prompt with Scope and Mode filled in. Expected behaviors come from SKILL.md and its references.

### 1. Bilko (a host with many audiences)

- Query: "Review MD network. Scope: whole project. Mode: Full review." Run in /home/bilko/Projects/Bilko.
- Paths the review must read: /home/bilko/Projects/Bilko/CLAUDE.md, /home/bilko/Projects/Bilko/docs/map.md, /home/bilko/Projects/Bilko/docs/host-contract.md, /home/bilko/Projects/Bilko/docs/host-internals.md, /home/bilko/Projects/Bilko/docs/commerce.md, /home/bilko/Projects/Bilko/docs/site.md, /home/bilko/Projects/Bilko/packages/host-kit/README.md, /home/bilko/Projects/Bilko/mcp-host-server/README.md, /home/bilko/Projects/Bilko/.claude/skills/blog-from-git, and the code that serves host-contract.md (the get_host_contract tool).
- Expected behaviors:
  1. Reports the machine-written share (validation and deploy records under session-manager-operations/reviews) as files and lines over all markdown (audit.md step 1, plan.md Records and runtime state).
  2. Names the four audiences (maintainers, sibling-app agents, operators, end users) and what each loads (audit.md step 2).
  3. Treats docs/host-contract.md as an entry point because the get_host_contract tool returns it verbatim; checks size, contents list and repo-root links (placement.md Size and load rules, audit.md step 2).
  4. Checks that the map lives inside the repo, since a parent-folder map never loads in worktree sessions (placement.md, plan.md Other repos).
  5. Never proposes deleting or untracking state a program reads; names the owner tool instead (plan.md Records and runtime state).
  6. Gives every doc one verdict and applies the three-part DELETE test (plan.md Verdicts).
  7. Lists hand-kept lists that copy a source of truth (tool counts, route lists) and checks counts against code (audit.md step 4).
  8. Runs feedback_list_projects before any /send-feedback; for a repo not on the list, states the facts only (plan.md Other repos).
  9. Changes no files before approval; plans with /develop in the order delete, owner docs, map, tools, validate (SKILL.md Rule, plan.md After approval).
  10. Keeps cited headings stable (audit.md step 3).

### 2. family-frame (a small sibling app)

- Query: "Review MD network. Scope: whole project. Mode: Full review." Run in /home/bilko/Projects/family-frame.
- Paths the review must read: /home/bilko/Projects/family-frame/CLAUDE.md (440 lines), /home/bilko/Projects/family-frame/replit.md, /home/bilko/Projects/family-frame/design_guidelines.md, /home/bilko/Projects/family-frame/docs/events.md, /home/bilko/Projects/family-frame/docs/agent-access.md, /home/bilko/Projects/family-frame/docs/time-series.md, /home/bilko/Projects/family-frame/docs/person-publishing.md, /home/bilko/Projects/family-frame/.claude/agents/builder.md.
- Expected behaviors:
  1. Flags CLAUDE.md at 440 lines as over the 200-line limit and proposes a map of at most 70 lines with the rest moved to owner docs or path-scoped rules (placement.md, plan.md Report item 1).
  2. Reports the machine-written share (62 of 75 markdown files are validation records).
  3. Treats the docs the sibling consumes from Bilko (host contract) as owned by Bilko: MOVE-TO-OWNING-REPO or pointer, not a copy (plan.md Verdicts).
  4. Moves procedures (Release, Deployment) out of the always-loaded file into a skill, and commands or env facts into pointers (placement.md).
  5. Flags the Key Files and Project Structure lists as hand-kept copies of a directory listing (audit.md step 4, flag 1).
  6. Adds a contents list to each reference doc over 100 lines (events.md, agent-access.md and others).
  7. Checks code paths cited in CLAUDE.md (pages/events.tsx) against the tree (audit.md step 4).
  8. Routes any Bilko-side finding with feedback_list_projects first (plan.md).
  9. Changes no files before approval.

### 3. session-manager (itself)

- Query: "Review MD network. Scope: whole project. Mode: Drift check." Run in /home/bilko/Projects/session-manager (it holds a prior record under session-manager-operations/reviews/docs).
- Paths the review must read: /home/bilko/Projects/session-manager/CLAUDE.md (154 lines, 12,000-char budget), the scoped CLAUDE.md files (src, src/renderer, plugins, web-remote, web/remote-app, session-manager-operations), /home/bilko/Projects/session-manager/session-manager-operations/architecture, the newest record under /home/bilko/Projects/session-manager/session-manager-operations/reviews/docs.
- Expected behaviors:
  1. Finds the newest review record; if none, stops and runs a Full review (drift-check.md Drift check mode, step 2).
  2. Lists changed .md files with git diff --name-only from the record's Base commit, and runs the script with one --file per file plus the record's --map and --exclude flags.
  3. Re-does census, links and truth check only for changed files, plus docs citing changed code (drift-check.md step 5).
  4. Reports machine-written share (224 of 344 markdown files are validation records).
  5. Does not propose deleting scheduler or ops state that programs read; respects the single-writer namespaces (plan.md Records and runtime state).
  6. Resolves scoped links (CLAUDE.md names prompt-sessions/README.md relative to the ops root) rather than reporting them as broken (audit.md step 3).
  7. Writes a new record with a full-sha Base commit and updates last-review in the map comment (drift-check.md Review record).
  8. Changes no files before approval.

## Drift-check runs

Script: plugins/session-manager-dev/skills/maintaining-md-network/scripts/drift-check.cjs, run from the job worktree against the main checkouts (read-only). Output in /tmp/dc-<repo>.json and /tmp/dcx-<repo>.json. No project has a md-network-map comment, so map was null in every run and the 70-line map limit was never applied.

### Run A: default flags (all tracked markdown)

| Repo | Command | Exit | Files | Counts |
| --- | --- | --- | --- | --- |
| Bilko | same script, --root /home/bilko/Projects/Bilko | 1 | 236 | broken-link 125, missing-path 412, no-contents-list 29 |
| family-frame | same script, --root /home/bilko/Projects/family-frame | 1 | 75 | missing-path 90, over-line-limit 1, no-contents-list 9 |
| session-manager | same script, --root /home/bilko/Projects/session-manager | 1 | 344 | missing-path 1318, broken-link 4, no-contents-list 65 |

Note: the exact command for each is `node plugins/session-manager-dev/skills/maintaining-md-network/scripts/drift-check.cjs --root <abs repo>` with stdout to /tmp/dc-<repo>.json. Run A is dominated by validation records (Bilko 116 and family-frame 62 and session-manager 224 files under session-manager-operations/reviews/validation) and blog posts, so it is noise.

### Run B: records excluded

Command: `node plugins/session-manager-dev/skills/maintaining-md-network/scripts/drift-check.cjs --root <abs repo> --exclude session-manager-operations/reviews --exclude session-manager-operations/design-mocks --exclude content/blog` (all three repos; content/blog is absent in the other two).

| Repo | Exit | Files | broken-link | missing-path | over-line-limit | no-contents-list |
| --- | --- | --- | --- | --- | --- | --- |
| /home/bilko/Projects/Bilko | 1 | 31 | 4 | 71 | 0 | 12 |
| /home/bilko/Projects/family-frame | 1 | 13 | 0 | 7 | 1 | 7 |
| /home/bilko/Projects/session-manager | 1 | 79 | 0 | 288 | 0 | 32 |

Machine-written share (tracked markdown under session-manager-operations): Bilko 153 of 236 files, 6,594 of 12,757 lines (52% of lines); family-frame 62 of 75 files, 2,747 of 5,159 lines (53%); session-manager 291 of 344 files, 22,170 of 27,651 lines (80%, but that count includes human-written architecture docs). The script does not report this share.

### Five most significant findings per repo (Run B)

Bilko:
1. no-contents-list: /home/bilko/Projects/Bilko/docs/host-contract.md, 687 lines. True positive; it is served verbatim to every sibling session.
2. missing-path: 19 in /home/bilko/Projects/Bilko/docs/repo-writers.md and 17 in host-contract.md. Mostly true-or-false mix: `origin/main` and runtime paths are false positives; the rest need a human look.
3. no-contents-list: docs/host-internals.md (232), docs/commerce.md (177), blog-from-git SKILL.md, dag.md, rotation.md, voice.md. True positives.
4. broken-link: .claude/skills/blog-from-git/voice.md line 47 target /projects/git-viewer/. A site route, so a false positive.
5. missing-path: renditions/linkedin.md and renditions/x.md in blog-from-git SKILL.md line 49 and dag.md lines 15, 106. Needs a check against the skill folder; likely a stale or relative path.

family-frame:
1. over-line-limit: /home/bilko/Projects/family-frame/CLAUDE.md, 440 lines against 200. True positive and the biggest fix.
2. no-contents-list: CLAUDE.md (440), docs/events-design-brief.md (418), docs/person-publishing.md (292), docs/events.md (269), docs/agent-access.md (264). True positives.
3. missing-path: CLAUDE.md line 288 pages/events.tsx. Probably a client/-relative path; needs a human check.
4. missing-path: docs/events.md line 153 pages/events.tsx and components/events/events-filter-bar.tsx. Same relative-path pattern.
5. missing-path: .claude/agents/builder.md lines 33-34 origin/main, and docs/events.md line 54 ageMin/Max. False positives.

session-manager:
1. missing-path: 52 in architecture/code-map.md, 42 in host-boundary.md, 30 in project-partition.md, 20 in web/promo-video/script/BRIEF.md. Mixed; many are paths relative to src/ or runtime paths.
2. missing-path: CLAUDE.md lines 37, 70, 74, 105, 109 (architecture/README.md, lib/epicIntake.ts, prompt-sessions/README.md, scheduler/README.md, scheduler/prds/). False positives: they resolve relative to the ops root or src/renderer.
3. no-contents-list: plugins/session-manager-dev/skills/develop/SKILL.md (301), send-feedback/SKILL.md (203), architecture/customer-feedback.md (186), build-target.md (145). True positives.
4. no-contents-list: CLAUDE.md (154 lines), README.md (126). Arguably true; the CLAUDE.md is a map with a table of docs near the top.
5. 288 missing-path findings in total; the signal-to-noise ratio is low and no flag removes the false positives other than --exclude per file.

## Comparison with the hand-run Bilko review

The hand-run review is Epic review-the-project-md-network-this-is-complex-pl-7d4afd69, PRDs 1628-1640 (follow-ups 1644-1647), read from /home/bilko/Projects/Bilko/session-manager-operations/scheduler/epics/review-the-project-md-network-this-is-complex-pl-7d4afd69/prds-archived. Its output is already in Bilko (docs/map.md at 48 lines, CLAUDE.md at 44 lines importing it), so the script ran on the post-review state. "Caught by the script" is judged on whether the check would flag the pre-review defect.

| Key finding (PRD) | Result | Where |
| --- | --- | --- |
| Most tracked markdown were machine records (validation, deploy reviews) | Covered by a step | audit.md step 1 machine share, plan.md Records and runtime state. The script only exposes the problem as noise (Run A). Gap: no number from the script. |
| 11 files in docs/archive teach cookie auth that host-contract forbids; delete stale docs (1628) | Covered by a step | audit.md step 4 truth check; plan.md DELETE three-part rule. The script catches none of it. |
| CLAUDE.md copied other docs (Sanctioned host code list, host-kit facts, deploy facts) (1629, 1630, 1635) | Covered by a step | plan.md Report item 2 one-owner table, audit.md step 4 flag 1. The script cannot see duplicates. Gap: no duplicate detection. |
| Wrong claims: secrets-rotation and publishing-contract contradict code (1631) | Covered by a step | audit.md step 4 (commands, schedules, owners). Script catches only missing paths. |
| docs/host-contract.md served verbatim to every sibling session with money and site content mixed in; 852 lines then, 687 now (1632, 1633, 1634) | Partly caught | Script flags no-contents-list on host-contract.md (still flagged at 687 lines). Covered by audit.md step 2 entry points and placement.md. The script does not know the file is served, and does not check repo-root links. |
| MCP README lists 10 of 15 tools; host-kit README covers only telemetry (1635) | Covered by a step | audit.md step 4 counts. Script cannot count. |
| Blog docs contradict the config; blogs.md and blog-watchdog.md describe a disabled trigger (1636, 1637) | Covered by a step | audit.md step 4 owners and schedules, time-sensitive wording; plan.md verdicts. Script silent. |
| Single entry map docs/map.md and CLAUDE.md imports it (1638) | Covered by a section | plan.md Report item 1, placement.md imports. Script gap: map is null because there is no maintainer comment, and an @import is not recognised. |
| get_host_contract must serve the map plus the contract; list_projects text names nonexistent src/config/tools.ts (1639) | Covered by a step | audit.md step 2 item 4 (find the code that serves it), step 3 consumers. Script gap: it reads only markdown, so a bad path in a code string is not found. |
| A map in a parent folder never loads in worktree sessions | Covered by a section | placement.md Size and load rules; audit.md step 2; plan.md Other repos. |
| Follow-up: two files still cite deleted docs, and CLAUDE.md repeats map rules so they load twice (1644) | Partly caught | The script would catch a markdown link to a deleted doc (broken-link) but not the code-span or prose mentions that remain: blog-ledger.md line 77 and README.md line 56 still name blog-watchdog. Repeated rules: gap (no duplicate detection). |
| Validators found real-path breaks only after the plan (1645, 1647) | Covered by a step | plan.md After approval step 5 validate. |
| Subagents took 11-17 minutes and one wrote a scratch file | Covered by a section | audit.md Time box and Subagent brief. |
| Feedback to 5 sibling repos failed (not Session Manager projects) | Covered by a step | plan.md Other repos, feedback_list_projects first. |

## Gaps

Each gap names the skill file and section that should cover it. Each can become a fix PRD.

1. No map found: every run reports map null; Bilko's real map (docs/map.md, imported by CLAUDE.md) is not recognised, and the 70-line limit is never applied. Cover in drift-check.md (Flags, The map's maintainer comment) and scripts/drift-check.cjs: follow a leading @import, and say what a first run does without the comment.
2. False positives on missing-path and broken-link: `origin/main`, site routes like /projects/git-viewer/, `ageMin/Max`, and paths relative to a subtree (CLAUDE.md in session-manager citing prompt-sessions/README.md, family-frame citing pages/events.tsx under client/src). Cover in drift-check.md (Finding kinds) with a documented rule (ignore git refs and site routes, resolve against the doc's nearest scoped root) and a flag such as --resolve-from.
3. Noise from machine records: Run A gave 412, 90 and 1318 missing-path findings, mostly from validation records. The skill never says to exclude records on the first run. Cover in drift-check.md (Flags, Review record) and audit.md step 1: default-exclude the ops reviews folder, or tell the reviewer to pass --exclude and record it.
4. The script does not report the machine-written share. Cover in audit.md step 1 and drift-check.md (Output): add a census count (files and lines by tracked/ignored/program-written) to the JSON.
5. Served-verbatim docs are not known to the script. host-contract.md is only a generic no-contents-list hit. Cover in drift-check.md (Flags) with an --entry flag that applies the contents list and repo-root link rules, matching audit.md step 2 item 3.
6. No duplicate-fact detection: CLAUDE.md copying other docs, and repeated map rules (PRDs 1629, 1630, 1644) are found only by hand. Cover in audit.md step 3/4 and plan.md Report item 2 (one-owner table) with a script check for repeated paragraphs or an explicit hand method (git grep of distinctive lines).
7. References in code strings and non-markdown files (src/config/tools.ts named in list_projects text, blog-watchdog in ops and README table) are out of the script's reach. Cover in audit.md step 3 (add a git grep of every deleted or renamed doc name across all file types after a restructure) and in plan.md After approval step 5 validate.
8. Anchor links (#heading) are skipped, though audit.md step 3 says headings cited by name must not change. Cover in drift-check.md (Finding kinds): add a broken-anchor kind.
9. Counts and claims (10 of 15 tools) have no tool support and rely on the reviewer. Cover in audit.md step 4: give a worked example command for counting registered tools against a README list.
10. Small-app guidance: plan.md has no sizing rule for a project like family-frame whose CLAUDE.md is a 440-line tour (Core Features, Project Structure, Key Files). Cover in placement.md (Where each kind belongs) with a row for structure and file listings: replace with a directory pointer or a command.
11. The Drift check scenario for session-manager depends on a prior record, but no skill text says what to do when the newest record predates a restructure (the single-day-per-record rule). Cover in drift-check.md (Drift check mode step 2).
