# STYLE.md — the writing contract for Field Manual 2.0.0

This is the single writing contract for **The Session Manager Field Manual**. Every chapter PRD
in the 2.0.0 plan reads this file first, and so does every future revision run by
`builder:manual`. If a chapter's wording, structure, or markup disagrees with this file, the
chapter is wrong — fix the chapter, don't reinterpret this doc.

## Audience & promise

The reader is a **curious Claude Code user** — including people who are not engineers. Some have
never written code. Assume no prior knowledge of AI agents, the terminal, or software
development jargon.

We are here to **educate**: always explain *why* something works before *how* to use it. A
reader who only learns the clicks hasn't learned anything that survives the next version; a
reader who understands the idea can find the button on their own.

The tone is warm and encouraging, never condescending. We are proud to show someone something
new, not surprised they didn't already know it. Never say "obviously," "just," or "simply" —
those words tell a struggling reader that they are the problem.

## Voice

- **Second person.** Write "you," not "the user" or "one."
- **Short sentences.** Eighteen words or fewer on average across a paragraph — some can run
  longer, some shorter, but the average holds.
- **Short paragraphs.** Four sentences or fewer. One idea per paragraph; start a new paragraph
  for a new idea rather than stretching one with "additionally" and "furthermore."
- **Active voice.** "The Scheduler runs your work order," not "Your work order is run by the
  Scheduler."
- **Everyday analogies — the agency metaphor.** This manual explains Session Manager as your own
  small agency of AI agents:
  - **You** are the client and the director — you decide what gets built and approve the work.
  - **The architect** is the project lead — it plans, breaks work into pieces, and tracks it to
    done.
  - **Dev-leads** are the builders — each one takes a single, already-scoped piece of work and
    builds it.
  - **The validator** is quality control — it checks finished work against what was promised.
  - **The Scheduler** is the work calendar — it lines up work orders and runs them in the
    background, even while you're away.

  Reach for this metaphor whenever a chapter introduces one of these roles, rather than inventing
  a new one per chapter.
- **Explain every technical term on first use**, in the same sentence or the one after it — or
  link it to `#glossary` if a full explanation would derail the paragraph. Never assume a term
  from an earlier chapter is still fresh; a reader may start anywhere.
- **No internal code names.** Never write `claudeSessionId`, `cwd`, `PTY`, `IPC`, `zustand`,
  `stream-json`, `reconcile`, or **`Epic`** — the UI calls it a **Session**, and the glossary may
  note `Epic` as the code name for readers who go digging in the source, but chapter prose never
  uses it.
- **Use UI labels exactly as they appear in `src/renderer`.** If the Scheduler tab says
  "Needs review," write "Needs review" — not "needs review," "pending review," or "flagged."

## Reading level

- **Flesch-Kincaid grade ≤ 9.0 per chapter**, checked by `npm run manual:readability` (lands in
  PRD mv2-03). A chapter that fails this gate gets simplified, not exempted.
- **900–1,600 words per chapter.** Long enough to teach one topic properly, short enough to
  finish in one sitting.
- **The glossary chapter is exempt from the word range** — its length is however many terms
  belong in it, not a target word count.

## Chapter template

Every chapter follows this shape, top to bottom:

1. `<h1>` — the chapter's title **exactly as written in `manual.json`**, character for character.
2. `<p class="lede">` — two to three sentences: what the reader will learn, and why it matters to
   them.
3. **Three to six `<h2>` sections** — the chapter's actual content, one topic per section.
4. **At least one analogy box** (`aside.manual-analogy`) somewhere in the body.
5. **A takeaways box** (`div.manual-takeaways`) near the end.
6. **A Next-up link** (`p.manual-next`) as the final element.

## Component vocabulary

These are the **only** classes a chapter may use. Each entry is the exact markup shape —
copy the pattern, fill in the words.

**`p.lede`** — the chapter's opening line, right after the `<h1>`:
```html
<p class="lede">What you'll learn, and why it matters to you.</p>
```

**`aside.manual-analogy`** — the "everyday comparison" box:
```html
<aside class="manual-analogy"><strong>Think of it like this:</strong> …</aside>
```

**`aside.manual-tip`** — an optional action the reader can try right now:
```html
<aside class="manual-tip"><strong>Try this:</strong> …</aside>
```

**`aside.manual-note`** — a useful fact that isn't essential to the main flow:
```html
<aside class="manual-note"><strong>Good to know:</strong> …</aside>
```

**`aside.manual-warning`** — a real risk or a common mistake:
```html
<aside class="manual-warning"><strong>Watch out:</strong> …</aside>
```

**`ol.manual-steps`** — a numbered how-to:
```html
<ol class="manual-steps">
  <li>Open the Scheduler tab.</li>
  <li>Click a queued work order.</li>
</ol>
```

**`ol.manual-flow`** — a conceptual box-and-arrow diagram, three to six items, never a fake
screenshot:
```html
<ol class="manual-flow">
  <li><strong>You</strong> approve a Session.</li>
  <li><strong>The architect</strong> plans and queues the work.</li>
  <li><strong>The Scheduler</strong> runs it in the background.</li>
</ol>
```

**`table.manual-table`** — a comparison table, three columns or fewer:
```html
<table class="manual-table">
  <thead><tr><th>Term</th><th>What it means</th></tr></thead>
  <tbody><tr><td>Session</td><td>One job for your agency.</td></tr></tbody>
</table>
```

**`dl.manual-glossary`** — glossary chapter only:
```html
<dl class="manual-glossary">
  <dt>Session</dt>
  <dd>One job for your agency, from a goal to a finished result.</dd>
</dl>
```

**`div.manual-takeaways`** — the end-of-chapter recap, three to five items:
```html
<div class="manual-takeaways">
  <h2>What you learned</h2>
  <ul>
    <li>What a Session is.</li>
    <li>How to start one.</li>
  </ul>
</div>
```

**`p.manual-next`** — the closing link to the next chapter:
```html
<p class="manual-next">Next up: <a href="#claude-code-basics">Claude Code in plain English</a></p>
```

**`kbd`, `code`, `pre>code`** — `kbd` for a literal keypress, `code` for a short inline literal
(a file name, a label, a command fragment), `pre>code` for a runnable block. **At most two
`pre>code` blocks per chapter** — this is a manual about a cockpit, not a terminal manual; most
chapters need zero.

No other class, tag, or attribute is allowed. No inline `style`, no `<style>` or `<script>`
block, no `<figure>` or screenshot in 2.0.0, no external image.

## Words we use

Every term below was checked against the source file named in the last column before it was
written here. A term that couldn't be verified against real source was dropped, not guessed.

| Term | Plain definition | UI label |
| --- | --- | --- |
| AI agent | Not a chatbot that just answers — a program that plans, uses tools, and does multi-step work toward a goal you give it. | — |
| Claude Code | The command-line tool from Anthropic that Session Manager wraps in a cockpit. | — |
| Session Manager | This app — a desktop cockpit for running several Claude Code agents at once. | — |
| Session | One job you hand to your agency, from a goal to a finished result. Chat and Terminal are two ways of looking at the same Session. | Sessions |
| Chat | The conversation view of a Session — type a message, read the reply. | Chat |
| Terminal | The raw command-line view of the same Session, for when you want to see everything it's doing. | Terminal |
| New Session | The button that starts a fresh Session. | + New Session |
| Proposed | A Session that's been set up but hasn't started yet — nothing has run, nothing has been spent. | — |
| Active | A Session that is running: it's authoring work orders and the Scheduler is reporting back into it. | — |
| Completed | A finished Session, archived with its full history. | — |
| Approve & start | The button that turns a Proposed Session into an Active one and sends its first instruction. | Approve & start |
| Agent | Which member of your agency works this Session — the "who." | Agent |
| Agent Library | Where you browse, edit, and create the agent personas available on your machine. | Agent Library |
| Mission | What kind of work this Session is — the "how." It shapes how eagerly the agency queues follow-up work. | Mission |
| Tag Library | Where you manage the list of Missions a Session can carry. | Tag Library |
| Architect | The agency's project lead — plans the work, breaks it into pieces, and tracks it to done. | — |
| Dev-lead | One of the agency's builders — takes a single, already-scoped piece of work and builds exactly that. | — |
| Validator | The agency's quality control — checks finished work against what was promised before it counts as done. | — |
| Scheduler | The agency's work calendar — lines up work orders and runs them, including while you're away. | Scheduler |
| Work order (PRD) | One scheduled piece of work the Scheduler runs on its own, with everything it needs to finish written down. | PRD |
| Queue | The list of work orders that are waiting, running, or finished. | — |
| Needs review | A work order that stopped because it has a question only you can answer. | Needs review |
| House rules | This manual's word for the standing instructions, settings, and permissions you give every Session. | — |
| System Prompt | The house rules every Session reads before anything else — your standing instructions file. | System Prompt |
| Settings | App-wide preferences: theme, voice, and other machine-level choices. | Settings |
| Permissions | The rules that decide what an agent may do without stopping to ask you first. | Permissions |
| Skills | Packaged instructions an agent can load for a specific kind of task. | Skills |
| Plugins | Installable extensions that add new skills, agents, or tools to Claude Code. | Plugins |
| MCP Servers | Connections that let an agent reach outside tools and services. | MCP Servers |
| Hooks | Small scripts that run automatically when something happens in a Session. | Hooks |
| Memory | Notes an agent keeps and can read back in a later Session. | Memory |
| Dashboard | The one-page overview of every project and every Session on your machine. | Dashboard |
| Project Home | A one-page, auto-written overview of a single project. | Project Home |
| File Explorer | The built-in file browser and editor. | File Explorer |
| History | A record of past Sessions, with cost and usage over time. | History |
| Voice | Talk to your agents with your microphone instead of typing. | Voice |
| Host on Bilko.run | Publish a project's overview page to the public web. | Host on Bilko.run |

## Honesty rules

- **Every claim about Session Manager or Claude Code is checked against real source before it is
  written** — the app's own code and docs in this repo for Session Manager, and
  [code.claude.com](https://code.claude.com) docs for Claude Code itself. Never write a claim
  from memory of "how it probably works."
- **No `<figure>` and no screenshots in 2.0.0.** Describe what the reader will see in words.
- **No inline styles, no `<style>` or `<script>` blocks, no external images.**
- **Session Manager itself is free** (`npx claude-code-session-manager@latest`) — the Field
  Manual is the only thing that's paid. Say this plainly wherever it's relevant; never imply the
  app needs a purchase to work.
- **Never promise a feature that doesn't exist.** If a chapter needs to describe a limitation or
  a gap, say so honestly rather than describing the feature the reader wishes existed.

## Cross-links

A chapter may only link to another chapter's slug, as `href="#<slug>"`. These are the thirteen
valid targets, from `manual.json`:

`welcome`, `what-is-an-agent`, `claude-code-basics`, `meet-your-agency`, `first-session`,
`plans-and-scheduler`, `checking-the-work`, `agents-and-missions`, `house-rules`,
`new-abilities`, `cockpit-tour`, `good-habits`, `glossary`

Never link to a slug outside this list, and never link to an external URL from chapter prose —
external references belong in this manual's own honesty-rules research, not in a reader-facing
link.
