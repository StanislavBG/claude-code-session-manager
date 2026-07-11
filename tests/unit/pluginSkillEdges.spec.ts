/**
 * Cross-skill reference detection for a plugin's skill set.
 *
 * `detectSkillEdges` generalizes the hand-built node graph in
 * session-manager-operations/HUMAN_LEARN/SKILL_MAP.html: an edge A -> B whenever A's body text
 * references B by name (backticked, leading-slash, or bare whole-word).
 *
 * Source: src/renderer/lib/pluginSkills.ts.
 */
import { describe, it, expect } from 'vitest'
import { detectSkillEdges, type PluginSkillEntry } from '../../src/renderer/lib/pluginSkills'

function makeSkill(id: string, body: string): PluginSkillEntry {
  return { id, name: id, description: null, dir: `/skills/${id}`, path: `/skills/${id}/SKILL.md`, body }
}

const SKILLS: PluginSkillEntry[] = [
  makeSkill('alpha', 'This skill hands off to `beta` and again mentions `beta` later on.'),
  makeSkill('beta', 'Queue it as a scheduled PRD via /gamma when ready.'),
  makeSkill('gamma', 'Once queued, invoke delta to finish the job.'),
  makeSkill('delta', 'This skill stands alone and only mentions delta itself, nothing else.'),
]

describe('detectSkillEdges', () => {
  it('detects a backticked reference', () => {
    const edges = detectSkillEdges(SKILLS)
    expect(edges).toContainEqual({ from: 'alpha', to: 'beta' })
  })

  it('detects a leading-slash reference', () => {
    const edges = detectSkillEdges(SKILLS)
    expect(edges).toContainEqual({ from: 'beta', to: 'gamma' })
  })

  it('detects a bare whole-word reference (id length >= 4)', () => {
    const edges = detectSkillEdges(SKILLS)
    expect(edges).toContainEqual({ from: 'gamma', to: 'delta' })
  })

  it('produces no outgoing edges when a skill references none of the others', () => {
    const edges = detectSkillEdges(SKILLS)
    expect(edges.filter((e) => e.from === 'delta')).toEqual([])
  })

  it('dedupes multiple mentions of the same target into a single edge', () => {
    const edges = detectSkillEdges(SKILLS)
    expect(edges.filter((e) => e.from === 'alpha' && e.to === 'beta')).toHaveLength(1)
  })

  it('never produces a self-edge', () => {
    const edges = detectSkillEdges(SKILLS)
    expect(edges.filter((e) => e.from === e.to)).toEqual([])
  })
})
