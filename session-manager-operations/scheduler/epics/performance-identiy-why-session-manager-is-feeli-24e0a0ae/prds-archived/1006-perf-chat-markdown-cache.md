---
title: Perf P3: cache chat markdown rendering (marked + DOMPurify) instead of re-parsing every turn on every render
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 30
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

renderChatMarkdown() (src/renderer/lib/renderChatMarkdown.ts:33) runs marked.parse() then DOMPurify.sanitize() — the latter builds a real DOM fragment per call — and it is invoked directly in render bodies with no memoization at ChatTranscriptTurn.tsx:746, ChatTranscriptTurn.tsx:1368 and EpicDetail.tsx:206. The Epic timeline maps every visible turn with no virtualization (EpicDetail.tsx:873) and the feed holds up to FEED_TURNS_CAP = 1000 turns (state/chat.ts:996). There is exactly ONE React.memo in the entire renderer, so any store touch re-parses and re-sanitizes the whole visible transcript. Add a bounded module-level cache keyed on the source string plus per-turn memoization so identical markdown is parsed once.

# Acceptance criteria

- [ ] src/renderer/lib/renderChatMarkdown.ts gains a bounded cache keyed on the exact input string, with a named cap constant (suggest 400 entries) and oldest-first eviction when the cap is exceeded.
- [ ] A cache hit returns a string byte-identical to what a cache miss produces (asserted in a test).
- [ ] An exported clearChatMarkdownCache() exists so tests can reset state between cases.
- [ ] The three call sites (ChatTranscriptTurn.tsx:746, ChatTranscriptTurn.tsx:1368, EpicDetail.tsx:206) either wrap the call in useMemo keyed on the source text, or the enclosing turn component is wrapped in React.memo so an unchanged turn does not re-invoke the renderer. The result states which approach was used per call site.
- [ ] New unit test in src/renderer/lib/__tests__/ asserts: same input twice returns an identical string; the cache evicts at the cap; and clearChatMarkdownCache resets it.
- [ ] Sanitization is NOT weakened: a test asserts a script-tag input is still stripped on both the cold and the warm path.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Key files: src/renderer/lib/renderChatMarkdown.ts, src/renderer/components/ChatTranscriptTurn.tsx (746, 1368), src/renderer/components/epics/EpicDetail.tsx (206, 873).

The cache MUST be keyed on the raw source string only — chatMarkdownRenderer and the marked options are module constants (renderChatMarkdown.ts:28-35) and never vary per call, so the source string is a complete key. If you change that assumption, the key must change with it.

Security is non-negotiable: DOMPurify.sanitize must still run on every distinct input. Caching the sanitized OUTPUT is fine; skipping sanitization is not.

Do not virtualize the timeline in this PRD — that is a bigger change with scroll-restoration risk and is deliberately out of scope.

Renderer tests use vitest (npm run test:unit); this repo does not use node --test.

# Out of scope

- Virtualizing the Epic timeline list
- Changing chatVerbosity filtering rules or turnMinVerbosity behaviour
- Lowering FEED_TURNS_CAP
- Any Workbench/context changes (separate PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
