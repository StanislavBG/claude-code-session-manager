#!/usr/bin/env bash
# Identity guard: keeps the owner's real name and personal email out of this
# PUBLIC repository (session-manager-operations/architecture/identity-boundary.md).
#
# The forbidden strings are never committed. They are read from a local,
# untracked deny-list, one per line ($BILKO_IDENTITY_DENYLIST, default
# ~/.config/bilko/identity-denylist; blank and `#` lines are skipped). Matching
# is case-insensitive and fixed-string. Output names files, line counts and the
# deny-list entry number, never the matched text, so the guard cannot leak what
# it guards. No deny-list means nothing to check: it says so and exits 0.
#
# Modes (scripts/install-git-hooks.sh installs the first three as git hooks):
#   pre-commit          block staged added lines, and an author/committer
#                       identity, that match
#   commit-msg <file>   block a commit message that matches
#   pre-push <remote>   block pushed commits whose added lines or messages
#                       match; warn (only) on author/committer identities,
#                       since older commits predate the persona identity
#   tree [<rev>]        list tracked files that match (CI, audits); exit 1 on
#                       any hit
set -euo pipefail

mode=${1:-}
[[ $# -gt 0 ]] && shift
denylist=${BILKO_IDENTITY_DENYLIST:-$HOME/.config/bilko/identity-denylist}

case $mode in
  pre-commit|commit-msg|pre-push|tree) ;;
  *) echo "usage: identity-guard.sh pre-commit | commit-msg <file> | pre-push <remote> | tree [<rev>]" >&2; exit 2 ;;
esac

if [[ ! -r $denylist ]]; then
  echo "identity-guard: no deny-list at $denylist; skipping $mode" >&2
  exit 0
fi
patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
# Lowercased, without blank or comment lines: an empty pattern matches everything.
tr -d '\r' <"$denylist" | grep -v -e '^[[:space:]]*$' -e '^#' | tr '[:upper:]' '[:lower:]' >"$patterns" || true
if [[ ! -s $patterns ]]; then
  echo "identity-guard: deny-list $denylist has no entries; skipping $mode" >&2
  exit 0
fi

MARK='identity-guard-commit '

# match KIND [LABEL] < text: print "<label>\t<entry#>" per matching line.
#   diff  unified diff (git diff / git log -p --format="$MARK%H"): only added
#         lines and new paths count; labelled "<commit> <path>"
#   text  every line counts; "$MARK<sha>" lines switch the label to that commit
match() {
  awk -v kind="$1" -v label="${2:-}" -v mark="$MARK" '
    NR == FNR { pat[++n] = $0; next }
    index($0, mark) == 1 { commit = substr($0, length(mark) + 1, 8); label = commit; file = ""; hdr = 0; next }
    kind == "diff" {
      if ($0 ~ /^diff --(git|cc) /) { hdr = 1; next }
      if (hdr && substr($0, 1, 4) == "+++ ") {
        hdr = 0; file = substr($0, 5); sub(/^b\//, "", file)
        label = (commit != "" ? commit " " : "") file
      } else if (hdr || substr($0, 1, 1) != "+") next
    }
    {
      line = tolower($0)
      for (i = 1; i <= n; i++) if (index(line, pat[i])) { print label "\t" i; break }
    }
  ' "$patterns" -
}

# report HEADING < match output: print the heading and one line per label/entry.
report() {
  awk -F '\t' -v heading="$1" '
    { c[$1 "\t" $2]++; total++ }
    END {
      if (!total) exit
      print heading
      fflush()
      for (k in c) { split(k, a, "\t"); printf "  %s: %d line(s), deny-list entry #%s\n", a[1], c[k], a[2] | "sort" }
      close("sort")
    }
  '
}

advice() {
  cat >&2 <<'EOF'
This repository is public. Write "the owner" instead of the owner's real name or
personal email, and keep commits authored as the Bilko persona:
  git config user.name Bilko && git config user.email bilko@bilko.run
See session-manager-operations/architecture/identity-boundary.md.
EOF
}

case $mode in
  pre-commit)
    out=$(git diff --cached --no-color --no-ext-diff --no-renames -U0 | match diff | report "staged changes add a deny-listed identifier:")
    ident=$({ git var GIT_AUTHOR_IDENT || true; git var GIT_COMMITTER_IDENT || true; } | sed 's/ [0-9]* [-+][0-9]*$//' | match text "author/committer identity" | report "the commit identity contains a deny-listed identifier:")
    if [[ -n $out$ident ]]; then
      echo "identity-guard: commit blocked." >&2
      [[ -n $out ]] && echo "$out" >&2
      [[ -n $ident ]] && echo "$ident" >&2
      advice
      exit 1
    fi
    ;;

  commit-msg)
    msgfile=${1:?commit-msg needs the message file}
    # Drop git's comment lines and everything below the `git commit -v` scissors line.
    out=$(sed -e '/^# -* >8 -*$/,$d' -e '/^#/d' "$msgfile" | match text "commit message" | report "the commit message contains a deny-listed identifier:")
    if [[ -n $out ]]; then
      echo "identity-guard: commit blocked." >&2
      echo "$out" >&2
      advice
      exit 1
    fi
    ;;

  pre-push)
    remote=${1:-origin}
    blocked=0
    while read -r local_ref local_sha remote_ref remote_sha; do
      [[ $local_sha =~ ^0+$ ]] && continue # deleting a ref publishes nothing
      if [[ ! $remote_sha =~ ^0+$ ]] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
        range=("$remote_sha..$local_sha")
      else
        range=("$local_sha" --not "--remotes=$remote")
      fi
      out=$(git log -p --cc --no-color --no-ext-diff --no-renames -U0 --format="$MARK%H" "${range[@]}" </dev/null | match diff)
      msg=$(git log --format="$MARK%H%n%B" "${range[@]}" </dev/null | match text)
      if [[ -n $out$msg ]]; then
        blocked=1
        echo "identity-guard: push of $local_ref to $remote_ref blocked." >&2
        [[ -n $out ]] && report "commits add a deny-listed identifier (commit path):" <<<"$out" >&2
        [[ -n $msg ]] && report "commit messages contain a deny-listed identifier (commit):" <<<"$msg" >&2
      fi
      ident=$(git log --format="$MARK%H%n%an <%ae>%n%cn <%ce>" "${range[@]}" </dev/null | match text | cut -f1 | sort -u | wc -l)
      if [[ $ident -gt 0 ]]; then
        echo "identity-guard: warning: $ident pushed commit(s) on $local_ref carry a deny-listed author/committer identity (see session-manager-operations/architecture/identity-boundary.md, \"History\")." >&2
      fi
    done
    if [[ $blocked -eq 1 ]]; then
      advice
      exit 1
    fi
    ;;

  tree)
    rev=("$@")
    hits=0
    i=0
    while IFS= read -r p; do
      i=$((i + 1))
      # Binary files count too; -c prints "[<rev>:]<path>:<count>" and never the text.
      while IFS= read -r row; do
        [[ -z $row ]] && continue
        [[ ${#rev[@]} -gt 0 ]] && row=${row#"${rev[0]}":}
        hits=$((hits + 1))
        echo "  ${row%:*}: ${row##*:} line(s), deny-list entry #$i"
      done < <(git grep -c -i -F -e "$p" ${rev[@]+"${rev[@]}"} -- || true)
    done <"$patterns"
    if [[ $hits -gt 0 ]]; then
      echo "identity-guard: $hits tracked file match(es) for deny-listed identifiers." >&2
      advice
      exit 1
    fi
    echo "identity-guard: no tracked file contains a deny-listed identifier ($i entries checked)."
    ;;
esac
