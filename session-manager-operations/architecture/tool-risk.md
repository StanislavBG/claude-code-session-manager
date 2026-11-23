# Tool risk marks

The one topic doc for tool risk marks. A mark says how risky one tool is. The guard hook
`guard-tool-risk` refuses a risky tool in a headless job unless the job's PRD names it.

Code owns the details. Mark parsing, matching and precedence live in
`src/main/lib/claude/toolRiskMarks.cjs`. The enforcement policy lives in
`scripts/hooks/lib/guard-tool-risk-policy.cjs`; the hook entry is `scripts/hooks/guard-tool-risk.cjs`.
Owners edit marks in **Settings ▸ Tool risk** (`SettingsToolRisk.tsx`, through `toolRisk:read` / `toolRisk:write`
in `src/main/lib/claude/toolRiskIpc.cjs`).

## The six marks

`read` · `write` · `confirm` · `irreversible` · `money` · `public` (`MARKS` in `toolRiskMarks.cjs`, in order of
riskiness — a compound Bash line resolves to its riskiest mark).

- `read` and `write` never block.
- `irreversible`, `money` and `public` are the **blocking marks** (`BLOCKING_MARKS`).
- `confirm` is refused in a job like a blocking mark, but the refusal asks the owner instead of failing
  silently — see [Confirm: ask the owner](#confirm-ask-the-owner).
- An unmarked tool is allowed.

## Where marks live

| Layer | File |
| --- | --- |
| System | `~/.claude/tool-risk.json` |
| Project | `<repo>/.claude/tool-risk.json` in the **main checkout**, never an Epic or job worktree |

The file format is version 1: `{ "version": 1, "interactive"?: boolean, "marks": { "<rule>": "<mark>" } }`.
Any other top-level key, an unknown mark or an invalid rule makes the file invalid. `interactive` is Project-only.

A rule key is one of:

- `mcp__server__tool` — one MCP tool.
- `mcp__server__*` — every tool of one MCP server.
- `Bash(npm publish:*)` — a Bash command prefix.
- `Bash(git push --force)` — one exact Bash command.

For example, the System file can mark `mcp__gmail-sg__send_email` as `public`.

## Lookup order

1. **Project layer first.** Any matching Project rule beats every System rule.
2. **Then the System layer.**
3. **Inside a layer, the most specific rule wins**: an exact MCP tool beats a server wildcard; an exact Bash
   command beats a longer prefix, and a longer prefix beats a shorter one.
4. **Unmarked = allowed.**

A Bash line is split into simple commands on `&&`, `||`, `;`, `|` and newlines. Leading `VAR=value` words and
the wrappers `env`, `sudo`, `command`, `exec`, `nohup` and `time` are dropped first. One level of `bash -c` /
`sh -c` is unwrapped. Each simple command is resolved by itself, and the riskiest result counts.

## The refusal message

A headless refusal reaches the model verbatim as the PreToolUse `permissionDecisionReason`:

```text
Blocked: `<command or tool>` is marked '<mark>' by rule `<rule>` in the <System|Project> tool-risk file <path>. A headless job may run a '<mark>' tool only when its PRD clears it: name it in riskTools (e.g. "<rule>") in the PRD and re-queue. Do not work around this refusal (no other tool, wrapper, script or alias for the same effect); stop and report that this step needs clearance.
```

In an interactive session that opted in, the middle sentence reads: `This project enforces tool-risk marks in
interactive sessions (interactive: true); to run it from a job, name it in riskTools in the PRD.`

Two more refusals use the same shape:

- **Invalid marks file — fail closed.** If a marks file exists but is invalid, every Bash and MCP call is
  refused: `Blocked: the <System|Project> tool-risk file <path> cannot be used (<error>), so every Bash and MCP
  call is refused (fail closed). A human must fix the file in Settings. …`
- **Marks are human-owned.** A `Write`, `Edit`, `MultiEdit` or `NotebookEdit` of any `tool-risk.json` is
  refused: `Blocked: <tool> of <path> — marks are human-owned: edit them in Settings. …`

Any other internal hook error fails open and logs one stderr line.

## How a PRD names a risky tool

- **`riskTools` on `scheduler_create_prd`** (and `scheduler_create_prds`). It is a list of at most 20 rules,
  in the same syntax as the marks, for example `["Bash(npm publish:*)"]`. The API writes it to the PRD's
  `riskTools:` frontmatter. A rule the parser rejects is refused at create time.
- **The persona's `tools:` list.** The scheduler adds every persona tool that is a valid rule, such as an
  `mcp__…` name, to the job's clearance. See `jobRiskToolsClearance` in `src/main/scheduler.cjs`.

The scheduler passes the cleared list to the job as the env var `SM_SCHEDULER_JOB_RISK_TOOLS` (a JSON array).
It also sets `SM_PROJECT_ROOT` to the main checkout, and the hook reads the Project layer only from there. The
hook loads through `--settings`, because a job worktree never sees the untracked `.claude/settings.json`. When
the job sandbox already passes an inline `--settings`, the hook is merged into it, since the CLI keeps only the
last `--settings` (`mergeRiskGuardIntoSandboxArgs`).

For a Bash line, a clearance must cover the rule that matched. Every blocking simple command in a compound line
needs its own clearance, so clearing `git status` never clears `npm publish` in the same line.

Name only the tools the PRD's work truly needs. Clearance is per PRD: a later PRD has to name the tool again.

## Confirm: ask the owner

A `confirm`-marked call that the job's clearance does not cover is denied with a reason that starts
`Blocked, pending confirmation:` and names the rule and the call's **args digest** — the sha256 of the canonical
JSON (keys sorted at every depth) of its `tool_input` (`argsDigest` in `toolRiskMarks.cjs`).

1. **The guard records the request.** In a scheduler job it appends one line
   `{ time, tool, argsDigest, jobSlug, epicId, cwd, rule, layer, summary }` to
   `<schedulerHome>/tool-confirmation-requests.jsonl` (`confirmationRequestsPath`). `epicId` comes from
   `SM_SCHEDULER_JOB_EPIC_ID`, `cwd` from `SM_PROJECT_ROOT`. A Task run has no job slug: it is denied, nothing is
   recorded.
2. **The main process posts it.** At each job exit the scheduler calls `drainConfirmationRequests` in
   `needsYouStore.cjs`. It renames the file aside, then posts each line as one Needs-you item (app `tool-risk`)
   linked to the Epic and appends one `job.confirmation_requested` event (`tool`, `argsDigest`, `jobSlug`, `rule`)
   to the Epic's event log.
3. **Deduped by tool + digest.** The item id is derived from `(tool, argsDigest)` — the digest alone is not
   enough, since every argument-less MCP call shares the digest of `{}`. A repeat request, from any job, posts
   nothing and appends no event while the item is kept (open, or closed within the 14-day retention).
4. **The owner decides.** To let the call run, re-queue the PRD with the rule in `riskTools`; otherwise withdraw the
   item. Clearance works as for blocking marks.

A blocking mark in the same compound line wins: the line is refused for it first and no request is recorded.
In an opted-in interactive Terminal session a `confirm` call gets the CLI's approval prompt (`ask`); a Chat turn
is denied.

## Interactive sessions: opt-in

Interactive sessions are not guarded by default. On the Project face of Settings ▸ Tool risk, turning on
**interactive** writes `interactive: true` to the Project file. It also installs `guard-tool-risk` into
`<repo>/.claude/settings.json`; turning it off removes the hook. With the opt-in on:

- **A Chat turn is refused (deny).** A Chat turn is a `-p` run with `SM_CHAT_SESSION_ID` set. It has no
  approval surface, and the CLI turns `ask` into a generic auto-deny.
- **A Terminal session is asked (`ask`).** It gets the CLI's normal approval prompt.

## Tasks get no clearance

A Task run (`src/main/lib/tasks/taskRun.cjs`) loads the same hook through `--settings`, with
`SM_TOOL_RISK_HEADLESS=1`. A Task has no PRD, so it has no `riskTools`, and every blocking mark is refused. To
run a risky tool headless, queue a PRD that names it.

## Limits

- **Focus, not containment.** The guard stops an agent from reaching for a marked tool by habit or by mistake.
  It is not a sandbox. A tool nobody marked, or the same effect reached another way, is not caught. The refusal
  tells the model not to work around it, but that is still advice. Containment is the job sandbox's work
  ([scheduler-operations.md §11](scheduler-operations.md#11-job-sandbox)).
- **Bash rewrites of a marks file are not caught.** Only the `Write`, `Edit`, `MultiEdit` and `NotebookEdit`
  tools are refused on `tool-risk.json`. A Bash command such as `echo … > ~/.claude/tool-risk.json` is not.
- **The interactive hook lives in the main checkout's `.claude/settings.json`.** A session whose cwd is an Epic
  worktree does not load it, because worktrees carry only tracked files.

## Why a hook and not native permission rules (CLI probe, 2026-11-22)

The probe ran on Claude Code CLI **2.1.325** in `-p` runs with `--dangerously-skip-permissions`:

| Probe | Result |
| --- | --- |
| Native `permissions.deny` on a Bash rule | Enforced. |
| Native `permissions.deny` on an MCP tool | Enforced. The MCP tool vanishes from the model's tool list. |
| Native `permissions.ask` | Auto-denied in a `-p` run. |
| Hook `permissionDecision: "ask"` | Auto-denied in a `-p` run. |
| Hook `permissionDecision: "deny"` | Enforced. Its `permissionDecisionReason` reaches the model verbatim. |
| An unknown top-level key in a settings file | Does not invalidate the file; the other settings still load. |

So both native deny rules and a hook deny would hold in a headless job. Native rules were not used because:

1. **They bind interactive Chat turns too.** A deny in `~/.claude/settings.json` or the project settings also
   hits the owner's own Chat and Terminal sessions. Marks are meant to be enforced only in headless jobs unless
   the project opts in.
2. **They cannot be lifted per PRD.** A deny rule is the same for every run that loads the file. `riskTools`
   needs one job cleared while its siblings stay refused.
3. **They cannot name the mark.** A native deny gives a generic refusal, or hides an MCP tool outright, so the
   model never learns why or what to do next. A hook deny names the mark, the rule, the file and the fix.

The `ask` results are why an opted-in Chat turn gets `deny`, not `ask`.
