/**
 * Skill enable/disable frontmatter mutation.
 *
 * The Skills tab toggles `disable-model-invocation` in SKILL.md to turn a skill
 * off — the real CLI flag. A regression here either fails to disable a skill or
 * corrupts the surrounding frontmatter, so this locks in the surgical-edit
 * invariant: only the one key line is touched; everything else round-trips.
 *
 * The 3a Skills detail edits the body alone (splitSkillDoc/joinSkillDoc) and the
 * description as a field (setSkillDescription/readSkillDescription); those must
 * round-trip byte-for-byte — CRLF included — and leave every other key alone.
 *
 * Source: src/renderer/lib/skillFrontmatter.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  readSkillDisabled,
  setSkillDisabled,
  parseSkillMeta,
  splitSkillDoc,
  joinSkillDoc,
  setSkillDescription,
  readSkillDescription,
} from '../../src/renderer/lib/skillFrontmatter'

const SKILL = `---
name: my-skill
description: does a thing
allowed-tools: Read, Grep
---

# My Skill

Body stays put.
`

describe('readSkillDisabled', () => {
  it('is false when the key is absent', () => {
    expect(readSkillDisabled(SKILL)).toBe(false)
  })
  it('is true only when explicitly enabled', () => {
    expect(readSkillDisabled(SKILL.replace('name: my-skill', 'name: my-skill\ndisable-model-invocation: true'))).toBe(true)
    expect(readSkillDisabled(SKILL.replace('name: my-skill', 'name: my-skill\ndisable-model-invocation: false'))).toBe(false)
  })
  it('is false when there is no frontmatter', () => {
    expect(readSkillDisabled('# Just a body')).toBe(false)
  })
})

describe('setSkillDisabled', () => {
  it('adds the flag, preserving every other line', () => {
    const out = setSkillDisabled(SKILL, true)
    expect(readSkillDisabled(out)).toBe(true)
    expect(out).toContain('name: my-skill')
    expect(out).toContain('description: does a thing')
    expect(out).toContain('allowed-tools: Read, Grep')
    expect(out).toContain('Body stays put.')
  })

  it('removes the flag when re-enabled (absence = default on)', () => {
    const disabled = setSkillDisabled(SKILL, true)
    const reenabled = setSkillDisabled(disabled, false)
    expect(readSkillDisabled(reenabled)).toBe(false)
    expect(reenabled).not.toContain('disable-model-invocation')
    expect(reenabled).toContain('allowed-tools: Read, Grep')
  })

  it('is a no-op when already in the requested state', () => {
    expect(setSkillDisabled(SKILL, false)).toBe(SKILL)
    const disabled = setSkillDisabled(SKILL, true)
    expect(setSkillDisabled(disabled, true)).toBe(disabled)
  })

  it('synthesizes frontmatter when none exists and disabling', () => {
    const out = setSkillDisabled('# Bare body', true)
    expect(out.startsWith('---\ndisable-model-invocation: true\n---\n')).toBe(true)
    expect(readSkillDisabled(out)).toBe(true)
    expect(out).toContain('# Bare body')
  })

  it('toggles an existing false flag to true in place', () => {
    const withFalse = SKILL.replace('name: my-skill', 'name: my-skill\ndisable-model-invocation: false')
    const out = setSkillDisabled(withFalse, true)
    expect(readSkillDisabled(out)).toBe(true)
    // Only one occurrence — replaced in place, not appended.
    expect(out.match(/disable-model-invocation/g)?.length).toBe(1)
  })
})

describe('parseSkillMeta', () => {
  it('parses name/description from a simple flat frontmatter block', () => {
    const meta = parseSkillMeta(SKILL)
    expect(meta.name).toBe('my-skill')
    expect(meta.description).toBe('does a thing')
  })

  it('returns nulls for a bare body with no frontmatter', () => {
    const meta = parseSkillMeta('# Just a body')
    expect(meta).toEqual({ name: null, description: null, body: '# Just a body' })
  })

  it('folds a multi-line description: >- block into one space-joined string', () => {
    const folded = `---
name: folded-skill
description: >-
  first line of the description
  second line continues it
allowed-tools: Read
---

# Folded Skill
`
    const meta = parseSkillMeta(folded)
    expect(meta.name).toBe('folded-skill')
    expect(meta.description).toBe('first line of the description second line continues it')
  })

  it('never includes the frontmatter block in body', () => {
    const meta = parseSkillMeta(SKILL)
    expect(meta.body).not.toContain('name: my-skill')
    expect(meta.body).not.toContain('description: does a thing')
    expect(meta.body).toContain('Body stays put.')
  })
})

const SKILL_CRLF = SKILL.replace(/\n/g, '\r\n')
const NO_DESCRIPTION = SKILL.replace('description: does a thing\n', '')
const FOLDED = `---
name: folded-skill
description: >-
  first line of the description
  second line continues it
allowed-tools: Read
---

# Folded Skill
`

/** Every shape the Skills detail can be handed — the split must round-trip each one exactly. */
const DOCS: Record<string, string> = {
  'frontmatter + body': SKILL,
  'frontmatter + body, CRLF': SKILL_CRLF,
  'folded description block': FOLDED,
  'no frontmatter': '# Just a body\n\nText.\n',
  'no frontmatter, CRLF': '# Just a body\r\n\r\nText.\r\n',
  'empty file': '',
  'frontmatter only, no final newline': '---\nname: x\n---',
  'frontmatter only, CRLF, no final newline': '---\r\nname: x\r\n---',
  'empty frontmatter block': '---\n\n---\nbody',
  'mixed line endings': '---\r\nname: x\ndescription: y\r\n---\nbody\r\n',
  'unterminated frontmatter': '---\nname: x\nno closing fence\n',
  'closing fence with trailing spaces': '---\nname: x\n---  \nbody\n',
  'leading blank line (not frontmatter)': '\n---\nname: x\n---\nbody',
}

describe('splitSkillDoc / joinSkillDoc', () => {
  it('splits off the frontmatter block verbatim, fences included', () => {
    expect(splitSkillDoc(SKILL)).toEqual({
      frontmatter: '---\nname: my-skill\ndescription: does a thing\nallowed-tools: Read, Grep\n---\n',
      body: '\n# My Skill\n\nBody stays put.\n',
    })
  })

  it('keeps CRLF line breaks on both sides of the split', () => {
    expect(splitSkillDoc(SKILL_CRLF)).toEqual({
      frontmatter: '---\r\nname: my-skill\r\ndescription: does a thing\r\nallowed-tools: Read, Grep\r\n---\r\n',
      body: '\r\n# My Skill\r\n\r\nBody stays put.\r\n',
    })
  })

  it('returns a null frontmatter and the whole text as body when there is none', () => {
    expect(splitSkillDoc('# Just a body')).toEqual({ frontmatter: null, body: '# Just a body' })
    expect(splitSkillDoc('')).toEqual({ frontmatter: null, body: '' })
  })

  it('finds the same block parseSkillMeta reads', () => {
    for (const doc of [SKILL, SKILL_CRLF, FOLDED, '# Just a body', '---\n\n---\nbody', '---\nname: x\n---']) {
      expect(splitSkillDoc(doc).body).toBe(parseSkillMeta(doc).body)
    }
  })

  it.each(Object.entries(DOCS))('round-trips byte-for-byte: %s', (_label, doc) => {
    const { frontmatter, body } = splitSkillDoc(doc)
    expect(joinSkillDoc(frontmatter, body)).toBe(doc)
  })

  it('joins an edited body under the untouched frontmatter', () => {
    const { frontmatter } = splitSkillDoc(SKILL_CRLF)
    expect(joinSkillDoc(frontmatter, '# New body\r\n')).toBe(`${frontmatter}# New body\r\n`)
    expect(joinSkillDoc(null, '# Bare')).toBe('# Bare')
  })

  it('keeps the closing fence on its own line when a body is typed into a frontmatter-only file', () => {
    expect(joinSkillDoc(splitSkillDoc('---\nname: x\n---').frontmatter, '# Hi')).toBe('---\nname: x\n---\n# Hi')
    expect(joinSkillDoc(splitSkillDoc('---\r\nname: x\r\n---').frontmatter, '# Hi')).toBe('---\r\nname: x\r\n---\r\n# Hi')
  })
})

describe('setSkillDescription', () => {
  it('replaces the description in place, every other line verbatim', () => {
    expect(setSkillDescription(SKILL, 'does a new thing')).toBe(
      SKILL.replace('description: does a thing', 'description: does a new thing'),
    )
  })

  it('touches only the description line — comments, spacing and key order survive', () => {
    const messy = `---
# leading comment
name:   spaced-out
allowed-tools: [Read, Grep]   # inline comment
description: 'old'

model: sonnet
---
Body.
`
    expect(setSkillDescription(messy, 'new')).toBe(messy.replace("description: 'old'", 'description: new'))
  })

  it('replaces a multi-line block scalar whole, keeping the blank line before the next key', () => {
    expect(setSkillDescription(FOLDED, 'short now')).toBe(
      FOLDED.replace(
        'description: >-\n  first line of the description\n  second line continues it\n',
        'description: short now\n',
      ),
    )
    const literal = '---\ndescription: |\n  para one\n\n  para two\n\nname: x\n---\nbody'
    expect(setSkillDescription(literal, 'one line')).toBe('---\ndescription: one line\n\nname: x\n---\nbody')
  })

  it('inserts a missing description right after name', () => {
    expect(setSkillDescription(NO_DESCRIPTION, 'does a thing')).toBe(SKILL)
  })

  it('appends a missing description when there is no name (command files)', () => {
    const command = '---\nallowed-tools: Bash(git status:*)\nargument-hint: [message]\n---\nCommit it.\n'
    expect(setSkillDescription(command, 'Create a commit')).toBe(
      '---\nallowed-tools: Bash(git status:*)\nargument-hint: [message]\ndescription: Create a commit\n---\nCommit it.\n',
    )
  })

  it.each([
    ['Keywords: alpha, beta', 'description: "Keywords: alpha, beta"'],
    ['Handles C# files', 'description: "Handles C# files"'],
    [' leading space', 'description: " leading space"'],
    ['trailing space ', 'description: "trailing space "'],
    ['Say "hi": then go\\home', 'description: "Say \\"hi\\": then go\\\\home"'],
    ["plain words, it's fine", "description: plain words, it's fine"],
  ])('double-quotes the value only when it needs it: %j', (value, line) => {
    expect(setSkillDescription(SKILL, value)).toBe(SKILL.replace('description: does a thing', line))
  })

  it.each([
    ['', 'description: ""'],
    ['true', 'description: "true"'],
    ['42', 'description: "42"'],
    ['[beta] tool', 'description: "[beta] tool"'],
    ['line one\nline two', 'description: "line one\\nline two"'],
  ])('also quotes values a plain YAML scalar would not keep as that string: %j', (value, line) => {
    expect(setSkillDescription(SKILL, value)).toBe(SKILL.replace('description: does a thing', line))
  })

  it('creates a frontmatter block when none exists, leaving the body byte-identical', () => {
    expect(setSkillDescription('# Bare body\n', 'Does X')).toBe('---\ndescription: Does X\n---\n# Bare body\n')
    expect(setSkillDescription('# Bare\r\nbody\r\n', 'a: b')).toBe('---\r\ndescription: "a: b"\r\n---\r\n# Bare\r\nbody\r\n')
    expect(setSkillDescription('', 'Does X')).toBe('---\ndescription: Does X\n---\n')
  })

  it('keeps CRLF line breaks when replacing or inserting', () => {
    expect(setSkillDescription(SKILL_CRLF, 'new: value')).toBe(
      SKILL_CRLF.replace('description: does a thing', 'description: "new: value"'),
    )
    expect(setSkillDescription(NO_DESCRIPTION.replace(/\n/g, '\r\n'), 'does a thing')).toBe(SKILL_CRLF)
  })

  it.each(Object.entries(DOCS))('never moves or edits the body: %s', (_label, doc) => {
    expect(splitSkillDoc(setSkillDescription(doc, 'New: value')).body).toBe(splitSkillDoc(doc).body)
  })

  it('is idempotent, and a no-op when the value is already written that way', () => {
    const once = setSkillDescription(SKILL, 'Keywords: a, b')
    expect(setSkillDescription(once, 'Keywords: a, b')).toBe(once)
    expect(setSkillDescription(SKILL, 'does a thing')).toBe(SKILL)
  })

  it('collapses duplicate top-level description keys into one', () => {
    expect(setSkillDescription('---\ndescription: one\nname: x\ndescription: two\n---\nbody', 'new')).toBe(
      '---\ndescription: new\nname: x\n---\nbody',
    )
  })

  it('leaves a nested description key alone and sets the top-level one', () => {
    expect(setSkillDescription('---\nname: x\nmetadata:\n  description: nested\n---\nbody', 'top')).toBe(
      '---\nname: x\ndescription: top\nmetadata:\n  description: nested\n---\nbody',
    )
  })

  it('stays readable by parseSkillMeta when no escaping is needed', () => {
    expect(parseSkillMeta(setSkillDescription(SKILL, 'Keywords: a, b')).description).toBe('Keywords: a, b')
    expect(parseSkillMeta(setSkillDescription('# Bare\n', 'Does X')).description).toBe('Does X')
  })
})

describe('readSkillDescription', () => {
  it('is null without frontmatter or without the key', () => {
    expect(readSkillDescription('# Just a body')).toBeNull()
    expect(readSkillDescription(NO_DESCRIPTION)).toBeNull()
  })

  it('decodes plain, quoted, commented and folded values', () => {
    expect(readSkillDescription(SKILL)).toBe('does a thing')
    expect(readSkillDescription(FOLDED)).toBe('first line of the description second line continues it')
    expect(readSkillDescription("---\ndescription: 'it''s: quoted'\n---\n")).toBe("it's: quoted")
    expect(readSkillDescription('---\ndescription: "say \\"hi\\": \\\\ done" # note\n---\n')).toBe('say "hi": \\ done')
    expect(readSkillDescription('---\ndescription: does X # todo\n---\n')).toBe('does X')
  })

  it.each([
    'plain words',
    'Keywords: alpha, beta',
    'Use when the user says "/develop": build it',
    'back\\slash # and hash',
    '  padded  ',
    '',
    'true',
    '"already quoted"',
    'line one\nline two',
  ])('reads back exactly what setSkillDescription wrote: %j', (value) => {
    expect(readSkillDescription(setSkillDescription(SKILL, value))).toBe(value)
    expect(readSkillDescription(setSkillDescription(SKILL_CRLF, value))).toBe(value)
    expect(readSkillDescription(setSkillDescription('# Bare body\n', value))).toBe(value)
  })
})
