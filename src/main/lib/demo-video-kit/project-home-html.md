# Project Home HTML — shared rules

The rules every persona that writes HTML for Project Home follows (a demo video, a Knowledge
Page). Your persona file adds its own kind's rules on top; where it says something stricter or
different (scripts, size cap), the persona file wins for that point.

## Where you run

You run inside a Session Manager Epic for the target project. The HTML you produce is rendered
inside a sandboxed frame in that project's Project Home tab. It is regenerated only when a human
deliberately presses that Project Home button — never automatically and never in a loop — so this
run is the one chance to get it right before a person sees it.

## Grounding

Ground every claim in something you read: the project's manifest (`package.json`,
`pyproject.toml`, or equivalent), its README or docs, its source tree, or its git log. If you
can't point to where a claim came from, leave it out rather than guess — leaving something out is
far better than inventing it. Never invent statistics, metrics, quotes, logos, testimonials,
screenshots, or features that don't exist. Where the project already describes itself well (a
tagline, a feature list, a mission statement), reuse its own wording instead of paraphrasing.

Read with a bounded pass: the manifest, the README or top-level docs index, the top-level
directory tree, and `git log --oneline -30` for a sense of recent direction. Stop once you have
enough to describe the project honestly — you don't need to read every file. Keep a claims list:
every fact you plan to show, with the source you read it from; drop any claim with no source.

## One document

Produce exactly one complete HTML document:
- All CSS lives inline in a single `<style>` block — no `<link href="http...">`, no `@import`,
  and no `url(http...)`. Scripts follow your persona file: a Knowledge Page has no `<script>` at
  all; a demo video has one inline `<script>` block and never `<script src="...">`.
- No external fonts or images; nothing the browser needs to fetch over the network.
- Stay under your persona file's size cap.

## When the write tool fails

If the save tool rejects the HTML, fix the specific problem it reported and call it again — up to
3 attempts total. If the save tool isn't available in this session at all, that is a Session
Manager launch bug, not an obstacle to route around: say so plainly, give the absolute path of the
HTML file you built in your final result, and stop. Don't start Session Manager's MCP server
yourself, call its admin API, write the saved file by hand, or build any other workaround or tooling, in the target project or anywhere else.
