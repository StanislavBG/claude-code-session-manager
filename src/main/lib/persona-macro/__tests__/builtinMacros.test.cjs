/**
 * builtinMacros.test.cjs — the seeded Demo Video macro and its bundled persona.
 *
 * Run: timeout 300 npx vitest run src/main/lib/persona-macro/__tests__/builtinMacros.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { BUILTIN_MACROS } = require('../builtinMacros.cjs');

const personaPath = path.join(__dirname, '..', '..', '..', '..', 'seed', 'agents', 'demo-video-builder.md');

function frontmatter(doc) {
  const m = doc.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  for (const line of (m ? m[1] : '').split('\n')) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

test('builtin demo-video macro is v12 with the character + styles + length prompt', () => {
  const macro = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  expect(macro.builtinVersion).toBe(12);
  expect(macro.priorPrompts).toHaveLength(11);
  expect(macro.builtinVersion).toBe(macro.priorPrompts.length + 1);
  for (const t of ['project_video_write', 'Video kind:', 'Video target:', 'Entry id']) expect(macro.prompt).toContain(t);
  expect(macro.prompt).toContain('Video length: 60');
  expect(macro.prompt).not.toContain('30-second');
  // the opening follows the Character switch instead of always promising a mascot
  expect(macro.prompt.startsWith('Generate a cute animated JavaScript video with an original mascot character unless a Character: off line says otherwise')).toBe(true);
  expect(macro.prompt).not.toContain('Generate a character and');
  for (const style of ['Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography']) {
    expect(macro.prompt).toContain(style);
  }
  expect(macro.prompt).toContain('Video style: <name>');
    expect(macro.prompt).toContain('htmlPath');
  expect(macro.prompt).toContain('Kokoro');
});

test('demo-video-builder persona is opus / max / seedVersion 9 or later', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  const fm = frontmatter(raw);
  expect(fm.model).toBe('opus');
  expect(fm.effort).toBe('max');
  expect(Number.isInteger(Number(fm.seedVersion))).toBe(true);
  expect(Number(fm.seedVersion) >= 9).toBe(true);
});

function personaBody() {
  return fs.readFileSync(personaPath, 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

test('demo-video-builder persona sections are balanced and never nested', () => {
  const body = personaBody();
  let open = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^<(\/?)([a-z_]+)>$/);
    if (!m) continue;
    if (m[1] === '') {
      expect(open).toBeNull();
      open = m[2];
    } else {
      expect(open).toBe(m[2]);
      open = null;
    }
  }
  expect(open).toBeNull();
  expect(body).not.toMatch(/`<[a-z_]+>$/m);
});

test('demo-video-builder persona keeps its output contract rules', () => {
  const body = personaBody().toLowerCase();
  for (const needle of ['XMLHttpRequest', 'system font stack', 'prefers-reduced-motion', 'Under 2 MB total', 'Never retype the base64 audio']) {
    expect(body).toContain(needle.toLowerCase());
  }
});

test('plain language and close rules sit above the intake cut', () => {
  const { AGENT_BODY_CHAR_CAP } = require('../../claude/agentModelResolve.cjs');
  const head = personaBody().slice(0, AGENT_BODY_CHAR_CAP);
  expect(head).toContain('</audience_and_language>');
  expect(head).toContain('</length_and_pacing>');
  expect(head).toContain('</call_to_action>');
  expect(head).toContain('truncation notice');
});

test('persona is length-aware, slower, and has the whiteboard palette', () => {
  const body = personaBody();
  for (const needle of ['Video length: 60', 'content="D"', 'duration: D', 'np.zeros(D * sr', 'at least 5 s', 'at least 1.0 s', 'at least 6 marker-drawn elements', '#D62828', '#E4471C', '#F77F00']) {
    expect(body).toContain(needle);
  }
  for (const gone of ['content="30"', 'duration: 30', 'np.zeros(30 * sr', 'a 30-second animated demo']) {
    expect(body).not.toContain(gone);
  }
});

test('persona absorbs the marketing-video rules and saves with project_video_write', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  const body = personaBody();
  expect(raw).toContain('mcp__session-manager-scheduler__project_video_write');
  expect(raw).toContain('mcp__session-manager-scheduler__project_character_write');
  for (const needle of ['project_video_write', 'demo-video-kit', 'Video kind', 'Entry id', '-14 LUFS', '1.2x', '_character']) {
    expect(body).toContain(needle);
  }
});

test('script_first no longer closes on a command', () => {
  const body = personaBody();
  const section = body.slice(body.indexOf('<script_first>'), body.indexOf('</script_first>'));
  expect(section).not.toContain('get-started');
  expect(body).not.toContain('instead of paraphrasing');
});

test('soundtrack comes from the kit mix, never a hand-written loudness filter', () => {
  const body = personaBody();
  expect(body).toContain('sound.cjs');
  expect(body).toContain("open('mix.mp3', 'rb')");
  expect(body).not.toContain('loudnorm=');
  expect(body).not.toContain("'-af', LOUDNESS");
});

test('the close is never a shell command, and the scene outline lives in one place', () => {
  const body = personaBody();
  const cta = body.slice(body.indexOf('<call_to_action>'), body.indexOf('</call_to_action>'));
  expect(cta).not.toContain('get-started command');
  const board = body.slice(body.indexOf('<storyboard>'), body.indexOf('</storyboard>'));
  expect(board).toContain('<video_structure>');
});

test('built-in macros declare a frozen background job', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const home = BUILTIN_MACROS.find((m) => m.id === 'builtin-project-home');
  expect(demo.job).toEqual({
    estimateMinutes: 60,
    entryKind: 'video',
    artifactPaths: ['session-manager-operations/project-pages/videos/{id}/index.html'],
    reviewable: true,
  });
  for (const m of BUILTIN_MACROS) if (m.id !== 'builtin-demo-video') expect(m.job?.reviewable).toBeUndefined();
  expect(home.job).toEqual({
    estimateMinutes: 20,
    entryKind: 'knowledge',
    artifactPaths: ['session-manager-operations/project-pages/knowledge/{id}/index.html'],
  });
  for (const m of [demo, home]) {
    expect(Object.isFrozen(m.job)).toBe(true);
    expect(Object.isFrozen(m.job.artifactPaths)).toBe(true);
  }
  expect(home.builtinVersion).toBe(3);
  expect(home.priorPrompts).toHaveLength(2);
  for (const m of [demo, home]) expect(m.builtinVersion).toBe(m.priorPrompts.length + 1);
  expect(home.prompt).toContain('project_page_write');
  expect(home.prompt).toContain("'Page:");
  expect(home.prompt).toContain("'Entry id'");
  expect(demo.builtinVersion).toBe(12);
  expect(demo.priorPrompts).toHaveLength(11);
});

// The Project Home Generate composer always sends these lines (design-mocks/project-home-v2/DESIGN_SPEC.md
// "Prompt lines"); macroJobDispatch.cjs appends them as "Additional instructions: ..." plus an "Entry id" line.
const sha256 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
// A bump only adds: every sentence and ';' clause of the previous prompt survives verbatim.
const priorClauses = (s) => s.split(/(?<=[.;])\s+/).map((c) => c.replace(/[.;]$/, ''));

test('Project Home v3 honours the Audience, Length and Read from lines and keeps every v2 clause', () => {
  const home = BUILTIN_MACROS.find((m) => m.id === 'builtin-project-home');
  expect(home.builtinVersion).toBe(3);
  expect(home.priorPrompts).toHaveLength(2);
  // the last prior prompt is the shipped v2 prompt, byte for byte
  expect(sha256(home.priorPrompts.at(-1))).toBe('72e5d32a75e98fb9944372d6f8add27dd277ced7e62377066d5d1bc99e7ffd89');
  for (const clause of priorClauses(home.priorPrompts.at(-1))) expect(home.prompt).toContain(clause);
  for (const t of ['Audience:', 'Length:', 'Read from:', "'Page: Overview'", 'additional instructions', "'Entry id'"]) {
    expect(home.prompt).toContain(t);
  }
  for (const v of ['Newcomers', 'Users', 'Contributors', 'Brief', 'Standard', 'In-depth', 'README & docs', 'Source tree', 'Git log', 'nothing selected']) {
    expect(home.prompt).toContain(v);
  }
});

test('Demo Video v7+ honours Video kind/style/length and Character on|off lines and keeps every v6 clause', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  expect(demo.builtinVersion).toBe(12);
  expect(demo.priorPrompts).toHaveLength(11);
  // priorPrompts[5] is the shipped v6 prompt, byte for byte; v7 kept every v6 clause
  expect(sha256(demo.priorPrompts[5])).toBe('5b6696fc59a315f04158e191b48b8cdf375b5deaafd87f9d99fed523661ccc49');
  // v12 replaced only the Kokoro narration sentence with the kit speak path (see the v12 test)
  for (const clause of priorClauses(demo.priorPrompts[5]).slice(1)) {
    if (clause.startsWith('Narrate with Kokoro (kokoro-onnx)')) continue;
    expect(demo.prompt).toContain(clause);
  }
  for (const t of ['Character: off', 'Video style: Auto', "'Video kind: Project demo'", "'Video length: 30'", "'Character: on'", 'type-led', 'meta.character', 'additional instructions', "'Entry id'"]) {
    expect(demo.prompt).toContain(t);
  }
});

test('Demo Video v8 only rewrites the first sentence of the shipped v7 prompt', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const v7 = demo.priorPrompts[6];
  const v8 = demo.priorPrompts[7];
  // priorPrompts[6] is the shipped v7 prompt, byte for byte
  expect(sha256(v7)).toBe('c909ac2ffb96ba54f72cd4a7f08f5ea98f26480cdb5c47640debc7d1807c224f');
  const v7Opening = 'Generate a character and cute animated JavaScript video';
  const v8Opening = 'Generate a cute animated JavaScript video with an original mascot character unless a Character: off line says otherwise,';
  expect(v7.startsWith(v7Opening)).toBe(true);
  expect(v8.startsWith(v8Opening)).toBe(true);
  // everything after the opening words is unchanged
  expect(v8.slice(v8Opening.length)).toBe(v7.slice(v7Opening.length));
});

const V9_INSERT = "A Blog post or Feature kind with no 'Video target:' line, or with a target you cannot find in the repository or read at its URL, also means that same whole-project demo: never pick a post or feature yourself, say so in your report, and save the kind as project-demo. When the target makes claims about how this project works, check each one against the code: drop a claim the code contradicts or attribute it to the post, and never narrate it as fact about the project.";

test('Demo Video v9 adds the no-target and target-claims rules and keeps every v8 clause', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const v8 = demo.priorPrompts[7];
  const v9 = demo.priorPrompts[8];
  // priorPrompts[7] is the shipped v8 prompt, byte for byte
  expect(sha256(v8)).toBe('089a1e9e8903f232ef1881cfaf556d334cef19169391275f0c0d88eeab1d6b7d');
  for (const t of ['never pick a post or feature yourself', 'save the kind as project-demo', 'check each one against the code']) {
    expect(v9).toContain(t);
  }
  for (const clause of priorClauses(v8)) expect(v9).toContain(clause);
  // v9 is v8 with exactly the inserted text after the Project demo sentence
  const anchor = "A 'Video kind: Project demo' line means that same whole-project demo.";
  expect(v8.split(anchor)).toHaveLength(2);
  expect(v9).toBe(v8.replace(anchor, `${anchor} ${V9_INSERT}`));
});

test('Demo Video v10 names the TikTok and Marketing kinds and the project persona voice, and keeps every v9 clause', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const v9 = demo.priorPrompts[8];
  const v10 = demo.priorPrompts[9];
  // priorPrompts[8] is the shipped v9 prompt, byte for byte
  expect(sha256(v9)).toBe('a6cb8cbd45475025db8aec5248b74d66afefde22f57c933042d5ac53a26b1989');
  for (const clause of priorClauses(v9)) expect(v10).toContain(clause);
  for (const t of ["'Video kind: TikTok'", "'Video kind: Marketing'", 'kind-tiktok.md', 'kind-marketing.md', 'kind tiktok', 'kind marketing',
    'MP4', 'poster', 'post caption', 'never falls back to a Project demo', "saved project persona's voice", 'no fallback', 'a failure fails the run', 'Kokoro']) {
    expect(v10).toContain(t);
  }
});

const V11_INSERT = "When the saved persona has a cast, every line is spoken in its own speaker's voice, the host's or that cast member's, with the same no-fallback rule, and a cast member with no voice never speaks.";

test('Demo Video v11 speaks every line in its own speaker\'s voice when the persona has a cast, and keeps every v10 clause', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const v10 = demo.priorPrompts[9];
  // priorPrompts[9] is the shipped v10 prompt, byte for byte
  expect(sha256(v10)).toBe('e144c7cc0cce7a719c0b6c0a9356b711e96c0455e5d19dcb2543ea61d66d9fa2');
  const v11 = demo.priorPrompts[10];
  for (const clause of priorClauses(v10)) expect(v11).toContain(clause);
  // v11 is v10 with exactly the inserted sentence after the Kokoro persona voice clause
  const anchor = 'a Kokoro persona voice uses its own voice id.';
  expect(v10.split(anchor)).toHaveLength(2);
  expect(v11).toBe(v10.replace(anchor, `${anchor} ${V11_INSERT}`));
});

const V11_KOKORO = 'Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona only when there is no saved persona.';
const V12_SPEAK = "Speak every narration line through the kit with node <kit>/character.cjs speak spec.json, never a hand-written TTS script: a 'Voice: <id>' line in the additional instructions picks the voice first (as spec.voice), then the saved persona's voice, then, only when there is no saved persona, the kit default natural female (af_heart) or male (am_michael) voice per the audio policy in the persona.";

test('Demo Video v12 narrates through the kit speak path with the Voice line, replacing only the Kokoro sentence of v11', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const v11 = demo.priorPrompts[10];
  // priorPrompts[10] is the shipped v11 prompt, byte for byte
  expect(sha256(v11)).toBe('790cb095c2a2e14fbc6752c53088f9f2a9dbaa6a069233ef4e415c6e8df5370c');
  expect(demo.priorPrompts.at(-1)).toBe(v11);
  expect(v11.split(V11_KOKORO)).toHaveLength(2);
  expect(demo.prompt).toBe(v11.replace(V11_KOKORO, V12_SPEAK));
  expect(demo.prompt).not.toContain('Narrate with Kokoro (kokoro-onnx)');
  for (const t of ['node <kit>/character.cjs speak spec.json', "'Voice: <id>'", 'spec.voice', 'af_heart', 'am_michael', 'never a hand-written TTS script']) {
    expect(demo.prompt).toContain(t);
  }
});

test('every built-in macro keeps builtinVersion === priorPrompts.length + 1', () => {
  for (const m of BUILTIN_MACROS) expect(m.builtinVersion).toBe(m.priorPrompts.length + 1);
});

test('builtin-review-md-network is a job-less project-home macro with scope + mode inputs', () => {
  const crypto = require('node:crypto');
  const { MacroSchema, renderMacroPrompt, defaultMacroValues, ensureBuiltins } = require('../macroLibrary.cjs');
  const sha = (id) => crypto.createHash('sha256').update(JSON.stringify(BUILTIN_MACROS.find((m) => m.id === id))).digest('hex');
  expect(sha('builtin-project-home')).toBe('86684a527edca103fb7ae9612d412b86d5d4f546b122e6cc900fa9e6d2492113');
  expect(sha('builtin-demo-video')).toBe('320452c89bad47dab159680a4d3c877018cbe26c6de64ecaab891d3a945e46d3');
  expect(sha('builtin-review-md-network')).toBe('bd1db93109f81463704d5bae0656a25219a97fda73a22ca264e8a6018422ecbf');

  const b = BUILTIN_MACROS.find((m) => m.id === 'builtin-review-md-network');
  expect(b).toBeTruthy();
  expect(Object.isFrozen(b)).toBe(true);
  expect(b.label).toBe('Review MD network');
  expect(b.agentName).toBe('architect');
  expect(b.tag).toBe('discussion');
  expect(b.surface).toBe('project-home');
  expect(b.projects).toEqual(['*']);
  expect(b.builtinVersion).toBe(2);
  expect(b.priorPrompts).toEqual([
    "Use the session-manager-dev:maintaining-md-network skill to review this project's markdown network. Scope: {{scope}}. Mode: {{mode}}.",
  ]);
  expect(b.supersedes).toEqual(['review-md-network-d38ffd']);
  expect('job' in b).toBe(false);
  expect(b.inputs).toEqual([
    { name: 'scope', label: 'Scope', default: 'the whole project', required: true },
    { name: 'mode', label: 'Mode', options: ['Full review', 'Drift check', 'Weekly consolidation'], default: 'Full review', required: true },
  ]);
  expect(b.prompt).toBe(
    "Use the session-manager-dev:maintaining-md-network skill to review this project's markdown network. Scope: {{scope}}. Mode: {{mode}}. Modes: Full review, Drift check, Weekly consolidation.",
  );

  const stamp = '2026-01-01T00:00:00.000Z';
  const parsed = MacroSchema.safeParse({ ...b, builtin: true, createdAt: stamp, updatedAt: stamp });
  expect(parsed.success).toBe(true);

  const r = renderMacroPrompt(b.prompt, b.inputs, defaultMacroValues(b.inputs));
  expect(r.ok).toBe(true);
  expect(r.prompt).toContain('Scope: the whole project.');
  expect(r.prompt).toContain('Mode: Full review.');

  const custom = {
    id: 'review-md-network-d38ffd', label: 'Review MD network', agentName: 'architect', tag: 'discussion',
    prompt: 'x', projects: ['*'], surface: 'project-home', createdAt: stamp, updatedAt: stamp,
  };
  const out = ensureBuiltins([custom], [b]);
  expect(out.retired).toEqual(['review-md-network-d38ffd']);
  const seeded = out.macros.find((m) => m.id === 'builtin-review-md-network');
  expect(seeded.inputs).toEqual(b.inputs);
  expect(out.macros.find((m) => m.id === 'review-md-network-d38ffd')).toBeUndefined();
});

test('builtin-competitor-matrix is a v1 project-home background job run by competitive-analyst', () => {
  expect(BUILTIN_MACROS.map((m) => m.id)).toEqual([
    'builtin-project-home', 'builtin-demo-video', 'builtin-review-md-network', 'builtin-competitor-matrix',
    'builtin-cpu-audit',
  ]);
  const c = BUILTIN_MACROS.find((m) => m.id === 'builtin-competitor-matrix');
  expect(Object.isFrozen(c)).toBe(true);
  const { prompt, ...rest } = c;
  expect(rest).toEqual({
    id: 'builtin-competitor-matrix', label: 'Competitor matrix', agentName: 'competitive-analyst',
    tag: 'project-home-builder', surface: 'project-home', projects: ['*'], builtinVersion: 1, priorPrompts: [],
    job: { estimateMinutes: 90, artifactPaths: ['session-manager-operations/project-pages/matrix/matrix.json'] },
  });
  expect('entryKind' in c.job).toBe(false);
  expect('inputs' in c).toBe(false);
  expect(Object.isFrozen(c.job)).toBe(true);
  expect(Object.isFrozen(c.job.artifactPaths)).toBe(true);
  expect(c.builtinVersion).toBe(c.priorPrompts.length + 1);
  for (const t of [
    "'Competitors:'", 'up to 4', 'semicolon-separated', "'auto'", 'saved matrix', '4 auto picks',
    'project_matrix_read', 'competitive-researcher', 'Haiku', 'official announcements', 'dev blogs',
    'changelogs', 'docs', 'rave about', 'ask for', "this repository's real features", 'groups',
    'sessionGoal', 'one project_matrix_write call',
  ]) expect(prompt).toContain(t);
  expect(prompt).not.toContain('{{');

  const { MacroSchema } = require('../macroLibrary.cjs');
  const stamp = '2026-01-01T00:00:00.000Z';
  expect(MacroSchema.safeParse({ ...c, builtin: true, createdAt: stamp, updatedAt: stamp }).success).toBe(true);
});

test('builtin-cpu-audit is a job-less project-home architect macro with scope + scenario inputs', () => {
  const crypto = require('node:crypto');
  const { MacroSchema, renderMacroPrompt } = require('../macroLibrary.cjs');
  const b = BUILTIN_MACROS.find((m) => m.id === 'builtin-cpu-audit');
  expect(b).toBeTruthy();
  expect(Object.isFrozen(b)).toBe(true);
  expect(Object.isFrozen(b.inputs)).toBe(true);
  for (const i of b.inputs) expect(Object.isFrozen(i)).toBe(true);
  expect(Object.isFrozen(b.supersedes)).toBe(true);
  expect(Object.isFrozen(b.priorPrompts)).toBe(true);
  const { prompt, ...rest } = b;
  expect(rest).toEqual({
    id: 'builtin-cpu-audit', label: 'CPU audit & fixes', agentName: 'architect', tag: 'feature',
    surface: 'project-home', projects: ['*'], builtinVersion: 1, priorPrompts: [],
    supersedes: ['cpu-audit-fixes-8bd5d1'],
    inputs: [
      { name: 'scope', label: 'Scope', default: 'the whole project', required: true },
      { name: 'scenario', label: 'Run scenario', default: 'idle, then its typical everyday load', required: true },
    ],
  });
  expect('job' in b).toBe(false);
  expect(b.builtinVersion).toBe(b.priorPrompts.length + 1);

  expect(crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'))
    .toBe('7e9ed14bb613ed9d290b28d3155bcd02c57bb76811275869b319a5978afa1427');
  expect((prompt.match(/\n/g) || []).length).toBe(12);
  for (const t of ['{{scope}}', '{{scenario}}', '/develop']) expect(prompt).toContain(t);

  const stamp = '2026-01-01T00:00:00.000Z';
  expect(MacroSchema.safeParse({ ...b, builtin: true, createdAt: stamp, updatedAt: stamp }).success).toBe(true);
  const r = renderMacroPrompt(prompt, b.inputs, {});
  expect(r.ok).toBe(true);
  expect(r.prompt).toContain('Scope: the whole project.');
  expect(r.prompt).toContain('Run scenario to measure: idle, then its typical everyday load.');
  expect(r.prompt).not.toContain('{{');
});

function personaSection(tag) {
  const body = personaBody();
  return body.slice(body.indexOf(`<${tag}>`), body.indexOf(`</${tag}>`));
}

test('persona v13: no target or an unfound target means a Project demo, never a guessed post', () => {
  const fm = frontmatter(fs.readFileSync(personaPath, 'utf8'));
  expect(Number(fm.seedVersion) >= 13).toBe(true);
  const kt = personaSection('kind_and_target');
  for (const needle of ['no `Video target:` line', 'cannot find in the repository or read at its URL', 'whatever `Video kind:` says', 'never pick a post or feature yourself', 'report', '`project-demo`', 'no `meta.target`', 'Entry id:']) {
    expect(kt).toContain(needle);
  }
});

test('persona v13: a post or feature text is a claim, checked against the source tree', () => {
  const kt = personaSection('kind_and_target');
  for (const needle of ['a claim, not a source of truth', 'against the source tree', 'the post says', 'never narrate it as fact about the project']) {
    expect(kt).toContain(needle);
  }
});

test('persona v13: step 8 lists exactly the meta keys the save route accepts', () => {
  const proc = personaSection('process');
  const step8 = proc.slice(proc.indexOf('\n8. '), proc.indexOf('\n9. '));
  for (const key of ['`title`', '`kind`', '`target`', '`style`', '`lengthS`', '`character`', '`sources`', '`report`', '`macroVersion`', '`seedVersion`', '`model`', '`effort`', '{claim, source, ref}', 'verbatim span', 'rejected']) {
    expect(step8).toContain(key);
  }
  expect(step8).not.toContain('`audience`');
  expect(step8).toContain('`post`');
  expect(step8).not.toContain('the Kind and Target lines');
});

test('persona and the builtin-demo-video prompt share the no-guess rule', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  expect(demo.prompt).toContain('never pick a post or feature yourself');
  expect(personaBody()).toContain('never pick a post or feature yourself');
});

test('persona v15: the project persona hosts the video and its command voice has no fallback', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  const fm = frontmatter(raw);
  expect(Number(fm.seedVersion) >= 15).toBe(true);
  expect(fm.tools.split(',').map((t) => t.trim())).toContain('mcp__session-manager-scheduler__project_video_review_write');
  expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(27000);
  const pp = personaSection('project_persona');
  for (const needle of ['_character', 'Character: off', '`name`', '`character.js`', '`palette`', '`personality`', '`who`', '`speech`', '`readingLevel`', '`neverSay`']) {
    expect(pp).toContain(needle);
  }
  const audio = personaSection('audio_policy');
  for (const needle of ["`voice.engine: 'command'`", 'character.cjs speak', '$SM_PROJECT_ROOT', 'Never write a hand-written TTS script', 'fails the run', "`voice.engine: 'kokoro'`", '`voice.id`', 'af_heart']) {
    expect(audio).toContain(needle);
  }
  for (const banned of ['Burrow', 'Bilko']) expect(raw).not.toContain(banned);
});

test('persona v19: a saved cast points the builder at cast.md and each line names its speaker', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  expect(Number(frontmatter(raw).seedVersion) >= 19).toBe(true);
  expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(27000);
  const pp = personaSection('project_persona');
  for (const needle of ['`cast`', '`<kit>/cast.md`', 'before writing the script', '409', '`replace`', 'build unsaved']) expect(pp).toContain(needle);
  expect(personaSection('kit')).toContain('lines: [{ text, out, speaker? }]');
  const audio = personaSection('audio_policy');
  for (const needle of ["cast member's line", 'own `voice`', 'no fallback to the host voice']) expect(audio).toContain(needle);
  expect(personaSection('when_things_fail')).toContain('never build a replacement for a failed kit tool');
  for (const banned of ['Burrow', 'Bilko']) expect(raw).not.toContain(banned);
});

test('persona v20: a {lines} voice is one batch call per speaker, and speak exit 75 is run again, not a failure', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  expect(Number(frontmatter(raw).seedVersion) >= 20).toBe(true);
  expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(27000);
  const kit = personaSection('kit');
  for (const needle of ['{lines}', '75', 'run the same command again']) expect(kit).toContain(needle);
  expect(personaSection('audio_policy')).toContain('not a failure');
  expect(personaSection('when_things_fail')).toContain('not a failure');
  for (const banned of ['Burrow', 'Bilko']) expect(raw).not.toContain(banned);
});

test('persona v21: narration always goes through kit speak with the Voice > persona > kit default precedence', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  expect(Number(frontmatter(raw).seedVersion) >= 21).toBe(true);
  expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(27000);
  const audio = personaSection('audio_policy');
  for (const needle of ["'Voice: <id>'", '{voiceId}', '`af_heart`', '`am_michael`', 'node <kit>/character.cjs speak spec.json', '`spec.voice`',
    'Never write a hand-written TTS script', 'voice lane: waiting, position N', 'Exit 75', 'run the same command again',
    "changed since a human approved it", 'fails the run with that error', 'kokoro-onnx soundfile', 'voices-v1.0.bin', 'sound.cjs']) {
    expect(audio).toContain(needle);
  }
  const order = ["'Voice: <id>'", '{voiceId}', 'the kit default `af_heart`'].map((n) => audio.indexOf(n));
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  for (const gone of ['build.py', 'from kokoro_onnx import Kokoro', 'k.create(']) expect(audio).not.toContain(gone);
  for (const banned of ['Burrow', 'Bilko']) expect(raw).not.toContain(banned);
});

test('persona v15: TikTok and Marketing follow the kit playbooks and export MP4 + poster', () => {
  const kt = personaSection('kind_and_target');
  for (const needle of ['TikTok', 'Marketing', 'kind-tiktok.md', 'kind-marketing.md', '`tiktok`', '`marketing`', 'never fall back to a Project demo']) {
    expect(kt).toContain(needle);
  }
  const kit = personaSection('kit');
  for (const needle of ['export.cjs', 'character.cjs', '1080x1920']) expect(kit).toContain(needle);
  const proc = personaSection('process');
  for (const needle of ['`mp4Path`', '`posterPath`', '`tiktok` input', 'postCaption: meta.post.caption', '`post`']) expect(proc).toContain(needle);
  const out = personaSection('output_contract');
  for (const needle of ['9:16, 1080x1920', 'smDemo.beats', 'smDemo.cuts']) expect(out).toContain(needle);
});

test('persona v15: the review stage saves review material only, and an approval builds exactly that', () => {
  const proc = personaSection('process');
  for (const needle of ["'Review stage:'", 'project_video_review_write', 'exactly once', 'storyboard', 'timing', 'post caption', 'contact sheet',
    'Build and save no video', "'Review: approved by the owner at ...'", 'videos/<Entry id>/review/material.json', 'build exactly that',
    "'Review: changes requested: <note>'", 'redo the review material']) {
    expect(proc).toContain(needle);
  }
});

test('persona makes every saved video play standalone: own-clock reduced motion, tap-anywhere sound, standalone.cjs', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  expect(Number(frontmatter(raw).seedVersion) >= 25).toBe(true);
  const body = personaBody();
  const contract = body.slice(body.indexOf('<output_contract>'), body.indexOf('</output_contract>'));
  expect(contract).toContain('still keystones');
  expect(contract).toContain("video's own clock");
  expect(contract).toContain('narration plays as usual');
  expect(contract).not.toContain('static storyboard');
  expect(contract).not.toContain('stepped by the host');
  const audio = body.slice(body.indexOf('<audio_policy>\n'), body.indexOf('</audio_policy>'));
  for (const needle of ['pointerdown', 'keydown', 'audio.currentTime', 'no visible control', 'no `<button>`', 'sound button']) {
    expect(audio).toContain(needle);
  }
  expect(audio).not.toContain('keep playing muted');
  const sketch = audio.slice(audio.indexOf('Sketch'), audio.indexOf('- Never write the literal pattern'));
  expect(sketch).toContain('audio.play()');
  expect(sketch).not.toMatch(/\bFunction\s*\(/i);
  const kit = body.slice(body.indexOf('<kit>'), body.indexOf('</kit>'));
  expect(kit).toContain('node <kit>/standalone.cjs <built.html>');
  expect(body).toMatch(/7\. Self-check before saving:[^\n]*standalone\.cjs/);
});
