'use strict';

/**
 * builtinMacros.cjs — the machine-local Macro library's seeded built-ins.
 *
 * These drive Project Home's one-click actions through the same (agent, tag,
 * prompt) hot-key framework as user-created macros. `macroLibrary.cjs`'s
 * `ensureBuiltins` seeds any entry here that is missing from macros.json, and
 * upgrades a stored copy whose `builtinVersion` is behind this file when it is
 * unedited: `updatedAt === createdAt`, OR its label/agent/tag match and its
 * prompt is one of `priorPrompts` (the editor re-stamps `updatedAt` on every
 * Save, so timestamps alone cannot prove a real edit). Changing a built-in
 * prompt means moving the OLD prompt into `priorPrompts` (oldest first) and
 * bumping `builtinVersion`; `builtinVersion === priorPrompts.length + 1`.
 *
 * Optional fields: `inputs` (MacroInput[] — `{ name, label, default?, options?,
 * required? }`, one per `{{name}}` placeholder in the prompt; the hot key asks for
 * them before launching, and `ensureBuiltins` copies them into the seeded macro) and
 * `supersedes` (ids of custom, non-built-in macros retired from the library when
 * this built-in is first seeded, so the owner sees one button, not two). A built-in
 * with no `job` is never a background job; pressing it opens an Epic.
 *
 * Plain Node, no Electron imports.
 */

const BUILTIN_MACROS = Object.freeze([
  Object.freeze({
    id: 'builtin-project-home',
    label: 'Project Home',
    agentName: 'project-home-builder',
    tag: 'project-home-builder',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 3,
    job: Object.freeze({
      estimateMinutes: 20,
      entryKind: 'knowledge',
      artifactPaths: Object.freeze(['session-manager-operations/project-pages/knowledge/{id}/index.html']),
    }),
    priorPrompts: Object.freeze([
      "Generate this project's Project Home page: one self-contained HTML overview (what it is, who it is for, key features, structure, how to run it, key commands), grounded only in what you read in the repository. Save it with a single project_home_write call.",
      "Generate ONE Knowledge Page for this project as one self-contained HTML page, grounded only in what you read in the repository. The page is named on a 'Page: <name>' line in the additional instructions: Overview (the default when there is no Page line: what it is, who it is for, key features, structure, how to run it, key commands), How it works (architecture and main flows), FAQ (common questions with answers), or 'Custom topic: <text>' (a page about that topic). Build only that page; other pages stay untouched. Save it with a single project_page_write call, passing pageId equal to the id on the 'Entry id' line.",
    ]),
    prompt:
      "Generate ONE Knowledge Page for this project as one self-contained HTML page, grounded only in what you read in the repository. The page is named on a 'Page: <name>' line in the additional instructions: Overview (the default when there is no Page line: what it is, who it is for, key features, structure, how to run it, key commands), How it works (architecture and main flows), FAQ (common questions with answers), or 'Custom topic: <text>' (a page about that topic). A 'Page: Overview' line means the same as no Page line. Write for the reader named on an 'Audience:' line: Newcomers (new to the project: plain words, every term explained), Users (people who use it: what it does for them and how to use it) or Contributors (people who work on its code: name the real files and modules); with no Audience line, write for Newcomers. Size the page to a 'Length:' line: Brief (only the essentials), Standard (the usual depth) or In-depth (thorough, with more sections and more detail); with no Length line, write a Standard page. Read only the sources named on a 'Read from:' line — README & docs, Source tree (the code, its manifest and directory layout) or Git log — and ground every claim in those alone; with 'Read from: nothing selected' or no Read from line, read any of the three. Build only that page; other pages stay untouched. Save it with a single project_page_write call, passing pageId equal to the id on the 'Entry id' line.",
  }),
  Object.freeze({
    id: 'builtin-demo-video',
    label: 'Demo Video',
    agentName: 'demo-video-builder',
    tag: 'project-home-builder',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 7,
    job: Object.freeze({
      estimateMinutes: 60,
      entryKind: 'video',
      artifactPaths: Object.freeze(['session-manager-operations/project-pages/videos/{id}/index.html']),
    }),
    priorPrompts: Object.freeze([
      'Generate a 30-second demo video for this project as one self-contained HTML/JavaScript animation that presents its main goals and key features, grounded only in what you read in the repository. Save it with a single project_demo_video_write call.',
      'Generate a 30-second demo video for this project as one self-contained HTML/JavaScript animation that presents its main goals and key features, grounded only in what you read in the repository, with a matching on-device narration track per the audio policy in the persona. Save it with a single project_demo_video_write call.',
      'Generate a 30-second demo video for this project as one self-contained HTML/JavaScript animation that presents its main goals and key features, grounded only in what you read in the repository, with a matching on-device narration track: narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_demo_video_write call passing htmlPath.',
      "Generate a character and cute animated JavaScript video: a 30-second demo of this project as one self-contained HTML/JavaScript animation. Ground everything in what you read in the repository — invent an original mascot character whose look, name and personality match the project's theme and purpose, and tell the project's real goals and key features through it. The character, story and visuals must match the project's theme and purpose as read from the repository. Write the narration script first (hook, problem, solution, three features, call to action), then build every scene to match its line, with fun dynamic elements per the persona. Use the style named on a 'Video style: <name>' line in the additional instructions — Professional, Fun, Animated whiteboard, or Kinetic typography — otherwise pick the one that best fits the project. Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_demo_video_write call passing htmlPath.",
      "Generate a character and cute animated JavaScript video: a demo of this project as one self-contained HTML/JavaScript animation, 60 seconds long when the additional instructions carry a 'Video length: 60' line and 30 seconds otherwise. Ground everything in what you read in the repository — invent an original mascot character whose look, name and personality match the project's theme and purpose, and tell the project's real goals and key features through it. The character, story and visuals must match the project's theme and purpose as read from the repository. Write the narration script first (hook, problem, solution, key features, call to action), then build every keystone to match its lines, with the pacing and fun dynamic elements per the persona. Use the style named on a 'Video style: <name>' line in the additional instructions — Professional, Fun, Animated whiteboard, or Kinetic typography — otherwise pick the one that best fits the project. Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_demo_video_write call passing htmlPath.",
      "Generate a character and cute animated JavaScript video as one self-contained HTML/JavaScript animation, 60 seconds long when the additional instructions carry a 'Video length: 60' line and 30 seconds otherwise. The video kind is named on a 'Video kind: <name>' line in the additional instructions: Blog post (a video that presents the blog post named on the 'Video target:' line — a post path in this repository or a URL; read it and tell its real content) or Feature (a video about the feature named on the 'Video target:' line, found in the repository); with no Video kind line, make a Project demo of the whole project's main goals and key features. Ground everything in what you read in the repository (and the target) — invent an original mascot character whose look, name and personality match the subject's theme and purpose, and tell its real story through it. Write the narration script first (hook, problem, solution, key points, call to action), then build every keystone to match its lines, with the pacing and fun dynamic elements per the persona. Use the style named on a 'Video style: <name>' line in the additional instructions — Professional, Fun, Animated whiteboard, or Kinetic typography — otherwise pick the one that best fits. Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_video_write call passing the htmlPath and the id on the 'Entry id' line.",
    ]),
    prompt:
      "Generate a character and cute animated JavaScript video as one self-contained HTML/JavaScript animation, 60 seconds long when the additional instructions carry a 'Video length: 60' line and 30 seconds otherwise; a 'Video length: 30' line means 30 seconds. The video kind is named on a 'Video kind: <name>' line in the additional instructions: Blog post (a video that presents the blog post named on the 'Video target:' line — a post path in this repository or a URL; read it and tell its real content) or Feature (a video about the feature named on the 'Video target:' line, found in the repository); with no Video kind line, make a Project demo of the whole project's main goals and key features. A 'Video kind: Project demo' line means that same whole-project demo. Ground everything in what you read in the repository (and the target) — invent an original mascot character whose look, name and personality match the subject's theme and purpose, and tell its real story through it. A 'Character: off' line means no mascot: make a type-led animation in the chosen style that tells the same real story through moving type and shapes, skip the character wherever the persona uses one (design, _character, project_character_write, lip-sync, the character self-check) and save meta.character as null; a 'Character: on' line or no Character line keeps the mascot. Write the narration script first (hook, problem, solution, key points, call to action), then build every keystone to match its lines, with the pacing and fun dynamic elements per the persona. Use the style named on a 'Video style: <name>' line in the additional instructions — Professional, Fun, Animated whiteboard, or Kinetic typography — otherwise pick the one that best fits. A 'Video style: Auto' line means the same: pick the style that best fits. Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_video_write call passing the htmlPath and the id on the 'Entry id' line.",
  }),
  Object.freeze({
    id: 'builtin-review-md-network',
    label: 'Review MD network',
    agentName: 'architect',
    tag: 'discussion',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 1,
    inputs: Object.freeze([
      Object.freeze({ name: 'scope', label: 'Scope', default: 'the whole project', required: true }),
      Object.freeze({
        name: 'mode',
        label: 'Mode',
        options: Object.freeze(['Full review', 'Drift check']),
        default: 'Full review',
        required: true,
      }),
    ]),
    supersedes: Object.freeze(['review-md-network-d38ffd']),
    priorPrompts: Object.freeze([]),
    prompt:
      "Use the session-manager-dev:maintaining-md-network skill to review this project's markdown network. Scope: {{scope}}. Mode: {{mode}}.",
  }),
  Object.freeze({
    id: 'builtin-competitor-matrix',
    label: 'Competitor matrix',
    agentName: 'competitive-analyst',
    tag: 'project-home-builder',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 1,
    job: Object.freeze({
      estimateMinutes: 90,
      artifactPaths: Object.freeze(['session-manager-operations/project-pages/matrix/matrix.json']),
    }),
    priorPrompts: Object.freeze([]),
    prompt:
      "Build this project's competitor feature matrix: how this product compares to its top 4 competitors. The competitors are named on a 'Competitors:' line in the additional instructions — up to 4 semicolon-separated slots, each a product name or 'auto' (an 'auto' slot means pick the most popular remaining competitor in this product's category, with cited popularity evidence); with no Competitors line, reuse the saved matrix's competitors, or make 4 auto picks when there is no saved matrix. Warm-start first: call project_matrix_read and, when a matrix exists, keep its feature, group and competitor ids stable and research only what is new since its last run plus unknown cells. Then fan out Haiku competitive-researcher subagents, one per competitor plus one user-voice sweep, collecting official announcements, dev blogs, changelogs, docs and what users rave about or ask for, with a source URL for every claim. Compare their findings against this repository's real features (read from the README, docs, manifest, source tree and git log, each backed by a path) and merge everything into 6-12 logical feature groups; for every feature record a stable id, title, detailed description, support per product (yes/partial/no/unknown with evidence), user sentiment, priority, rationale, and a ready-to-run sessionGoal where this project lacks or only partly has it. Append a runs[] entry and save the whole matrix with one project_matrix_write call.",
  }),
  Object.freeze({
    id: 'builtin-cpu-audit',
    label: 'CPU audit & fixes',
    agentName: 'architect',
    tag: 'feature',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 1,
    inputs: Object.freeze([
      Object.freeze({ name: 'scope', label: 'Scope', default: 'the whole project', required: true }),
      Object.freeze({ name: 'scenario', label: 'Run scenario', default: 'idle, then its typical everyday load', required: true }),
    ]),
    supersedes: Object.freeze(['cpu-audit-fixes-8bd5d1']),
    priorPrompts: Object.freeze([]),
    prompt:
      "Critically evaluate how much CPU this project uses while it runs, then get the recommended changes built. Primary goal: it consumes fewer resources while it runs — CPU first, then memory, disk I/O, network and process count. Secondary goal: it gets faster. Behavior stays the same. Scope: {{scope}}. Run scenario to measure: {{scenario}}. The project's CLAUDE.md and AGENTS.md laws override this prompt.\n\n1. Learn how it really runs. Read the README, manifests and start scripts. List every long-running process and everything it starts: workers, child CLIs, MCP servers, file watchers, timers, cron entries. If the project has no long-running process (a library, CLI or static site), measure its main commands instead (build, test, a typical run).\n\n2. Measure a baseline before you look for fixes. If the project is already running on this machine, measure that instance; never start a second copy beside a live one (ports, locks and shared state clash). Put a hard timeout on every command. Measure each state of the run scenario over a fixed window of at least 5 minutes. Record per process: average and peak CPU %, RSS, threads, child processes started per minute, and wakeups or syscalls where you can (pidstat, ps, top -b, /proc/<pid>/stat deltas, strace -c -f). Then profile the top consumers so cost is attributed to functions, not guessed: attach a sampling profiler to the running process where the runtime allows it (perf, py-spy, the Node inspector, DevTools for renderer processes), and restart a process under a profiler only when nothing live depends on it. Save the exact commands so the after-measurement repeats them.\n\n3. Review the code critically, starting from the hottest profiled paths. Look for: polling and timers that fire while nothing changes (idle should be near 0% CPU); busy loops; full rescans or re-parses of large files and directories; recursive watchers on big trees; a process spawned per tick or per request; unbounded concurrency; work redone on every request or render instead of cached; UI re-render storms and animations running while hidden; sync I/O on hot paths; chatty logging; large JSON stringify/parse; retries without backoff; over-frequent heartbeats; leaks (listeners, intervals, caches that only grow). For each one, first ask whether the work needs to run at all, then how to make it cheaper. Prefer structural fixes (event-driven instead of polling, incremental instead of full rescans, one shared process instead of many) over micro-tuning.\n\n4. Rank findings by measured cost × confidence ÷ risk, and drop anything without a measurable cost. Show them as a table: rank | where (file:line) | what burns the resource | measured cost (CPU share, RSS, spawns/min) | recommended change | expected saving | risk or tradeoff. Name every tradeoff plainly, such as a slower refresh. If the project is already lean, say so with the numbers and stop; do not invent work.\n\n5. Build the changes through /develop, highest impact first. Each PRD carries its measured evidence, the change, and acceptance criteria a headless run can check: deterministic tests (fake timers proving nothing polls while idle, call or spawn counts, bounded work per tick) or a bounded micro-benchmark with a before number and a target. Never use \"launch the app and watch top\" as a criterion. Every fix gets a regression guard so the waste cannot quietly return, and existing tests stay green.\n\n6. Track the PRDs to a validated finish, then re-measure live with the same commands, window and scenario. Report a before/after table per process: average and peak CPU, RSS, spawns/min. If the running copy is an installed or released build rather than this tree, the after-measurement waits for that release: say exactly what has landed but is not live yet, and never claim a saving from tests alone.",
  }),
]);

module.exports = { BUILTIN_MACROS };
