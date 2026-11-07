# Drift check and review record

## Contents

- [Running the script](#running-the-script)
- [Path conventions](#path-conventions)
- [First run: exclude machine records](#first-run-exclude-machine-records)
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
| `--strict-paths` | Report `unanchored-path` findings, and treat a link starting with `/` that matches no file as broken. Off by default. |

A flag that needs a value fails if the value is missing or starts with `--`.

### Output

One JSON object on stdout:

- `root`: the resolved repo root.
- `map`: the map file used, or null.
- `notes`: plain-text caveats, such as `no md-network-map comment found; the 70-line map limit was not applied`. Read it: an empty map means the map limit never ran.
- `checkedFiles`: the repo-relative files checked.
- `findings`: a list, sorted by file then line.
- `counts`: findings per kind.

### Finding kinds

| Kind | Fields | Raised when |
| --- | --- | --- |
| `broken-link` | file, line, target | A markdown link to a file does not resolve, relative to the doc or to the repo root. URLs and `#anchors` are skipped. A missing target that git ignores (runtime state) is not reported, the same exemption the paths check has. |
| `missing-path` | file, line, target | An inline code span that is a path candidate does not exist (relative to the root or the doc), no tracked file matches it as a suffix, and git does not ignore it. |
| `unanchored-path` | file, line, target, matches | Only with `--strict-paths`. The span does not resolve from the root or the doc, but tracked files match it as a path suffix or folder. The doc names the path without its full prefix. |
| `over-line-limit` | file, lines, expandedLines, limit | A CLAUDE.md, AGENTS.md or unscoped `.claude/rules` file has more than 200 lines, or the map has more than 70. `expandedLines` counts the file plus every `.md` it pulls in with an at-sign import (up to 4 hops, each file once); the limit applies to `expandedLines`. |
| `no-contents-list` | file, lines | A doc over 100 lines has no Contents heading and no list of anchor links near the top. |

Links and code spans inside fenced code blocks and HTML comments are ignored.

Rules the script applies:

- Path candidate: a code span is checked only if it has a slash, no spaces or glob/placeholder characters, no leading tilde, slash or at-sign, no URL scheme, and no domain-like first segment. It is then checked only if it is anchored: its last segment has a file extension, it ends in a slash, or its first segment exists at the repo root. A span like foo/bar with none of these is skipped. A trailing line suffix such as :12 or :12-20 is dropped first.
- Site route: a link starting with a single slash that does not exist under the repo root is treated as a website route and skipped. `--strict-paths` turns that skip off.
- Ignore marker: a line that contains the marker `<!-- drift-check-ignore -->` is skipped by the link and path checks.
- Ellipsis rule: a span with a `...` segment, such as src/.../x.ts, is a placeholder and is skipped.
- Map detection: without `--map`, the script looks for the maintainer comment in the root CLAUDE.md and AGENTS.md, then in the `.md` files they import with at-sign imports. The first file with the comment is the map.

## Path conventions

A backticked path claims the file exists in this repo. The script checks every such span, so write paths that legitimately do not exist here in a form it skips:

- A path in another repo: use a repo prefix and colon, such as Bilko:server/x.ts. The script skips it like a URL scheme. A ~/Projects/<repo>/ path also works, because a leading tilde is skipped.
- A retired or forbidden path named on purpose: write it in plain text, without backticks. Or end its line with the `<!-- drift-check-ignore -->` marker.
- A placeholder: a span with a `...` segment is skipped.

Write examples in plain text, not backticks, unless the path really exists.

Template placeholders: the links check skips a link target that contains double curly braces, a dollar sign followed by curly braces, or an angle-bracket placeholder such as repo in angle brackets. These are template fill-ins, not real paths.

Template folders: a folder of templates, such as docs/templates, holds relative links that only resolve once the template is rendered somewhere else. Pass each such folder as its own `--exclude` prefix, and record the flag in the review record's Drift-check command line.

## First run: exclude machine records

Machine-written records and runtime folders (job logs, archived PRDs, review records, generated reports) hold thousands of stale path mentions and drown real findings. On the first Full review:

1. From the census, list every machine-record and runtime folder.
2. Pass each one as its own `--exclude` prefix, for example `--exclude <folder>/`.
3. Run the script. If findings still come mostly from one folder, exclude it too.
4. Write the exact flags into the review record's Drift-check command line.
5. Drift check mode reuses those flags unchanged.

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
2. If there is no record, stop and run a Full review instead. Also run a Full review when the record is stale by restructure: its Verdicts table names docs that no longer exist, or its Base commit is not an ancestor of HEAD (check with `git merge-base --is-ancestor <base> HEAD`). A diff from such a base is not a trustworthy list of changes.
3. List the changed files: `git diff --name-only <base>..HEAD`. Keep only the `.md` files that still exist.
4. Run the script with one `--file` per changed `.md` file, plus the `--map` and `--exclude` flags the record used:
   `node <skill base dir>/scripts/drift-check.cjs --root <repo> --file <changed.md> --map <map> --exclude <prefix>`
5. Run audit steps 1 (Census), 3 (Links and consumers) and 4 (Truth check) on those files only. A changed code file can make an unchanged doc stale, so also check docs that cite the changed code.
6. Report: script findings, census changes, new duplicated facts, wrong claims. Change no files until the human approves.
7. After approval, commit a new review record whose Base commit is the current HEAD.

## Review record

Every review, Full or Drift check, ends with one dated record, committed with the work. It is the next drift check's baseline.

Path: session-manager-operations/reviews/docs/<YYYY-MM-DD>-md-network.md (or the project's own reviews folder). Use one record per day; a second record on the same date takes a -2 suffix (and -3, and so on). Commit it last, so Base commit is the commit just before it.

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
