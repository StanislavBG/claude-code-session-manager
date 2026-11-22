# Validation: drop-ci-npm-publish-job (PRD 3291)

Base: 417a5fbd977fc48c09a3cbddaa40cd6ae13f2d26. Commit: ce15b347 (3 files, +13/-63). PRD found in prds-archived/.
Review tools: self-review of the diff (docs/YAML deletion only; no code paths).

## drop-ci-npm-publish-job — VERIFIED

- AC1 release.yml: diff is a pure tail deletion (hunk @@ -156,53 +156,3 @@) of the comment block + `npm-publish:` job; all earlier lines (create-release, release matrix, finalize-release, tag trigger) are untouched, hence byte-identical. Gate node check printed "release.yml has no npm-publish job", rc=0.
- AC2 builder.md step 4: now "Publish path = local token", `~/.cache/sm-publish` worktree, granular token with "Bypass two-factor authentication", 90-day max, owner-renewed, E403 without it (.claude/agents/builder.md ~75-79).
- AC3 build-target.md: heading `### npm write-path 2FA gate / Trusted Publishing` kept (anchor stable; no inbound `trusted-publishing` links found); states "Trusted Publishing declined by the owner on 2026-11-21", same token path; Trusted Publisher registration instruction removed.
- AC4 SKILL.md: not in `git diff --stat` — unchanged.
- AC5 `npm run lint:docs`: "doc-hierarchy: ok (21 junctions, 35 files linted)", rc=0.
- No token, email or personal name in the diff (grep of added lines for `@`/`npm_` tokens: none).

## Findings

Critical: none.
Important: none.
Minor:
- .claude/agents/builder.md:72-75 — step 3 still says a bypass-2FA token is "a bridge at best / not a durable fix", slightly in tension with new step 4 making it the standing path (consistent with build-target.md's note that npm deprecates it ~Jan 2027). Acceptable; owner revisit noted in build-target.md.
