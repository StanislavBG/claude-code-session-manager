#!/usr/bin/env bash
# Installs scripts/identity-guard.sh as this clone's pre-commit, commit-msg and
# pre-push hooks (session-manager-operations/architecture/identity-boundary.md). Hooks live in the shared hooks
# dir, so one install covers the main checkout and every worktree.
#
# The hooks run a COPY of the guard, so a checkout on a branch that predates the
# guard is still covered. Re-run this after changing identity-guard.sh.
# Refuses to replace a hook it did not write.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
hooks=$(cd "$root" && git rev-parse --path-format=absolute --git-path hooks)
mkdir -p "$hooks"
install -m 755 "$root/scripts/identity-guard.sh" "$hooks/identity-guard.sh"

for hook in pre-commit commit-msg pre-push; do
  file="$hooks/$hook"
  if [[ -e $file ]] && ! grep -q 'install-git-hooks.sh' "$file"; then
    echo "install-git-hooks: $file exists and was not written by this script; leaving it alone." >&2
    exit 1
  fi
  printf '#!/usr/bin/env bash\n# Written by scripts/install-git-hooks.sh. Re-run it after changing the guard.\nexec bash %q %s "$@"\n' \
    "$hooks/identity-guard.sh" "$hook" >"$file"
  chmod 755 "$file"
done

denylist=${BILKO_IDENTITY_DENYLIST:-$HOME/.config/bilko/identity-denylist}
echo "install-git-hooks: identity guard installed in $hooks (pre-commit, commit-msg, pre-push)."
if [[ ! -s $denylist ]]; then
  echo "install-git-hooks: warning: no deny-list at $denylist, so the hooks check nothing yet." >&2
fi
