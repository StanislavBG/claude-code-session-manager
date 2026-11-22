import { memo, useMemo } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { ClaudeMdWorkbench } from '../claudeConfig/ClaudeMdWorkbench'
import { CLAUDE_MD_SCOPES } from '../../lib/scopes'
import { InsertPresetMenu } from './Library'
import { SourceChip } from '../ui/SourceChip'
import { useHomeDir } from '../../lib/useHomeDir'

/**
 * System Prompt edits exactly ONE file: `~/.claude/CLAUDE.md`, the user-scope
 * instruction set the `claude` CLI loads into every session it starts on this
 * machine.
 *
 * It used to carry the three-way User/Project/Local ScopeSwitcher that
 * Settings and the other scoped editors carry, defaulting the scope off
 * `navFace`. That was wrong for this screen once it became HOME-only in the
 * sidebar (navGroups.ts): the Home face has no project context at all, so the
 * Project (`<cwd>/CLAUDE.md`) and Local (`<cwd>/CLAUDE.local.md`) tabs were
 * either disabled ("no active project") or — worse — silently editing whatever
 * unrelated project happened to own the active top tab while the user was
 * browsing a machine-wide screen. Those two files are contextual to a project
 * and are discovered by the CLI from the session's own cwd at invocation time;
 * they are not curated from Home. Nothing else changed — the file, the
 * `@`-import panel, the Presets library, and the save/revert path are the
 * same, there is just one scope now instead of three.
 *
 * Layout (2026-11-21): the shared ClaudeMdWorkbench (claude-config design,
 * render 10) — `~/.claude/CLAUDE.md` and every file it `@`-imports are radio
 * rows in the left column with line counts and a token estimate, above the
 * EVERY SESSION LOADS order; the selected one opens in DocumentEditorPane.
 * Imports are EDITABLE here, through the same dirty-tracked config store and
 * the same SaveBar as the root file: they are literally part of the prompt the
 * CLI loads, so making them read-only just meant a trip to another tab.
 */
const USER_SCOPE_NOTE = {
  title: 'User system prompt',
  body:
    'This is the real ~/.claude/CLAUDE.md on disk — the instructions the claude CLI loads into every session it starts on this machine, in every project. A project\'s own CLAUDE.md / CLAUDE.local.md are read from that project\'s directory when a session launches there; they are not edited here.',
}

const USER_ROOT_LABEL = 'User · every project on this machine'
const USER_EMPTY = {
  title: 'Nothing tells Claude how you like to work yet.',
  body: 'Claude loads this file into every session it starts on this machine, in every project.',
}

function SystemPromptComponent() {
  const home = useHomeDir()

  // Single scope, single path. `home` is null only for the first tick before
  // useHomeDir resolves, which the loading EmptyState below covers.
  const activePath = useMemo(
    () => (home ? CLAUDE_MD_SCOPES.resolve('user', home, null) : null),
    [home],
  )
  const roots = useMemo(
    () => (activePath ? [{ path: activePath, label: USER_ROOT_LABEL, eyebrow: 'YOUR INSTRUCTIONS FOR EVERY PROJECT' }] : []),
    [activePath],
  )

  if (!home || !activePath) return <EmptyState title="loading…" />

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="system-prompt">
      <ClaudeMdWorkbench
        home={home}
        scope="user"
        roots={roots}
        activeRoot={activePath}
        empty={USER_EMPTY}
        testIdPrefix="system-prompt"
        headerActions={({ importSelected }) => (
          <>
            <InsertPresetMenu path={activePath} disabled={importSelected} />
            <SourceChip path={activePath} />
          </>
        )}
        note={
          <div
            data-testid="system-prompt-scope-note"
            className="shrink-0 text-[11.5px] leading-snug"
          >
            <span className="font-semibold text-fg">{USER_SCOPE_NOTE.title}</span>
            <span className="mx-1.5 text-fg-faint">·</span>
            <span className="text-fg-dim">{USER_SCOPE_NOTE.body}</span>
            <span className="ml-1.5 font-mono text-fg-faint">{activePath}</span>
          </div>
        }
      />
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const SystemPrompt = memo(SystemPromptComponent)
