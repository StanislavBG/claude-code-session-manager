# Identity boundary

This repository and its npm package are public. Bilko is the only identity that may appear in them. The owner's real name and personal email must never appear in a tracked file, a commit message or a commit's author or committer. Write "the owner" instead. This is standing policy D-2026-10-20-02 in the owner's private portfolio ledger.

Do not quote the forbidden strings in this file or anywhere else in the repo. That includes the guard, its tests and its error messages.

## Where the strings can reach

`session-manager-operations/prompt-sessions/` and `session-manager-operations/scheduler/` are gitignored, so Epic transcripts and PRD bodies stay on the machine. Everything else an agent writes under `session-manager-operations/` may be tracked. Anything pasted from `git log` can carry an address, so a validation record or a captured run log in a test fixture needs the same care.

`.claude-plugin/marketplace.json` (`owner`) and `plugins/session-manager-dev/.claude-plugin/plugin.json` (`author`) ship in every npm tarball and name a person on purpose. Both carry the persona.

## The guard

`scripts/identity-guard.sh` reads the forbidden strings from a local deny-list that is never committed. The path is `$BILKO_IDENTITY_DENYLIST`, default `~/.config/bilko/identity-denylist`, mode 600, one string per line. The Bilko repo reads the same file. Matching is case-insensitive and fixed-string. An entry written `word:<string>` matches only as a whole word, where letters, digits and underscore are word characters, so a longer word that contains the string stays allowed. Output names files and entry numbers, never the matched text.

| Hook | Blocks |
| --- | --- |
| `pre-commit` | staged added lines, and an author or committer identity, that match |
| `commit-msg` | a commit message that matches |
| `pre-push` | pushed commits whose added lines or messages match. Matching identities only warn, so a branch holding older commits can still be pushed. |

A rejected commit stops a scheduler job too. The job rewrites the line; it does not bypass the hook.

To set up a machine:

1. Write the deny-list file.
2. Set the commit identity: `git config user.name Bilko && git config user.email bilko@bilko.run`. All worktrees and scheduler jobs share that repo config.
3. Run `npm run hooks:install`. Hooks live in the shared hooks dir, so this covers every worktree. The hooks run a copy of the guard, so re-run the install after you change the guard.

To audit the tree, run `npm run identity:scan`. It exits 1 on any hit. No deny-list means nothing to check: the guard says so and exits 0, so read its output before trusting a pass.

CI runs the same scan in the `ci` job from the `IDENTITY_DENYLIST` repo secret (one string per line). A push to `main` with no secret fails the step. A pull request with no secret only warns, because Dependabot and fork pull requests get no Actions secrets; the scan then runs on the push to `main`. A secret with no usable entries fails the step on every event, so on `main` a green step means the guard's pass line printed. A merge that Dependabot performs itself also runs without Actions secrets and fails the step, so merge its pull requests by hand. To set the secret, run `gh secret set IDENTITY_DENYLIST < ~/.config/bilko/identity-denylist`.

`--no-verify` bypasses the hooks. Do not use it to get past the guard.

## Limits

- The scan covers tracked files. `dist/` and `dist-web/` are build output from those files.
- Plain deny-list entries are substrings. An entry broad enough to match the repo's own URLs fails every scan, so keep entries exact. The GitHub handle is an open owner decision, not something this guard polices.

## History

The guard covers new work. What older commits and published versions hold, and whether to rewrite them, is the owner's decision, tracked outside this repo.
