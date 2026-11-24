import path from 'node:path'

// Where tests/web-ui/project-home-library-shots.spec.ts writes its PNGs.
// Default: gitignored test-results/project-home-library/, so a normal run never dirties the tree.
// SM_UPDATE_SHOTS=1: the tracked validation evidence folder, to refresh the committed screenshots.
export const LIBRARY_SHOTS_DEFAULT_REL = 'test-results/project-home-library'
export const LIBRARY_SHOTS_EVIDENCE_REL =
  'session-manager-operations/reviews/validation/project-home-as-a-player-knowledge-pages-video-p-4afa65b6/screens'

export function libraryShotsOutDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(root, env.SM_UPDATE_SHOTS === '1' ? LIBRARY_SHOTS_EVIDENCE_REL : LIBRARY_SHOTS_DEFAULT_REL)
}
