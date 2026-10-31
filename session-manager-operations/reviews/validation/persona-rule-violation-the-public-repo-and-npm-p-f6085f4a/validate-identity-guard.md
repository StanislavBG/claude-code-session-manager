# Validation: identity guard plan

Base `ebc119bf`. Commits in range: d772dc71 (2379), cf396c43 (2380), 27055e9d (2381), 79455f2d (2382), plus foreign 541914e1 (customer-feedback, not part of this plan).
No deny-list value, old manifest value or old fixture value is quoted here.

## scrub-owner-identity-from-tracked-files — VERIFIED
- `.claude-plugin/marketplace.json`: `.owner` = persona name/email/url, key order name,email,url (jq); `.plugins[0].version` 0.2.2; `.metadata.version` 0.1.0, same as at base.
- `plugins/session-manager-dev/.claude-plugin/plugin.json`: `.author` is the same object, `.version` 0.2.2, `.homepage` unchanged.
- Fixture log line 527: Author header reads `Bilko <bilko@bilko.run>`; numstat is 1 added / 1 deleted for that file.
- `PluginHomePage.test.ts:41` and `:190` (under `// Meta strip.`) use `Ada Author`.
- `bilko-run-marketing.md:15` reads "is our own multi-project *hosting platform* — the App-Store-style host for bilko.run — not a".
- Gate: the four named test files pass (run together with the guard test: 5 files, 52 tests); both jq gates exit 0.

## identity-guard-script — VERIFIED
- `git ls-files -s`: `scripts/identity-guard.sh` mode 100755; modes and `$BILKO_IDENTITY_DENYLIST` default at line 25.
- Script and test hold only persona strings and synthetic values (`example.invalid` email, made-up surname).
- Tree mode: `git grep -c -i -F -e "$p" ${rev[@]+"${rev[@]}"} --` at line 158 (no `-I`); pass line at 165 matches the spec.
- Doc references all point at `session-manager-operations/architecture/identity-boundary.md`; no `docs/identity` left.
- Test has the eight ported scenarios plus the binary-file tree hit (test title at line 132). Passes.

## identity-guard-hook-installer — VERIFIED
- `scripts/install-git-hooks.sh` mode 100755; uses `git rev-parse --path-format=absolute --git-path hooks`, installs a copy of the guard, refuses a foreign hook with exit 1, warns with no deny-list.
- `package.json`: `hooks:install` and `identity:scan` exact; `files` not in the diff.
- `scripts/README.md`: rows at lines 12-13 (shipped no); line 3 says six mechanisms and names git hooks.
- Installer scenarios present in the test (`describe('install-git-hooks.sh')`, 3 tests), passing. `npm run lint:docs` ok.
- Real hooks dir `/home/bilko/Projects/session-manager/.git/hooks` holds only `.sample` files; `core.hooksPath` unset. No hook installed.

## identity-boundary-doc-ci-law — VERIFIED
- `ci.yml`: one `Identity scan` step in job `ci`, after setup-node and before `npm ci`, script as specified.
- `identity-boundary.md` exists with the specified text (title, policy ID present). `architecture/README.md:22` has the LAW-RATIONALE row after telemetry.
- `CLAUDE.md`: law line at 135, 11,988 bytes, keeps `SIZE BUDGET — 12,000 chars`.
- Scan with `BILKO_IDENTITY_DENYLIST=/home/bilko/.config/bilko/identity-denylist`: output `identity-guard: no tracked file contains a deny-listed identifier (2 entries checked).`, exit 0. Not a skipping line.

## Findings
### Critical
- none
### Important
- none
### Minor
- Commit 541914e1 (customer-feedback docs, foreign to this plan) carries an author/committer address that is not the persona's. The guard's "History" section treats older commits as the owner's decision, and the pre-push hook only warns on identities. Not caused by this plan; the repo's current `user.email` is the persona. Whoever owns that commit should note it; installing the hooks will warn on push.
- `.github/workflows/ci.yml` skips the scan with only a warning when the secret is unset (by design, documented). Confirm the `IDENTITY_DENYLIST` secret is set, or CI enforces nothing.
- Code review / security self-review of the combined diff: no unsafe input handling, no secrets, no path traversal; guard prints file names and entry numbers only; the CI step writes the secret to a mktemp file without echoing it. No duplicated helper found.
- Hooks are not yet installed on the real repo (planner step), so local commits are unguarded until `npm run hooks:install` runs.
