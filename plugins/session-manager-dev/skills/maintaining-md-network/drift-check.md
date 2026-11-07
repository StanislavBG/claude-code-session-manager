# Drift check and review record

## Contents

- [Running the script](#running-the-script)
- [Drift check mode](#drift-check-mode)
- [Review record](#review-record)
- [The map's maintainer comment](#the-maps-maintainer-comment)

## Running the script

The script is dependency-free Node. Run it through the skill's base directory:

```
node <skill base dir>/scripts/drift-check.cjs --root <repo>
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--root <dir>` | Repo to check. Defaults to the current directory. Must be a directory. |
| `--map <path>` | The entry map. Default: the CLAUDE.md or AGENTS.md at the root that holds the maintainer comment (see below). |
| `--file <path>` | Check only this file. Repeat for each file. Default: every tracked `.md` file (all `.md` files outside `.git` and `node_modules` when the repo is not git). |
| `--exclude <prefix>` | Skip files whose repo-relative path starts with the prefix. Repeat as needed. |
| `--checks <list>` | Comma list from `links`, `paths`, `limits`, `contents`. Default: all four. |

A flag that needs a value fails if the value is missing or starts with `--`.

### Output

One JSON object on stdout:

- `root`: the resolved repo root.
- `map`: the map file used, or null.
- `checkedFiles`: the repo-relative files checked.
- `findings`: a list, sorted by file then line.
- `counts`: findings per kind.

### Finding kinds

| Kind | Fields | Raised when |
| --- | --- | --- |
| `broken-link` | file, line, target | A markdown link to a file does not resolve, relative to the doc or to the repo root. URLs and `#anchors` are skipped. |
| `missing-path` | file, line, target | An inline code span that looks like a repo path does not exist, and git does not ignore it. |
| `over-line-limit` | file, lines, limit | A CLAUDE.md, AGENTS.md or unscoped `.claude/rules` file has more than 200 lines, or the map has more than 70. |
| `no-contents-list` | file, lines | A doc over 100 lines has no Contents heading and no list of anchor links near the top. |

Links and code spans inside fenced code blocks and HTML comments are ignored.

### Exit codes

- 0: no findings.
- 1: one or more findings. The JSON is still printed.
- 2: usage error (unknown flag, missing value, unknown check, bad root or map). A message goes to stderr.

### Use as a gate

Put the script on a `/develop` gate line. Exit 1 fails the gate:

```
timeout 120 node <skill base dir>/scripts/drift-check.cjs --root . --checks links,limits,contents
```

Use `--checks links,limits,contents` when a doc legitimately names paths that do not exist yet. Run all four checks in the scheduled sweep.

### Use in CI or on a schedule

One CI step, run on every pull request and on a weekly cron:

```
- name: Markdown network drift check
  run: node <skill base dir>/scripts/drift-check.cjs --root .
```

Replace the placeholder with the script's installed location. The step fails on any finding, and the JSON in the log lists them. A scheduled run catches rot that no pull request touched, such as a path removed from the code.

## Drift check mode

Drift check mode reviews only what changed since the last review.

1. Find the newest record: the file with the latest date among session-manager-operations/reviews/docs/<date>-md-network.md, or the project's own reviews folder. Read its Base commit, Map and Drift-check command.
2. If there is no record, stop and run a Full review instead.
3. List the changed files: `git diff --name-only <base>..HEAD`. Keep only the `.md` files that still exist.
4. Run the script with one `--file` per changed `.md` file, plus the `--map` and `--exclude` flags the record used:
   `node <skill base dir>/scripts/drift-check.cjs --root <repo> --file <changed.md> --map <map> --exclude <prefix>`
5. Run audit steps 1 (Census), 3 (Links and consumers) and 4 (Truth check) on those files only. A changed code file can make an unchanged doc stale, so also check docs that cite the changed code.
6. Report: script findings, census changes, new duplicated facts, wrong claims. Change no files until the human approves.
7. After approval, commit a new review record whose Base commit is the current HEAD.

## Review record

Every review, Full or Drift check, ends with one dated record, committed with the work. It is the next drift check's baseline.

Path: session-manager-operations/reviews/docs/<YYYY-MM-DD>-md-network.md (or the project's own reviews folder). Use one record per day. Commit it last, so Base commit is the commit just before it.

Template:

```
# Markdown network review <YYYY-MM-DD>

- Date: <YYYY-MM-DD>
- Mode: Full review | Drift check
- Scope: <folder, or the whole project>
- Base commit: <full sha of HEAD when the review finished>
- Owner: <name or team that owns the map>
- Map: <path of the entry map>
- Drift-check command: node <skill base dir>/scripts/drift-check.cjs --root <repo> --map <map> --exclude <prefix> ...
- Findings counts: broken-link N, missing-path N, over-line-limit N, no-contents-list N
- Census summary: <files> files, <lines> lines, <pct>% machine-written

## Verdicts

| Doc | Verdict | Owner doc |
| --- | --- | --- |
| <path> | KEEP-OWNER / MERGE-INTO / SHRINK-TO-POINTER / MOVE-TO-OWNING-REPO / DELETE | <doc that owns the facts> |

## Decisions

- <decision, and why>

## Follow-up PRDs

- <PRD id or slug, one line each, or "none">

## Next review due

<YYYY-MM-DD, 3 to 6 months out>
```

Rules:

- Drift-check command holds the exact flags, so the next run repeats the same scope and exclusions.
- Base commit is a full sha. A short sha or a branch name drifts.
- In a Drift check record, the Verdicts table lists only the files reviewed.
- Next review due is also due after a major model release.

## The map's maintainer comment

The map carries one HTML comment, so the script and the next reviewer can find it and its owner:

```
<!-- md-network-map owner: <name> last-review: <YYYY-MM-DD> -->
```

Without `--map`, the script looks for this comment in CLAUDE.md, then AGENTS.md, at the repo root. The first file that has it is the map, and it gets the 70-line limit. Update `last-review` in the same commit as each review record. HTML comments are stripped before the model reads the file, so the comment costs no context.
