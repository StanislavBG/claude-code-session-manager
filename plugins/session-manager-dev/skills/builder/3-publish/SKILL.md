---
name: builder:publish
description: Step 3 of builder — the ISOLATED WORKTREE publish technique. Bumps the version, tags, then does the actual build+publish from a clean git worktree checked out at that tag so the live/dirty working directory is never touched by prepublishOnly's build step. Every command below was run for real 4 times in the session that originated this skill (session-manager v0.45.1 → v0.47.1).
---

# builder:publish

A dirty working tree in the main repo is **not** a blocker for this step — that's the whole
point of the isolated-worktree technique. Run the sequence below in order, without pausing
to ask for reconfirmation once `builder:gate` has passed.

## Procedure (exact order — verified across 4 real publishes)

1. **Bump the version, package.json only:**
   ```
   npm version <bump> --no-git-tag-version
   ```
   (`<bump>` is the kind decided by `builder:classify-and-bump` — `patch`/`minor`/`major`.)
   `--no-git-tag-version` matters: it updates `package.json`/`package-lock.json` without
   creating a git tag yet, so the tag step below can carry a proper message.

2. **Stage only the two version files — never `-A`:**
   ```
   git add package.json package-lock.json
   ```

3. **Commit, with a message listing the commits this release covers:**
   ```
   git commit -m "chore(release): bump to v<version>

   - <commit 1 subject>
   - <commit 2 subject>
   - ..."
   ```

4. **Tag the release commit:**
   ```
   git tag v<version>
   ```

5. **Create the isolated worktree from that tag:**
   ```
   git worktree add /tmp/sm-publish-v<version> v<version>
   ```

6. **Move into the worktree and build clean:**
   ```
   cd /tmp/sm-publish-v<version>
   npm ci
   npm run typecheck
   ```
   `npm ci` gives a fully clean `node_modules` from the lockfile — no leftover local state
   from the dirty main repo can leak into the published artifact.

7. **Publish from inside the worktree:**
   ```
   npm publish
   ```
   This project's `prepublishOnly` script runs `vite build` — because step 6 already `cd`'d
   into `/tmp/sm-publish-v<version>`, that build runs **inside the clean worktree**, never
   touching (or being affected by) the live/dirty working directory back in the main repo.
   This is the entire reason the worktree exists: it decouples "what's uncommitted in my
   editor right now" from "what gets built and shipped."

   **If this 403s with `Two-factor authentication or granular access token with bypass 2fa
   enabled is required to publish packages`**, this is NOT a login/auth-token problem (`npm
   whoami` can succeed while this still fails) — it's npm's separate write-path 2FA gate. Do
   not retry `npm login`. Run `npm profile get` and `npm token list` to confirm (2FA disabled
   + a legacy "classic" token = structurally blocked, and the CLI cannot mint a
   granular/bypass-2FA token — that's npmjs.com-web-UI-only). Stop here and report; see the
   `builder` agent persona's "Publish auth" section for the full decision tree and why a
   bypass-2FA token is a bridge, not a durable fix (npm is deprecating it — Phase 2 ~Jan 2027
   removes its publish capability entirely).

8. **Back in the main repo, push:**
   ```
   cd <main repo path>
   git push origin main
   git push origin v<version>
   ```

9. **Clean up the worktree:**
   ```
   git worktree remove /tmp/sm-publish-v<version> --force
   ```

10. **Verify the publish actually landed on the registry:**
    ```
    npm view <packageName> version
    npm view <packageName> dist-tags
    ```
    Confirm the reported version matches `<version>` and `latest` points to it (unless the
    project intentionally publishes to a different dist-tag).

## On any step failing

Stop at that step. Do not proceed. Report which step failed and its output. If the worktree
was already created (step 5+), leave it in place if its state is relevant evidence for
diagnosing the failure; otherwise remove it (step 9) before reporting, so a retry doesn't
collide with a stale `/tmp/sm-publish-v<version>` path.

## Output

- Version published.
- Confirmation the worktree was removed.
- `npm view` output proving the registry has the new version and correct dist-tag.
- Confirmation both `git push` calls succeeded (main + tag).
