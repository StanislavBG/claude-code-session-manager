# release-notes/

Upgrade notes that become the top of a GitHub release body.

- To give the next release an upgrade note, write or append to `release-notes/after-<latest released tag>.md` (for example `after-v0.142.0.md`) on main before that release is tagged.
- Never edit a file whose release is already out; it is read from the tag's tree, so later edits reach no one.
- `.github/workflows/release.yml` (finalize-release) runs [`scripts/release-notes.cjs`](../scripts/release-notes.cjs), which publishes the note under `## Upgrade notes`, followed by the commit subjects since the previous tag, as the GitHub release body.
