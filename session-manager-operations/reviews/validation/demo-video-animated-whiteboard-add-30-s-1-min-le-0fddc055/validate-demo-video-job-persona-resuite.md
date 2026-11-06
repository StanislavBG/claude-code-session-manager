# Validation: job-persona-shipped-seed-uncapped (PRD 2596) — re-check

HEAD 712298a6, Base 3144bc52 (Epic commits 510fddc9…27158bcb). Review scope: re-check of one PRD after repair wave 2607-2610.

## job-persona-shipped-seed-uncapped — VERIFIED

- AC1 `buildPersonaBodyText(rawBody, personaPath, { uncapped = false })` returns whole body when uncapped, else cap + notice: agentModelResolve.cjs:206-212.
- AC2 uncapped only when digest matches `SHIPPED_PERSONA_SEEDS[agentType]` bodySha256: agentModelResolve.cjs:248-250; `shippedBodyHash` (197-200) mirrors newline normalize + trim + sha256.
- AC3/AC4 tests: agentModelResolve.test.cjs:350 (whole, no 'Truncated —'), :360 (appended line capped with notice), :364 (7000-char unshipped capped), :369 (digest equals personaBodyHash).
- AC5 comment above AGENT_BODY_CHAR_CAP documents the exemption: agentModelResolve.cjs:182-191.
- Gate: 3 test files, 77 passed; `npm run typecheck` exit 0.

## Real-path probe (HOME = temp dir, outside repo; resolver loaded from main checkout /home/bilko/Projects/session-manager)

- pristine copy of src/seed/agents/demo-video-builder.md: systemPrompt 21364 chars, `Truncated —` absent, contains `#F77F00`.
- same copy plus one appended line: systemPrompt 6129 chars, `Truncated —` present (capped, `#F77F00` cut).

## Full suite / typecheck

- `timeout 600 npm run test:unit` (SM_* unset): 891 files passed, 8431 passed | 1 skipped, 0 failed (167 s). The four previous reds (apiSurface, check-ops-path-literals, ProjectHomeEmptyState, macroLibrary v5) are gone. No flake seen.
- `timeout 300 npm run typecheck`: exit 0.

## Findings

- Critical: none. Important: none. Minor: none.
