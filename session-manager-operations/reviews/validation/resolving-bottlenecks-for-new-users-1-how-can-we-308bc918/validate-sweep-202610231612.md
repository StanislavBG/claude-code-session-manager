# Validation sweep 202610231612

Base: 70b02f43 (known). Commit for the PRD: 44c0a165 (touches only `.github/workflows/release.yml`, +38/-1).
Gate: `none`. Per-criterion evidence below. The workflow only runs on a real tag push, so it was not exercised.

## release-workflow-single-release — VERIFIED

- create-release job, idempotent draft, GH_TOKEN from secrets.GITHUB_TOKEN: release.yml:14-32 (`gh release view` else `gh release create --draft`; env GH_TOKEN at :21).
- Matrix job `needs: create-release` (:35); publish step uses `-c.publish.releaseType=draft` (:142).
- finalize-release `needs: release`, `if: success()`, runs `gh release edit "$TAG" --draft=false --latest` (:145-158).
- No other release creation: grep for `releaseType=release|gh release create|action-gh-release` hits only :31 (the draft create). Smoke steps (:108-134) precede the publish step (:140) and are unchanged in the diff.
- YAML parse: `require('js-yaml').load` succeeded; jobs = create-release, release, finalize-release; release.needs=create-release, finalize.needs=release.

## Findings

### Critical
none
### Important
none
### Minor
- release.yml:28 — if the release already exists *and is already published* (re-run after a prior success), the job reuses it; finalize then re-runs `--latest` harmlessly. Not a defect.
- release.yml:146 — `fail-fast: false` plus `success()` means one failed platform leaves an unpublished draft that needs manual re-run; this is the intended behaviour.
- Real-run behaviour (electron-builder reusing the draft) is untested until the next tag push.
