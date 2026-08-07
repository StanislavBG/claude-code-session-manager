---
title: Perf P9: remove the dead recharts and framer-motion dependencies
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

recharts and framer-motion are listed in package.json dependencies but have ZERO import sites anywhere in src/ — verified by grep for "from 'recharts'" and "from 'framer-motion'", both empty. They are never bundled (confirmed during perf-code-split-heavy-screens, where the expected recharts saving did not materialise because it was never in the chunk), so they cost nothing at runtime — but every `npx claude-code-session-manager@latest` user still downloads and installs them, and postinstall runs electron-rebuild over the resulting tree. node_modules is currently 1.6 GB. Remove both.

# Acceptance criteria

- [ ] Re-verify before removing: grep the whole repo (not just src/) for recharts and framer-motion, including scripts/, bin/, e2e/ and any config file. Paste the grep output in the result. If ANY real usage is found, stop and report instead of removing.
- [ ] recharts and framer-motion are removed from package.json dependencies.
- [ ] package-lock.json is regenerated consistently with the removal.
- [ ] timeout 600 npm run build succeeds and the emitted chunk set is unchanged in composition (no chunk disappears or appears) — confirming these were genuinely not bundled. Report the index chunk byte size before and after; it is expected to be identical or near-identical.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] The result reports node_modules size before and after removal + a fresh install, so the install-weight saving is a measured number rather than an estimate.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

This is a dependency-hygiene change with a real user-facing effect (install size for every npx user), which is why it gets its own PRD rather than being folded into a code change.

Do NOT publish, bump the version, or tag. Release is a separate, human-triggered step (see the git-publish-autonomy rule: the human decides WHEN to publish; this PRD only prepares the tree).

Verify-before-delete is the whole point of AC1 — a grep that misses a dynamic import or a config-file reference would break the build for users without breaking it here. Check vite.config.ts, tailwind.config, postcss.config, any .storybook or e2e helper, and scripts/.

If the regenerated lockfile produces a large unrelated diff (transitive churn), say so in the result rather than hiding it — the human may want to review that separately.

Do not remove react-force-graph-2d: it IS still used (SkillReferenceGraph.tsx:2, rendered behind the Plugins graph-view toggle) and is now correctly lazy-loaded into its own 189 KB chunk.

# Out of scope

- Publishing to npm, bumping the version, or tagging
- Removing react-force-graph-2d (still genuinely used)
- Auditing or removing any other dependency not named here
- Changing the postinstall/electron-rebuild flow

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
