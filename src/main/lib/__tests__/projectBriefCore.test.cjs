// projectBriefCore.cjs — pure logic for the Brief backend (PRD 837).
// vitest globals (test/beforeEach/afterEach) — same convention as the other .cjs tests.
const assert = require('node:assert/strict');
const {
  computeDrift,
  buildSources,
  buildSynthesisPrompt,
  validateBriefShape,
  applyPinEnforcement,
  buildPersistedBrief,
  computeSetPin,
} = require('../projectBriefCore.cjs');

test('computeDrift: true only when mtime strictly newer than synthesizedAt', () => {
  assert.equal(computeDrift(200, 100), true);
  assert.equal(computeDrift(100, 200), false);
  assert.equal(computeDrift(100, 100), false);
  assert.equal(computeDrift(null, 100), false);
  assert.equal(computeDrift(200, null), false);
});

test('buildSources: omits null sources, computes drift per source', () => {
  const synthesizedAt = new Date(1_000_000).toISOString();
  const sources = buildSources({
    synthesizedAt,
    claudeMd: { detail: '40 lines', mtimeMs: 500_000 },
    epics: { detail: '2 active · 1 archived', mtimeMs: 2_000_000 },
    sessions: null,
    git: { detail: '12 commits', mtimeMs: 900_000 },
  });
  assert.equal(sources.length, 3);
  const byLabel = Object.fromEntries(sources.map((s) => [s.label, s]));
  assert.equal(byLabel['CLAUDE.md'].drift, false);
  assert.equal(byLabel['Epics'].drift, true);
  assert.equal(byLabel['Git'].drift, false);
  assert.equal(byLabel['Sessions'], undefined);
});

test('buildSources: no synthesizedAt yet means nothing drifts', () => {
  const sources = buildSources({
    synthesizedAt: null,
    claudeMd: { detail: '1 line', mtimeMs: 999 },
    epics: null,
    sessions: null,
    git: null,
  });
  assert.equal(sources[0].drift, false);
});

test('buildSynthesisPrompt includes CLAUDE.md, epics, git log, tree, and pinned block instruction', () => {
  const prompt = buildSynthesisPrompt({
    claudeMdText: '# Project X',
    epics: [{ status: 'active', tag: 'feature', goalText: 'Ship the thing' }],
    gitLogLines: ['abc123 fix bug'],
    srcTree: 'src/\n  main/\n  renderer/',
    pinnedBlocks: { conventions: ['Never use shell:true'] },
  });
  assert.match(prompt, /# Project X/);
  assert.match(prompt, /Ship the thing/);
  assert.match(prompt, /abc123 fix bug/);
  assert.match(prompt, /src\/\n  main\//);
  assert.match(prompt, /PINNED BLOCK "conventions"/);
  assert.match(prompt, /Never use shell:true/);
  assert.doesNotMatch(prompt, /PINNED BLOCK "what"/);
});

test('validateBriefShape: accepts a well-formed object, rejects malformed ones', () => {
  const good = { purpose: 'x', what: [], areas: [], scope: [], conventions: [] };
  assert.deepEqual(validateBriefShape(good), { ok: true, error: null });
  assert.equal(validateBriefShape(null).ok, false);
  assert.equal(validateBriefShape({ ...good, purpose: '' }).ok, false);
  assert.equal(validateBriefShape({ ...good, what: 'not an array' }).ok, false);
  assert.equal(validateBriefShape({ ...good, areas: undefined }).ok, false);
});

test('applyPinEnforcement: overwrites a pinned block with the frozen copy, carries pins/pinned forward', () => {
  const raw = { purpose: 'p', what: ['fresh what'], areas: [], scope: [], conventions: ['fresh conventions'] };
  const priorPins = { what: false, conventions: true };
  const priorPinned = { what: null, conventions: ['frozen conventions'] };
  const merged = applyPinEnforcement(raw, priorPins, priorPinned);
  assert.deepEqual(merged.what, ['fresh what']);
  assert.deepEqual(merged.conventions, ['frozen conventions']);
  assert.deepEqual(merged.pins, priorPins);
  assert.deepEqual(merged.pinned, priorPinned);
});

test('applyPinEnforcement: unpinned brief passes model output through untouched', () => {
  const raw = { purpose: 'p', what: ['fresh'], areas: [], scope: [], conventions: ['fresh'] };
  const merged = applyPinEnforcement(raw, null, null);
  assert.deepEqual(merged.what, ['fresh']);
  assert.deepEqual(merged.conventions, ['fresh']);
  assert.deepEqual(merged.pins, { what: false, conventions: false });
});

test('buildPersistedBrief stamps version/synthesizedAt/model and enforces pins', () => {
  const raw = { purpose: 'p', what: ['fresh'], areas: [{ name: 'a', files: 1, note: '', epic: null, heat: 0.1 }], scope: [], conventions: ['fresh'] };
  const persisted = buildPersistedBrief({
    rawBrief: raw,
    priorPins: { what: true, conventions: false },
    priorPinned: { what: ['frozen what'], conventions: null },
    model: 'claude-sonnet-5',
    nowIso: '2026-07-31T00:00:00.000Z',
  });
  assert.equal(persisted.version, 1);
  assert.equal(persisted.synthesizedAt, '2026-07-31T00:00:00.000Z');
  assert.equal(persisted.model, 'claude-sonnet-5');
  assert.deepEqual(persisted.what, ['frozen what']);
  assert.deepEqual(persisted.conventions, ['fresh']);
  assert.deepEqual(persisted.areas, raw.areas);
});

test('computeSetPin: errors when there is no brief yet', () => {
  const res = computeSetPin(null, 'what', true);
  assert.equal(res.ok, false);
});

test('computeSetPin: errors on an unpinnable block', () => {
  const brief = { purpose: 'p', what: [], areas: [], scope: [], conventions: [], pins: {}, pinned: {} };
  const res = computeSetPin(brief, 'areas', true);
  assert.equal(res.ok, false);
});

test('computeSetPin: pinning freezes current block content, unpinning clears it', () => {
  const brief = {
    purpose: 'p',
    what: ['a', 'b'],
    areas: [],
    scope: [],
    conventions: ['c1'],
    pins: { what: false, conventions: false },
    pinned: { what: null, conventions: null },
  };
  const pinned = computeSetPin(brief, 'what', true);
  assert.equal(pinned.ok, true);
  assert.equal(pinned.brief.pins.what, true);
  assert.deepEqual(pinned.brief.pinned.what, ['a', 'b']);

  const unpinned = computeSetPin(pinned.brief, 'what', false);
  assert.equal(unpinned.ok, true);
  assert.equal(unpinned.brief.pins.what, false);
  assert.equal(unpinned.brief.pinned.what, null);
});
