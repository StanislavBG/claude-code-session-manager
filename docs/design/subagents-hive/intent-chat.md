# Agent Hive Launcher

_Started 2026-06-08 03:07 UTC_

---

## User

Lets work on individual tabs now; This is suppose to launch a Hive of agents on a task  (read the help text - A subagent is a separate Claude instance with its own system prompt, model, and tool restrictions. When the main Claude needs to delegate something focused — code review, security audit, large search — it spawns a subagent, which works in isolation and returns a single summary. Subagents protect the main context window from drowning in intermediate output and let you specialise prompts per task type.

Three views
Configured — Edit the subagents you have defined. Each one is a markdown file in ~/.claude/agents/ (User) or .claude/agents/ (Project), same as skills.
Live — Subagents that have spawned in any of your active terminal tabs in the last 60 seconds. Shows status and the prompt they were given.
Library — Browse community subagent definitions and install them.
Subagent anatomy
name — Referenced by the main Claude when delegating ("Task tool, subagent_type: code-reviewer"). Should be a stable identifier.
description — When to use this subagent. Main Claude reads descriptions to choose. Be specific about scope.
tools — Optional whitelist. If set, the subagent can ONLY use these tools. Tightening this is the easiest way to make a subagent safer.
model — Optional. Use a cheaper model (haiku) for simple agents to save cost; opus for complex reasoning.
Body — The system prompt the subagent runs with. Be explicit about what it should and shouldn't do.
Tips
• A subagent that returns 5000 words of debug logs has failed at its job — the whole point is to compress. Tell it to summarise.
• The "explorer" pattern (read-only subagent for codebase search) is a common starting point if you're building your first one.)   so I want to be more intuitive and easy to launch the agents, clear what happens maybe even some monitoring

## Assistant

_[tool: list_files]_

_[tool: view_image]_

Let me look at the existing file and assets before designing.

_[tool: read_file]_

I have existing variants. Let me explore them to understand the design vocabulary.

_[tool: read_file]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: questions_v2]_

The "Hive" page in your screenshot isn't in the current codebase yet — it's a fuller build than the placeholder sections in the variants. Before I design the Subagents/Hive tab properly, a few quick questions so I build the right thing:

## User

Questions answered:
- visual: Decide for me
- primary_job: All three, but launch-first
- launch_model: A 'recipe' (preset bundle of agents) you fire at a target
- monitoring: Full: status, streaming output preview, and a results digest
- keep_editor: Yes — keep it as a sub-view, but make launch the front door
- clarity: All of these
- variations: One resolved design
- library: Yes, design it too

## Assistant

_[tool: update_todos]_

Got it — launch-first, full monitoring, keep the editor as a sub-view, design the library too, one resolved design. I'll build it in the **Almanac** direction (matches your screenshot — paper-warm, Newsreader serif, terracotta).

My plan for the **Subagents / "The Hive"** tab — four sub-views with **Launch** as the front door:
- **Launch** — pick a *recipe* (preset agent bundle) → aim it at a target → a plain-language "what will happen" preview + fan-out diagram + cost/time estimate → fire.
- **Live** — fan-out monitor: each agent's status, progress, tokens/cost, streaming output preview, plus a results digest as they finish.
- **Configured** — the agent-definition editor (kept, refined).
- **Library** — community recipes/agents to install.

_[tool: str_replace_edit]_

First, let me expose the Almanac palette and wire the Subagents nav to a real page.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Let me add a `subagents` icon (the nav uses `item.id` as the icon name).

_[tool: write_file]_

Now the data + primitives file:

_[tool: update_todos]_

Got it — the Scheduler is washed-out and cryptic. I'll make it readable too. Both the Hive and Scheduler render inside the same app frame via the nav, so I'll build both as real pages. Let me add it to the plan and keep moving.Now the Launch front door:

_[tool: write_file]_

Now the Live monitoring view:

_[tool: write_file]_

_[tool: write_file]_

Now the Configured editor + Library:

_[tool: write_file]_

Now the HivePage shell that ties the four sub-views together:

_[tool: str_replace_edit]_

The Hive is built. Now let me wire it into a full-window app. First, let me let the Almanac frame open on a chosen tab:

_[tool: str_replace_edit]_

Now wire Scheduler into the frame too:Now the Scheduler data:

_[tool: write_file]_

_[tool: write_file]_

Now the Scheduler page — readable, with the cryptic bits decoded:

_[tool: write_file]_

Now the standalone app that mounts these full-window, opening on the Hive:

_[tool: update_todos]_

_[tool: show_html]_

_[tool: show_html]_

_[tool: str_replace_edit]_

Good, it's rendering. The "The hive" title is colliding with the subtitle when space is tight. Let me fix the header to stack cleanly, then review the other views.Let me review the Live, Configured, Library, and Scheduler views at a wider viewport.

_[tool: save_screenshot]_

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

Live view works well. Let me check Configured, Library, and the Scheduler.

_[tool: save_screenshot]_

Scheduler is dramatically more readable now. Let me see the job rows + the expanded detail panel.

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: eval_js]_

The screenshot tool isn't honoring inner-scroll. Let me verify the job rows exist and read cleanly via the DOM, and tighten a couple of narrow-width wraps.

_[tool: str_replace_edit]_

Job rows render. Let me tighten the narrow-width wrapping on a couple of labels.

_[tool: str_replace_edit]_

_[tool: register_assets]_

Let me register the deliverable and hand off.

_[tool: done]_

_[tool: fork_verifier_agent]_

Both tabs are built and live in the app frame — open on the Subagents nav, switch to Scheduler via the sidebar.

**The Hive (Subagents)** — launch-first, four sub-views:
- **Launch** — pick a *recipe* (preset agent bundle), aim it at a target, and a sticky **"What will happen"** panel spells it out: plain-language summary, a main → fan-out → digest diagram, per-agent read-only/returns hints, and a time/cost estimate before you commit. Fire → jumps to Live.
- **Live** — each agent's status, progress bar, streaming output line, tokens/elapsed, plus a **Results digest** that fills in as they finish (with the "only the digest reaches main" point made explicit).
- **Configured** — the agent editor, kept but cleaned up (roster, model, tools whitelist with read/write coloring, system prompt).
- **Library** — installable community recipes & agents.

**Scheduler** — readability pass: real contrast (titles in ink, not faded tan), bigger type, clear status badges, and every cryptic bit decoded — `0p · 0r · 21d` → "0 pending · 0 running · 21 completed today", `util< 90` → "Pause above 90% of window", and each job expands to a labeled Status / Timing / Location / Actions panel. Added a **PRDs** tab listing your PRDs with run buttons.

Notes:
- It opens on Subagents; the **Scheduler** sidebar item is wired live. The other nav items still show the placeholder section.
- Recipe data, agents, and jobs are plausible sample content — tell me what to swap.

Want me to wire up the remaining tabs next, or refine either of these?

