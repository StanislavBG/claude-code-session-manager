'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/toolRiskMarks.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MARKS,
  BLOCKING_MARKS,
  systemMarksPath,
  projectMarksPath,
  parseRule,
  ruleMatches,
  readMarksLayer,
  validateMarksFile,
  writeMarksLayer,
  resolveMark,
} = require('../toolRiskMarks.cjs');

const FIXTURE = '{"version":1,"interactive":false,"marks":{"mcp__gmail-sg__send_email":"public","mcp__gmail-sg__delete_email":"irreversible","mcp__gmail-sg__batch_delete_emails":"irreversible","Bash(npm publish:*)":"public","mcp__bilko-host__publish_static_project":"public","mcp__burrow__trigger_gather":"public"}}';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-risk-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const bash = (command) => ({ tool: 'Bash', input: { command } });
const layer = (marks, file) => ({ ok: true, exists: true, marks, interactive: false, file });

describe('exports', () => {
  it('MARKS and BLOCKING_MARKS', () => {
    assert.deepEqual([...MARKS], ['read', 'write', 'irreversible', 'money', 'public']);
    assert.ok(BLOCKING_MARKS instanceof Set);
    assert.deepEqual([...BLOCKING_MARKS].sort(), ['irreversible', 'money', 'public']);
  });
  it('paths', () => {
    assert.equal(systemMarksPath('/home/u'), path.join('/home/u', '.claude', 'tool-risk.json'));
    assert.equal(projectMarksPath('/p/root'), path.join('/p/root', '.claude', 'tool-risk.json'));
  });
});

describe('parseRule', () => {
  it('parses MCP exact and server wildcard', () => {
    assert.deepEqual(parseRule('mcp__gmail-sg__send_email'), { kind: 'mcp', server: 'gmail-sg', tool: 'send_email' });
    assert.deepEqual(parseRule('mcp__gmail-sg__*'), { kind: 'mcp', server: 'gmail-sg', tool: null });
  });
  it('parses Bash prefix and exact', () => {
    assert.deepEqual(parseRule('Bash(npm publish:*)'), { kind: 'bash', prefix: ['npm', 'publish'], exact: false });
    assert.deepEqual(parseRule('Bash(git push --force)'), { kind: 'bash', prefix: ['git', 'push', '--force'], exact: true });
  });
  it('rejects bad rules', () => {
    for (const bad of ['', '   ', 'Write', 'Bash', 'Bash()', 'Bash(:*)', 'Bash(npm\npublish:*)', 'mcp__', 'mcp____x',
      'mcp__srv__', 'mcp__srv__a*b', 'WebFetch(domain:x)', 'mcp__a\n__b', 'Bash("unterminated)', null, 42]) {
      assert.equal(parseRule(bad), null, `expected reject: ${JSON.stringify(bad)}`);
    }
  });
});

describe('ruleMatches', () => {
  it('exact MCP names', () => {
    assert.ok(ruleMatches('mcp__gmail-sg__send_email', { tool: 'mcp__gmail-sg__send_email' }));
    assert.ok(!ruleMatches('mcp__gmail-sg__send_email', { tool: 'mcp__gmail-sg__send_email_draft' }));
    assert.ok(!ruleMatches('mcp__gmail-sg__send_email', { tool: 'mcp__gmail__send_email' }));
  });
  it('server wildcards', () => {
    assert.ok(ruleMatches('mcp__gmail-sg__*', { tool: 'mcp__gmail-sg__anything' }));
    assert.ok(!ruleMatches('mcp__gmail-sg__*', { tool: 'mcp__gmail-sg-2__anything' }));
    assert.ok(!ruleMatches('mcp__gmail-sg__*', bash('mcp__gmail-sg__x')));
  });
  it('Bash prefix', () => {
    assert.ok(ruleMatches('Bash(npm publish:*)', bash('npm publish')));
    assert.ok(ruleMatches('Bash(npm publish:*)', bash('npm publish --tag latest')));
    assert.ok(ruleMatches('Bash(npm publish:*)', bash('cd x && FOO=1 npm publish --tag latest')));
    assert.ok(!ruleMatches('Bash(npm publish:*)', bash('npm publisher')));
    assert.ok(!ruleMatches('Bash(npm publish:*)', bash('npm run publish')));
    assert.ok(!ruleMatches('Bash(npm publish:*)', bash('echo "npm publish"')));
    assert.ok(!ruleMatches('Bash(npm publish:*)', { tool: 'mcp__x__y', input: { command: 'npm publish' } }));
  });
  it('Bash exact', () => {
    assert.ok(ruleMatches('Bash(git push --force)', bash('git push --force')));
    assert.ok(!ruleMatches('Bash(git push --force)', bash('git push --force origin')));
    assert.ok(!ruleMatches('Bash(git push --force)', bash('git push')));
  });
  it('splits on && || ; | and newlines, outside quotes only', () => {
    for (const c of ['ls || npm publish', 'ls; npm publish', 'ls | npm publish', 'ls\nnpm publish', 'a && b && npm publish x']) {
      assert.ok(ruleMatches('Bash(npm publish:*)', bash(c)), c);
    }
    assert.ok(!ruleMatches('Bash(npm publish:*)', bash("echo 'a; npm publish'")));
    assert.ok(!ruleMatches('Bash(npm publish:*)', bash('echo "a && npm publish"')));
  });
  it('strips VAR=value and env/sudo/command/exec/nohup/time', () => {
    for (const c of ['A=1 B=2 npm publish', 'env npm publish', 'env -i FOO=1 npm publish', 'sudo npm publish',
      'sudo -u root npm publish', 'command npm publish', 'exec npm publish', 'nohup npm publish', 'time npm publish',
      'sudo env X=1 nohup npm publish']) {
      assert.ok(ruleMatches('Bash(npm publish:*)', bash(c)), c);
    }
  });
  it('unwraps one level of bash -c / sh -c', () => {
    assert.ok(ruleMatches('Bash(npm publish:*)', bash("bash -c 'npm publish'")));
    assert.ok(ruleMatches('Bash(npm publish:*)', bash('sh -c "cd x && npm publish --tag latest"')));
    assert.ok(ruleMatches('Bash(npm publish:*)', bash("bash -lc 'npm publish'")));
    // Only one level.
    assert.ok(!ruleMatches('Bash(npm publish:*)', bash(`bash -c "sh -c 'npm publish'"`)));
  });
  it('accepts a pre-parsed rule and never throws on junk', () => {
    assert.ok(ruleMatches(parseRule('Bash(npm publish:*)'), bash('npm publish')));
    assert.equal(ruleMatches('garbage', bash('npm publish')), false);
    assert.equal(ruleMatches('Bash(npm publish:*)', null), false);
    assert.equal(ruleMatches('Bash(npm publish:*)', { tool: 'Bash' }), false);
    assert.equal(ruleMatches('Bash(npm publish:*)', bash('echo "unterminated')), false);
  });
});

describe('validateMarksFile', () => {
  it('accepts the pinned fixture', () => {
    assert.deepEqual(validateMarksFile(JSON.parse(FIXTURE)), { ok: true });
  });
  it('rejects and names the bad key', () => {
    const cases = [
      [null, /object/],
      [{ version: 2, marks: {} }, /version/],
      [{ marks: {} }, /version/],
      [{ version: 1, marks: [] }, /marks/],
      [{ version: 1, interactive: 'yes', marks: {} }, /interactive/],
      [{ version: 1, marks: { 'mcp__a__b': 'danger' } }, /mcp__a__b/],
      [{ version: 1, marks: { 'Write': 'write' } }, /Write/],
      [{ version: 1, marks: {}, extra: 1 }, /extra/],
    ];
    for (const [obj, re] of cases) {
      const r = validateMarksFile(obj);
      assert.equal(r.ok, false, JSON.stringify(obj));
      assert.match(r.error, re);
    }
  });
});

describe('readMarksLayer', () => {
  it('missing file', () => {
    const file = path.join(tmp, 'nope.json');
    const r = readMarksLayer(file);
    assert.equal(r.ok, true);
    assert.equal(r.exists, false);
    assert.deepEqual(r.marks, {});
    assert.equal(r.interactive, false);
  });
  it('valid fixture', () => {
    const file = path.join(tmp, 'tool-risk.json');
    fs.writeFileSync(file, FIXTURE);
    const r = readMarksLayer(file);
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.interactive, false);
    assert.equal(r.marks['Bash(npm publish:*)'], 'public');
    assert.equal(Object.keys(r.marks).length, 6);
  });
  it('interactive true is carried', () => {
    const file = path.join(tmp, 't.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, interactive: true, marks: {} }));
    assert.equal(readMarksLayer(file).interactive, true);
  });
  it('errors never throw', () => {
    const bodies = ['{not json', '', JSON.stringify({ version: 3, marks: {} }),
      JSON.stringify({ version: 1, marks: { 'mcp__a__b': 'scary' } }),
      JSON.stringify({ version: 1, marks: { 'Bash()': 'read' } })];
    for (const body of bodies) {
      const file = path.join(tmp, 'bad.json');
      fs.writeFileSync(file, body);
      const r = readMarksLayer(file);
      assert.equal(r.ok, false, body);
      assert.equal(r.exists, true);
      assert.equal(typeof r.error, 'string');
    }
    // A directory in place of the file.
    const dir = path.join(tmp, 'dir.json');
    fs.mkdirSync(dir);
    assert.equal(readMarksLayer(dir).ok, false);
    assert.equal(readMarksLayer(undefined).ok, false);
  });
});

describe('writeMarksLayer', () => {
  it('writes a valid file atomically and round-trips', async () => {
    const file = path.join(tmp, 'sub', '.claude', 'tool-risk.json');
    const r = await writeMarksLayer(file, JSON.parse(FIXTURE));
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(FIXTURE));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tool-risk.json']);
    assert.equal(readMarksLayer(file).ok, true);
  });
  it('refuses invalid input naming the bad key and leaves the file alone', async () => {
    const file = path.join(tmp, 'tool-risk.json');
    fs.writeFileSync(file, FIXTURE);
    const r = await writeMarksLayer(file, { version: 1, marks: { 'Bash(rm -rf:*)': 'nuke' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /Bash\(rm -rf:\*\)/);
    assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE);
  });
});

describe('resolveMark', () => {
  const SYS = '/h/.claude/tool-risk.json';
  const PRJ = '/p/.claude/tool-risk.json';

  it('returns null when nothing matches', () => {
    assert.equal(resolveMark(bash('ls'), { system: layer({ 'Bash(npm publish:*)': 'public' }, SYS) }), null);
    assert.equal(resolveMark({ tool: 'Write' }, { system: layer(JSON.parse(FIXTURE).marks, SYS) }), null);
    assert.equal(resolveMark(bash('ls'), {}), null);
  });
  it('resolves from the fixture', () => {
    const system = layer(JSON.parse(FIXTURE).marks, SYS);
    assert.deepEqual(resolveMark({ tool: 'mcp__gmail-sg__send_email', input: {} }, { system }),
      { mark: 'public', rule: 'mcp__gmail-sg__send_email', layer: 'system', file: SYS });
    assert.deepEqual(resolveMark(bash('cd x && FOO=1 npm publish --tag latest'), { system }),
      { mark: 'public', rule: 'Bash(npm publish:*)', layer: 'system', file: SYS });
  });
  it('any matching project rule beats every system rule', () => {
    const system = layer({ 'mcp__srv__do': 'public' }, SYS);
    const project = layer({ 'mcp__srv__*': 'read' }, PRJ);
    assert.deepEqual(resolveMark({ tool: 'mcp__srv__do' }, { system, project }),
      { mark: 'read', rule: 'mcp__srv__*', layer: 'project', file: PRJ });
    assert.equal(resolveMark({ tool: 'mcp__srv__other' }, { system: layer({ 'mcp__srv__do': 'public' }, SYS), project: layer({}, PRJ) }), null);
    // Project with no match falls through to system.
    assert.equal(resolveMark({ tool: 'mcp__srv__do' }, { system, project: layer({ 'mcp__x__*': 'read' }, PRJ) }).layer, 'system');
  });
  it('specificity inside a layer: MCP exact > server wildcard', () => {
    const system = layer({ 'mcp__srv__*': 'write', 'mcp__srv__send': 'public' }, SYS);
    assert.equal(resolveMark({ tool: 'mcp__srv__send' }, { system }).rule, 'mcp__srv__send');
    assert.equal(resolveMark({ tool: 'mcp__srv__list' }, { system }).rule, 'mcp__srv__*');
  });
  it('specificity inside a layer: Bash exact > longer prefix > shorter prefix', () => {
    const system = layer({
      'Bash(npm:*)': 'write',
      'Bash(npm publish:*)': 'public',
      'Bash(npm publish --dry-run)': 'read',
    }, SYS);
    assert.equal(resolveMark(bash('npm publish --dry-run'), { system }).mark, 'read');
    assert.equal(resolveMark(bash('npm publish --tag x'), { system }).mark, 'public');
    assert.equal(resolveMark(bash('npm install'), { system }).mark, 'write');
  });
  it('compound Bash returns the blocking result if any simple command blocks', () => {
    const system = layer({ 'Bash(ls:*)': 'read', 'Bash(npm publish:*)': 'public' }, SYS);
    const project = layer({ 'Bash(ls:*)': 'read' }, PRJ);
    assert.deepEqual(resolveMark(bash('ls && npm publish'), { system, project }),
      { mark: 'public', rule: 'Bash(npm publish:*)', layer: 'system', file: SYS });
    assert.deepEqual(resolveMark(bash('ls -la'), { system, project }),
      { mark: 'read', rule: 'Bash(ls:*)', layer: 'project', file: PRJ });
  });
  it('skips broken layers and never throws', () => {
    const broken = { ok: false, exists: true, error: 'bad' };
    assert.equal(resolveMark(bash('npm publish'), { system: broken, project: broken }), null);
    assert.equal(resolveMark(null, null), null);
    assert.equal(resolveMark(bash('npm publish'), { system: { marks: { 'Bash(npm publish:*)': 'public' } } }).file, null);
  });
});
