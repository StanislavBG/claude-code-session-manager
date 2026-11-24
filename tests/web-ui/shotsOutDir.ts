import path from 'node:path'

// Where a screenshot spec under tests/web-ui/ writes its PNGs — one convention for every spec:
//   SM_SHOTS_OUT=<path>  that folder (resolved against the cwd), wins over everything else.
//   SM_UPDATE_SHOTS=1    the spec's tracked evidence folder, to refresh the committed screenshots;
//                        throws for a spec that declares none (set SM_SHOTS_OUT=<path> instead).
//   (default)            gitignored test-results/<specName>/, so a normal run never dirties the tree.
// Unit-tested by tests/unit/library-shots-out-dir.spec.ts.

export interface ShotsSpec {
  /** Folder name under test-results/ for the default run. */
  specName: string
  /**
   * Repo-relative tracked evidence folder that SM_UPDATE_SHOTS=1 writes. Declare one only when it
   * already holds git-tracked files (the unit test checks git ls-files); omit it otherwise.
   */
  trackedEvidenceDir?: string
}

export const LIBRARY_SHOTS: ShotsSpec = {
  specName: 'project-home-library',
  trackedEvidenceDir:
    'session-manager-operations/reviews/validation/project-home-as-a-player-knowledge-pages-video-p-4afa65b6/screens',
}

export const FEEDBACK_SHOTS: ShotsSpec = {
  specName: 'project-feedback',
}

export function outDirFor(
  root: string,
  { specName, trackedEvidenceDir }: ShotsSpec,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.SM_SHOTS_OUT) return path.resolve(env.SM_SHOTS_OUT)
  if (env.SM_UPDATE_SHOTS === '1') {
    if (trackedEvidenceDir === undefined) {
      throw new Error(
        `SM_UPDATE_SHOTS=1: screenshot spec '${specName}' has no tracked evidence folder. ` +
          `Set SM_SHOTS_OUT=<path> to choose where its PNGs go.`,
      )
    }
    return path.join(root, trackedEvidenceDir)
  }
  return path.join(root, 'test-results', specName)
}
