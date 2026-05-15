/**
 * Per-event documentation surfaced as tooltips in the Hooks tab sidebar.
 *
 * Source: code.claude.com/docs/en/hooks, verified 2026-05. Includes the 7 new
 * events shipped between 2026-04 and 2026-05 (`UserPromptExpansion`,
 * `PostToolBatch`, `PermissionDenied`, `StopFailure`, `TaskCreated`,
 * `CwdChanged`, `FileChanged`) per cycle-2 research-04 §3.
 *
 * Each entry is intentionally one-line `when` + one-line `payload` so the
 * tooltip fits without scrolling. The `example` is a representative argument
 * the user would pattern-match against in a matcher regex.
 */

export interface HookEventDoc {
  when: string
  payload: string
  example?: string
}

export const HOOK_EVENT_DOCS: Record<string, HookEventDoc> = {
  UserPromptSubmit: {
    when: 'Fires just before the user prompt is sent to the model.',
    payload: '{ prompt: string }',
    example: 'Block submission if the prompt mentions a secret.',
  },
  UserPromptExpansion: {
    when: 'Fires when a slash command expands into its final prompt text.',
    payload: '{ command: string, expanded: string }',
    example: 'Audit which slash commands actually run, post-expansion.',
  },
  PreToolUse: {
    when: 'Fires before any tool runs. Can block the call.',
    payload: '{ tool_name: string, tool_input: object }',
    example: 'matcher="Bash" — block dangerous shell commands.',
  },
  PostToolUse: {
    when: 'Fires after a tool completes successfully.',
    payload: '{ tool_name: string, tool_input: object, tool_result: string }',
    example: 'matcher="Write|Edit" — run a linter on changed files.',
  },
  PostToolUseFailure: {
    when: 'Fires after a tool errors out (non-zero exit, exception, or refusal).',
    payload: '{ tool_name: string, tool_input: object, error: string }',
    example: 'Pipe failed Bash runs into a desktop notification.',
  },
  PostToolBatch: {
    when: 'Fires once after a parallel batch of tool calls all complete.',
    payload: '{ tool_uses: Array<{ tool_name, tool_input, tool_result? }> }',
    example: 'Aggregate file-edit batches into a single commit message.',
  },
  Stop: {
    when: 'Fires when the model emits end_turn.',
    payload: '{ stop_reason: string, output_tokens: number }',
    example: 'Play a chime when the agent finishes a long task.',
  },
  StopFailure: {
    when: 'Fires when a turn aborts without end_turn (rate-limit, network, OOM).',
    payload: '{ reason: "rate_limit"|"network"|"oom"|"killed"|string }',
    example: 'Auto-resume on transient failures.',
  },
  SessionStart: {
    when: 'Fires once when a session boots (claude or claude -p).',
    payload: '{ source: "startup"|"resume", model: string, agent_type: string }',
    example: 'Inject a project-specific system prompt addendum.',
  },
  SessionEnd: {
    when: 'Fires once when the session terminates.',
    payload: '{ reason: "user_quit"|"timeout"|"error"|string }',
    example: 'Persist transcript summary to ~/.claude/projects/<>.',
  },
  Setup: {
    when: 'Fires during interactive setup (claude /setup, /init).',
    payload: '{ mode: "init"|"reconfigure"|string }',
  },
  PreCompact: {
    when: 'Fires before transcript compaction runs.',
    payload: '{ transcript_path: string, trigger: "manual"|"auto" }',
    example: 'Snapshot the pre-compact transcript for later diffing.',
  },
  PostCompact: {
    when: 'Fires after compaction; the active transcript is the compacted one.',
    payload: '{ transcript_path: string, trigger: "manual"|"auto" }',
  },
  InstructionsLoaded: {
    when: 'Fires after CLAUDE.md and any imported memory files are loaded.',
    payload: '{ source: "session_start"|"reload" }',
  },
  Notification: {
    when: 'Fires when Claude Code emits a desktop notification.',
    payload: '{ title: string, message: string }',
    example: 'Forward to your own notify-send / osascript pipeline.',
  },
  PermissionRequest: {
    when: 'Fires when a tool needs user permission (per the permissions block).',
    payload: '{ tool_name: string, tool_input?: object }',
    example: 'Auto-allow npm test invocations.',
  },
  PermissionDenied: {
    when: 'Fires when the user (or policy) denies a permission request.',
    payload: '{ tool_name: string, retry: boolean }',
    example: 'Track which tools the user habitually rejects.',
  },
  SubagentStart: {
    when: 'Fires when a subagent (Task tool) spawns.',
    payload: '{ agent_type: string }',
    example: 'matcher="security-reviewer" — log every security scan.',
  },
  SubagentStop: {
    when: 'Fires when a subagent finishes.',
    payload: '{ agent_type: string, reason: "end_turn"|"error"|string }',
  },
  TeammateIdle: {
    when: 'Fires when a teammate agent goes idle (waiting for input).',
    payload: '{ teammate_id?: string }',
  },
  TaskCreated: {
    when: 'Fires when a new Task is created via the Task tool.',
    payload: '{ task: { description: string, ...} }',
    example: 'Track each spawned task in an external queue.',
  },
  TaskCompleted: {
    when: 'Fires when a Task completes (success or failure).',
    payload: '{ task: { description: string, ...} }',
  },
  ConfigChange: {
    when: 'Fires when settings.json (any scope) is mutated mid-session.',
    payload: '{ source: "user_settings"|"project_settings"|"local_settings" }',
    example: 'Reload tooling that depends on env vars on config change.',
  },
  CwdChanged: {
    when: 'Fires when the working directory changes (e.g. agent cd-ing).',
    payload: '{ old_cwd: string, new_cwd: string }',
    example: 'Refresh project-scoped indexers when cwd drifts.',
  },
  FileChanged: {
    when: 'Fires when a watched file outside Claude Code\'s edits changes.',
    payload: '{ file_path: string, change_type: "modified"|"created"|"deleted" }',
    example: 'Re-run typecheck when any .ts file changes.',
  },
  WorktreeCreate: {
    when: 'Fires after a git worktree is created via /worktree or subagent isolation.',
    payload: '{ worktree_path?: string, branch?: string }',
  },
  WorktreeRemove: {
    when: 'Fires after a git worktree is removed.',
    payload: '{ worktree_path?: string }',
  },
  Elicitation: {
    when: 'Fires when Claude asks the user a multiple-choice question.',
    payload: '{ action: "accept"|"reject", ...}',
  },
  ElicitationResult: {
    when: 'Fires after the user resolves an elicitation prompt.',
    payload: '{ choice?: string }',
  },
}
