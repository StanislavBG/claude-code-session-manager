---
name: send-feedback
description: >-
  Hand a finding from THIS project to a DIFFERENT project on this machine, by
  opening a proposed feedback session in that project's own Sessions queue via
  Session Manager's cross-project conduit (the feedback_open_session MCP tool).
  Use whenever work in one repo surfaces something that is genuinely another
  repo's to fix — a bug in a sibling service, a broken contract between two
  projects, a doc that lies about another project's behavior. Also use when the
  user says "/send-feedback", "send this to <project>", "file this against
  <other repo>", "tell <project> about this", or "this is a bug in X, not
  here". NOT for work in the project you are already in — that is /develop.
  Keywords: feedback, proposal, plan, cross-project, project to project, another repo, sibling
  project, hand off, file against, route finding, x-folder.
---

# send-feedback

**Role:** the ONE channel for project-to-project communication. You are a
*courier*, never a fixer — you deliver a report into another project's inbox
and stop. You never edit the other project's files, never queue a PRD there,
and never wait for a reply.

## Why this exists

`/process-feedback`, `/my-feedback` and the `session-manager-operations/feedback/`
folder were retired (2026-08-02), and the scheduler was locked down so a PRD can
only JOIN an Epic a human already approved. Both were right. Together they left
no way to hand a finding across a project boundary. This skill is that way back
— narrowed to exactly one shape: **a proposal deposited in another project's
queue, which a human there must approve before anything runs.**

## The one hard rule

**Different project, or don't use this.** If the finding belongs to the project
you are already working in, run `/develop` inside the Epic you are already in.
The tool refuses `toCwd === fromCwd` outright, so getting this wrong costs you a
round-trip, not a wrong write.

| Finding belongs to | Route |
| --- | --- |
| The project you're in | `/develop` in your current Epic |
| Another project on this machine | this skill |
| Nothing actionable | say so explicitly |

Per the global core rules, routing a finding is the **default action, not a
question**. Do not ask "should I send this to X?" — send it, then report what
you delivered.

## Steps

### 1. Confirm it's really theirs

Before couriering anything, satisfy yourself the finding is about the other
project's behavior, not about how *your* project calls it. A misrouted report
costs a human in another repo their attention. If you can't tell, say which
project you think owns it and why, and send it anyway with that uncertainty
stated in the body — an honest "I think this is yours because X, but I couldn't
verify from here" is useful; a confident wrong claim is not.

### 2. Resolve the target cwd — never guess it

```
feedback_list_projects()
```

Returns every project on this machine that can receive feedback (each already
has a `session-manager-operations/` directory). Match the user's name for the
project against a real `cwd` from that list.

If the project you want is **absent**, it has simply never been opened in
Session Manager. Do not invent a path and do not create the directory. Tell the
human: "open `<project>` in Session Manager once, then I can send this."

### 3. Write the proposal for the human who must approve it

The reader is a human in another repo who has never seen your code, cannot run
it, and must decide from the proposal alone whether to approve. A report that
says "the usual timeout thing again" is worthless across a repo boundary. Fill
each field:

- **`motivation`** (required, <=2000 chars) — *why* this matters, in the
  originating human's own terms (the goal they are pursuing), not the agent's
  internal reasoning. The receiver should be able to judge worth from this alone.
- **`plan`** (ordered steps, <=20; **required when `tag` is `feature`**) — what
  you propose the receiving project do, in order. Concrete enough to approve or
  reject step by step.
- **`acceptanceCriteria`** (required, 1-20) — checkable outcomes that tell the
  receiver the work is done. Each must be verifiable, not "works well".
- **`outOfScope`** (optional, <=20) — what this proposal deliberately does not
  ask for, so approval doesn't grow.
- **`body`** (required, <=20000 chars) — supporting evidence, not the pitch:
  - **Symptom** — what actually happened, with the real error text or output.
  - **Where you observed it** — your project, the call site, the version/commit
    if you know it.
  - **What you expected** — the contract you thought you were relying on.
  - **Suspected cause** — name a file in *their* repo if you have a candidate;
    say "I couldn't locate it from here" if you don't. Never fabricate a path.

Do not pass the sender Epic's own goal: the server records it automatically as
`originAsk`.

Attach real absolute paths worth reading via `referencePaths` rather than
pasting large files into the body (there is a 20 000-char body cap; the cap is
a signal, not an obstacle to route around).

#### Multi-part requests

Prefer **ONE proposal carrying the whole plan**: the receiver approves one
thing and sees every step. Split only when the parts are independently
approvable (each makes sense and ships without the others). When you split, send
every part with the same `series` `{key, title, total}` (`key` kebab-case
<=60, `title` <=120, `total` 2-50) and a correct `index` (1..total), and put a
one-paragraph summary of the overall plan inside each part's `motivation` so any
single part is understandable alone. A bare "step 5/7" with no overall plan is
exactly what this rule exists to prevent.

### 4. Deliver

```
feedback_open_session({
  toCwd:   "<absolute cwd from step 2>",
  fromCwd: "<your project's absolute cwd>",
  title:   "<one line — this becomes their queue row>",
  motivation: "<why this matters, in the human's terms>",
  plan: ["<step 1>", "<step 2>"],              // required when tag is feature
  acceptanceCriteria: ["<checkable outcome>"], // at least one
  outOfScope: ["<what this does not ask for>"],  // optional
  series: { key: "d2d-rollout", title: "D2D rollout", index: 2, total: 7 }, // optional, multi-part only
  body:    "<supporting evidence from step 3>",
  tag:     "bug" | "feature" | "discussion",   // default: discussion
  referencePaths: ["/abs/path", ...],          // optional
})
```

**Choosing the tag.** Default to `discussion`. `discussion` keeps `/develop`
available but never assumed — which is exactly right for a claim the receiving
project has not yet agreed with. Use `bug` or `feature` only when the finding is
unambiguous and you'd expect them to start decomposing it on sight (those two
treat PRD decomposition as the expected next step).

**Auto-start (only when the human asked).** If the human in THIS conversation
explicitly asked you to do the work in the other project, also pass
`autoStart: true` and `humanRequestQuote` — copied VERBATIM from their own
message, which must name the target project. Never write or paraphrase the
quote, and never pass `autoStart` for something you decided on your own: that
stays a plain proposal. If the quote cannot be verified, the call silently falls
back to a normal `proposed` session (the result note gives the reason), so
report it as a proposal in that case.

**Auto-start from a macro.** If the human started THIS session by pressing a
macro whose auto-start setting allows the target project, bug and feature
proposals there start without any quote: pass no `autoStart` flag and no
`humanRequestQuote`, and do not try to set the setting yourself (it is edited
only in the macro editor). It reaches only that one hop, at most 5 times per
session, and `discussion` or other tags stay plain proposals. The result status
tells you which happened.

`fromEpicId` is filled in automatically from your running session; pass it
explicitly only if you know it and the auto-fill failed. When it resolves, a
receipt is chained onto your own session's event log so your transcript records
where the finding went.

### 5. Report honestly

Say exactly this much: the proposal was **delivered as a proposed session** in
`<toCwd>`, and it runs only if a human there presses **Approve & start**. That
human sees the motivation, plan and acceptance criteria on the proposal before
approving.

If the result status is `auto-approved`, say instead that the session was
auto-approved (on the human's request, or by the macro they pressed) and is
starting in `<toCwd>` — not that it is done.

Do **not** say the other project has been notified-and-is-working-on-it, that
the bug is filed/fixed/assigned, or that you'll follow up when they respond.
**There is no reply channel and no callback.** If the user needs an answer, the
next step is a human conversation, and you should say so.

## What this skill never does

- Write, edit or read-then-modify any file in the other project.
- Queue a PRD in the other project (a PRD may only join an already-approved
  Epic — the proposal you deliver is not approved).
- Start, resume or approve anything anywhere.
- Send to the project you're already in.
- Poll or wait for a response.

## If the tool isn't there

Two distinct failure modes — don't conflate them:

- **`feedback_open_session` errors with "app is not running"** — the Session
  Manager Electron app hosts the admin API that performs the cross-folder
  write. There is no fallback: hand-writing another project's
  `active-index.json` is exactly the racing second writer the single-writer law
  exists to prevent. Tell the human to start the app, and report the finding to
  them in the meantime so it isn't lost.
- **`feedback_open_session` is absent from your tool list entirely** — the
  `session-manager-scheduler` MCP server isn't registered for this project.
  That's a misconfiguration, not an offline app. Fix:
  `claude mcp add session-manager-scheduler --scope user -- node <session-manager-repo>/scripts/scheduler-mcp-server.cjs`
  (once at user scope covers every project).
