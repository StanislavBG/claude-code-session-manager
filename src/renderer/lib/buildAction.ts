/**
 * buildAction — the pure decision layer behind the Sessions toolbar's Build
 * button (`EpicQueue`'s `useBuildAction` -> `SessionActionsBar`'s `build` prop).
 *
 * The point of this module is one distinction the button used to collapse:
 *
 *   - `resolveBuildTarget()` returning a target  → this project knows how to
 *     ship itself. Pressing Build runs a release.
 *   - `resolveBuildTarget()` returning `null`    → this project has **not been
 *     configured yet**. That is NOT the same as "this project can never be
 *     built", and it is the state EVERY non-npm project starts in, because the
 *     resolver only auto-discovers npm (`package.json`). Rendering it as a
 *     permanently greyed-out button turned a bootstrap problem into a
 *     capability denial, and hid the fix — dropping a
 *     `session-manager-operations/architecture/build-target.json` — behind
 *     reading the resolver's source.
 *
 * So `null` now means *unconfigured*: the button stays enabled and reads
 * **Set Up Build**, and pressing it mints a `build`-tagged Epic whose goal is
 * *bootstrap*, not *release* — probe the project read-only, write the two
 * config files, and stop for a human. The resolver deliberately stays dumb
 * (does a config exist? yes/no); discovery lives in the agent, where judgment
 * is available and an ecosystem list doesn't have to be hardcoded into the
 * main process.
 *
 * Pure by design so the label/tooltip/goal-text matrix is unit-testable without
 * mounting the queue.
 */

/**
 * Which act the Build button currently stands for.
 *
 * - `unavailable` — no active project tab; nothing to build against.
 * - `resolving`   — the target lookup hasn't answered yet. Distinct from
 *   `setup` so an npm project doesn't flash "Set Up Build" for one frame
 *   before its `package.json` resolves (same "none yet" vs "none, resolved"
 *   split `knownProjectAggregate` draws).
 * - `open`        — a build Epic is already in flight for this cwd; press
 *   re-opens it rather than minting a second one. Outranks both `run` and
 *   `setup`, and stays reachable even with no resolvable target.
 * - `run`         — configured. Press starts a release run.
 * - `setup`       — unconfigured. Press starts the bootstrap Epic.
 */
export type BuildActionMode = 'unavailable' | 'resolving' | 'open' | 'run' | 'setup'

export interface BuildActionInputs {
  cwd: string | null
  /** `useBuildTarget`'s in-flight flag — true until the IPC lookup answers. */
  resolving: boolean
  /** Resolved target, or null for "no config and no publishable package.json". */
  target: unknown | null
  /** A non-completed `build`-tagged Epic for this cwd, if any. */
  inFlight: unknown | null
  /** An Epic mint is mid-flight from a previous press. */
  creating: boolean
}

export function buildActionMode({ cwd, resolving, target, inFlight, creating }: BuildActionInputs): BuildActionMode {
  if (!cwd) return 'unavailable'
  // Re-reaching an in-flight build Epic is the one act that must work
  // regardless of target state — the guard exists to get the user back to
  // that Epic, not to gate them out of it.
  if (inFlight) return 'open'
  if (resolving || creating) return 'resolving'
  return target ? 'run' : 'setup'
}

/** The button's own label. `creating` collapses into `resolving` above, so the
 *  press-feedback state reuses the neutral label rather than inventing one. */
export function buildActionLabel(mode: BuildActionMode): string {
  switch (mode) {
    case 'open':
      return 'Open Build'
    case 'setup':
      return 'Set Up Build'
    default:
      return 'Run Build'
  }
}

export function buildActionTooltip(mode: BuildActionMode): string {
  switch (mode) {
    case 'unavailable':
      return 'No active project tab — open a project to use Build'
    case 'resolving':
      return 'Checking this project for a build target…'
    case 'open':
      return 'A Build session is already in flight for this project — opens it instead of starting a new one'
    case 'setup':
      return 'This project has no build target yet — starts a session that probes it, writes session-manager-operations/architecture/build-target.json plus a .claude/agents/builder.md overlay, and stops for your approval'
    case 'run':
      return "Start a fresh Build session that checks git vs the published package and publishes if there's anything new"
  }
}

/** Only `unavailable` truly blocks — `setup` is the whole point of the change. */
export function buildActionDisabled(mode: BuildActionMode): boolean {
  return mode === 'unavailable' || mode === 'resolving'
}

/** The release goal — a configured project's normal Build press. */
export const BUILD_RELEASE_GOAL_TEXT =
  "/builder\n\nCheck git vs the published package for this project, decide the right version bump, and publish if there's anything new."

/**
 * The bootstrap goal — an unconfigured project's first Build press.
 *
 * Deliberately does NOT invoke `/builder`: that skill is the release protocol,
 * and running it here is exactly the accidental-publish this flow exists to
 * prevent. The probe is read-only (file-existence checks plus two git reads,
 * no network, no mutation) and the session ends at a human gate — the second
 * press, once `build-target.json` exists, is a normal release run.
 */
export const BUILD_SETUP_GOAL_TEXT = [
  'Set up this project’s build target. This project has no build target configured, so Session Manager cannot release it yet. Configure it — do NOT run a release in this session.',
  '',
  '1. Probe the project. Read-only: file-existence checks and git reads only, no network calls and no mutations.',
  '   - Which of these exist: package.json, pyproject.toml, Cargo.toml, go.mod, Dockerfile, VERSION, CHANGELOG.md',
  '   - `git tag` — is there a release-tag pattern, and are there ANY tags at all? Zero tags is a real and common answer: the usual `git log <last-release-tag>..HEAD` baseline does not exist, so state explicitly what baseline the release should use instead (e.g. the root commit, or a dated cutoff).',
  '   - Publish/release commands in a Makefile, package scripts, or CI workflows under .github/workflows/',
  '   - What the last actual release looked like in `git log`',
  '   - What CLAUDE.md / README say about how this project ships',
  '',
  '2. Write `session-manager-operations/architecture/build-target.json`:',
  '   { "registry": …, "packageName": …, "versionBumpPolicy": …, "gates": [ … ] }',
  '   `registry` is free-form — "npm", "git-tag", "container", whatever this project actually ships to. Many local-first projects publish to no registry at all and release by tagging; say that rather than inventing a registry. Having a pyproject.toml does NOT mean the project is uploaded to PyPI.',
  '',
  '3. Write the project-local `.claude/agents/builder.md` overlay holding the concrete release sequence — the exact commands, in order, including any gates and any post-release step (e.g. "the live server needs a restart to pick up the new version").',
  '   The overlay may OVERRIDE inherited instructions by name, not only add to them. Example: the isolated-worktree publish technique in the global builder protocol exists because `vite build` reads the working directory — a project with no build step does not need it, and an executor that copies it anyway is doing pointless work. If it does not apply here, say so by name in the overlay.',
  '',
  '4. STOP and report. Show both files and what you inferred them from, then wait for the human to approve. Do not bump a version, do not tag, do not publish, do not run the release you just described — a human gate between discovery and first execution is mandatory. Once approved, pressing Build again runs the real release.',
].join('\n')
