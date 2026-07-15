---
title: Default the FileTree's existing show-hidden toggle to on, and persist it
source: GitHub issue gh-issue-8 (https://github.com/StanislavBG/claude-code-session-manager/issues/8)
type: enhancement
severity: normal
---

# What happens / what's missing

The issue states the File Explorer "currently hides all files and folders that begin with a
dot (.)" with no way to see them, so users "must manually type file paths or use CLI commands
to access hidden files", and cannot reach `.claude/`, `.github/`, `.vscode/`. It asks to remove
the hidden-file filter, add visual styling for dotfiles, add icons, and *optionally* add a
"Hide Dot Files" toggle.

# Evidence

**The premise is substantially wrong — the toggle and the styling already exist.** Verified at
triage:

- `src/main/files.cjs:68,77` — `listDir(dirPath, showHidden)` already takes a `showHidden`
  parameter: `if (!showHidden && entry.name.startsWith('.')) continue;`. The filter is already
  conditional, not hardcoded.
- `src/preload/index.cjs:221` — already plumbed: `list: (path, showHidden) => ipcRenderer.invoke('files:list', { path, showHidden })`.
- `src/renderer/components/layout/FileTree.tsx:473-477` — a **user-facing toggle already
  exists**: an eye/eye-off icon button, `onClick={() => setShowHidden((v) => !v)}`, titled
  "Show hidden files" / "Hide hidden files".
- `src/renderer/components/layout/FileTree.tsx:655` — dotfiles are **already visually
  distinguished**: `node.name.startsWith('.') ? 'text-fg-faint' : 'text-fg-dim'`. That is the
  issue's "Hidden files and folders are visually distinguishable (muted color)" AC, shipped.
- `src/renderer/components/layout/FileTree.tsx:159,187,317,328` — every listing call already
  threads `showHidden`, and effects at :168/:196/:259 already re-load the tree when it flips.

So of the issue's 7 acceptance criteria, five are already met the moment the toggle is on, and
the "optional" toggle it offers as an afterthought is in fact the feature that already exists.

# Triage evaluation (2026-07-15)

**Reshaped from an epic to a two-line change plus persistence.** The genuine gaps:

1. ❌ **Default is off.** `FileTree.tsx:135` — `const [showHidden, setShowHidden] = useState(false)`.
   The filer's core argument — that dotfiles are project configuration, not system junk, and
   every modern editor shows them — is sound, and this project's own users live in `.claude/`.
   Accept: flip the default to `true`.
2. ❌ **The choice is not persisted.** It is plain `useState`, so it resets every mount. This
   is the more annoying half of the complaint and the issue never names it. A grep for an
   `appPrefs`-style store found none, so the PRD must follow whatever persistence
   `FileTree.tsx`'s existing `persistExpanded` uses rather than inventing a new store.

Declined / dropped from the issue's scope:
- **DECLINE "remove the filter"** — the filter is the toggle's implementation. Removing it
  deletes a working feature to satisfy a mis-stated premise. Change the default instead.
- **DECLINE the per-directory icon set** (`.git` → git icon, `.vscode` → VS Code icon) —
  unrelated cosmetic scope-creep bundled into a default-value change; the muted-color
  treatment at :655 already carries the affordance.
- **DECLINE `.DS_Store`/`Thumbs.db` exclusion** — this app ships Linux + darwin only; a
  hardcoded junk-file denylist is exactly the "special-case logic or allow-lists" the issue
  itself lists as a pro of *not* doing. Revisit if it's ever actually reported.
- **DECLINE the Success Metrics** ("90%+ of users can locate hidden files within 10 seconds") —
  unmeasurable; no usage telemetry exists.
- Note: the issue's "Related Work" cites "GitHub Issue #XX" placeholders — never filled in.

# Suggested direction

One small PRD:
1. `FileTree.tsx:135` — default `showHidden` to `true`.
2. Persist the toggle across mounts using the same mechanism `FileTree.tsx` already uses for
   `persistExpanded`; hydrate on mount, honoring an existing stored `false` (the issue's own
   "if users have explicitly configured a preference, honor that setting").
3. Verify `.git/` expansion doesn't degrade tree performance on this repo (the tree lazy-loads
   per-level already, per the `expanded`-keyed effects) — if it does, say so rather than
   silently capping.

## RESOLUTION

**Reshaped from an epic to a small change and queued** as PRD
`545-filetree-show-hidden-default-and-persist` (2026-07-15). Execution is the scheduler's job now.

The issue's premise — the File Explorer "hides all files and folders that begin with a dot" and
users "must use CLI commands to access hidden files" — is **wrong**. Verified at triage: the
`showHidden` parameter and conditional filter (`files.cjs:68,77`), the full IPC plumbing
(`preload/index.cjs:221`), the user-facing eye/eye-off toggle (`FileTree.tsx:473-477`), and the
muted dotfile styling (`FileTree.tsx:655`) **all already ship**. Five of the issue's seven AC are
met the moment the toggle is on — and the toggle it offers as an afterthought ("optional
enhancement") is the feature that already exists.

Queued (the real gaps): default `showHidden` to `true` (`FileTree.tsx:135`), and **persist it** —
it is currently plain `useState`, so it resets every mount. The persistence gap is the more
annoying half of the complaint and the issue never names it.

Accepted reasoning: the filer's core argument is sound — dotfiles are project configuration, not
system junk, this app's own users live in `.claude/`, and every modern editor shows them by default.

Declined: removing the filter (the filter **is** the toggle's implementation — removing it deletes a
working feature to satisfy a mis-stated premise); per-directory icon sets (unrelated cosmetic
scope-creep on a default-value change); the `.DS_Store`/`Thumbs.db` denylist (Linux + darwin only,
never reported, and the issue itself lists "no allow-lists needed" as a pro); the success metrics
(unmeasurable — no usage telemetry). Also noted: the issue's "Related Work" cites two "GitHub Issue
#XX" placeholders that were never filled in.

Originating issue: gh-issue-8 — https://github.com/StanislavBG/claude-code-session-manager/issues/8
