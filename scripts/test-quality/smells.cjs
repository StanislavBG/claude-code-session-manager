'use strict';

/**
 * Static test-smell scanner. Tags each test file with smells that predict low
 * test value, without executing anything:
 *
 *   source-text  reads a production file and regex/substring-asserts on its text
 *   no-assert    some it/test block has no expect()/assert call
 *   mock-only    some test's every expect is toHaveBeenCalled/toBeCalled variants
 *   micro-file   <=2 tests, <=40 lines, shares a relative module with another test file
 *   prd-named    file name carries a PRD/plan number
 *
 * Usage: node scripts/test-quality/smells.cjs [--json] [--root <dir>]
 *        node scripts/test-quality/smells.cjs --check <allowlist.json> [--root <dir>]
 *
 * --check ratchets source-text and no-assert: a flagged file must be allowlisted, and an
 * allowlist entry whose file is gone or no longer has the smell must be removed.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { listIncludedFiles, INCLUDE_GLOBS } =require('../list-pure-tests.cjs');

const SMELL_ORDER = ['source-text', 'no-assert', 'mock-only', 'micro-file', 'prd-named'];
const PROD_DIRS = new Set(['src', 'scripts', 'plugins', 'web', 'bin']);
const TEST_MODIFIERS = new Set(['skip', 'only', 'concurrent', 'fails', 'fixme', 'slow', 'fail', 'each']);
const TEXT_MATCHERS = new Set(['toMatch', 'toContain', 'toContainEqual', 'toMatchInlineSnapshot']);
const TEXT_METHODS = new Set(['includes', 'indexOf', 'match', 'search', 'test', 'startsWith', 'endsWith']);
const ASSERT_TEXT_FNS = new Set(['match', 'doesNotMatch', 'ok', 'includes']);
const MOCK_MATCHER = /^(toHaveBeen(Last|Nth)?Called|toBeCalled|lastCalledWith|nthCalledWith)/;
const MODULE_EXT = /\.(cjs|mjs|js|jsx|ts|tsx|json)$/;

function scriptKind(relPath) {
  if (relPath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relPath.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function walkNodes(node, visit) {
  visit(node);
  ts.forEachChild(node, (c) => walkNodes(c, visit));
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function rootIdentifier(expr) {
  let e = expr;
  while (e) {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
    else return null;
  }
  return null;
}

function isTestCallee(expr) {
  if (ts.isIdentifier(expr)) return expr.text === 'it' || expr.text === 'test';
  if (ts.isPropertyAccessExpression(expr)) return TEST_MODIFIERS.has(expr.name.text) && isTestCallee(expr.expression);
  if (ts.isCallExpression(expr)) return isTestCallee(expr.expression);
  if (ts.isTaggedTemplateExpression(expr)) return isTestCallee(expr.tag);
  return false;
}

function isFn(n) {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n);
}

function isExpectCall(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text === 'expect';
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'expect' &&
    (e.name.text === 'soft' || e.name.text === 'poll');
}

function isAssertCall(call) {
  return rootIdentifier(call.expression) === 'assert';
}

/** Matcher name chained onto an expect(...) call, e.g. `toHaveBeenCalledWith`; null if none. */
function matcherOf(expectCall) {
  let n = expectCall;
  while (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) n = n.parent;
  if (n !== expectCall && n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n) return n.name.text;
  return null;
}

// ---- path evaluation (static, best effort) --------------------------------

function normRel(p) {
  return path.posix.normalize(p.split(path.sep).join('/')).replace(/^\/+/, '');
}

function makePathEvaluator(relPath, decls) {
  const dir = path.posix.dirname(relPath);
  function evalPath(node, depth) {
    if (depth > 6 || !node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return evalPath(node.expression, depth + 1);
    if (ts.isIdentifier(node)) {
      if (node.text === '__dirname') return dir;
      const init = decls.get(node.text);
      return init ? evalPath(init, depth + 1) : null;
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) out += (evalPath(span.expression, depth + 1) || '') + span.literal.text;
      return out;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = evalPath(node.left, depth + 1);
      const r = evalPath(node.right, depth + 1);
      return l == null && r == null ? null : (l || '') + (r || '');
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === 'join' || name === 'resolve' || name === 'normalize') {
        let acc = '';
        for (const a of node.arguments) {
          const v = evalPath(a, depth + 1);
          if (v == null) continue;
          acc = acc ? path.posix.join(acc, v) : v;
        }
        return normRel(acc || '.');
      }
      if (name === 'cwd') return '';
    }
    return null;
  }
  return (node) => evalPath(node, 0);
}

function isProdPath(p) {
  if (p == null) return false;
  const norm = normRel(p);
  // Prose docs are not production code: a doc drift guard is not a source-text smell.
  if (/\.md$/i.test(norm)) return false;
  const segs = norm.split('/');
  if (segs[0] === '..' || !PROD_DIRS.has(segs[0]) || segs.length < 2) return false;
  return !segs.includes('__tests__') && !segs.includes('fixtures');
}

// ---- analysis -------------------------------------------------------------

function relativeModules(sf, relPath) {
  const dir = path.posix.dirname(relPath);
  const out = new Set();
  const add = (spec) => {
    if (typeof spec === 'string' && spec.startsWith('.')) out.add(normRel(path.posix.join(dir, spec)).replace(MODULE_EXT, ''));
  };
  walkNodes(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.arguments.length && ts.isStringLiteral(n.arguments[0])) {
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      const isDynImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynImport) add(n.arguments[0].text);
    }
  });
  return out;
}

function detectSourceText(sf, relPath) {
  const decls = new Map();
  walkNodes(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !decls.has(n.name.text)) decls.set(n.name.text, n.initializer);
  });
  const evalPath = makePathEvaluator(relPath, decls);

  const readCalls = new Set();
  walkNodes(sf, (n) => {
    if (!ts.isCallExpression(n) || n.arguments.length === 0) return;
    const name = calleeName(n);
    if (name !== 'readFileSync' && name !== 'readFile') return;
    if (isProdPath(evalPath(n.arguments[0]))) readCalls.add(n);
  });
  if (readCalls.size === 0) return false;

  const tainted = new Set();
  const refsTainted = (node) => {
    let hit = false;
    walkNodes(node, (c) => {
      if (hit) return;
      if (readCalls.has(c)) hit = true;
      else if (ts.isIdentifier(c) && tainted.has(c.text)) hit = true;
    });
    return hit;
  };
  for (let changed = true, i = 0; changed && i < 8; i++) {
    changed = false;
    walkNodes(sf, (n) => {
      let name = null;
      let init = null;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) { name = n.name.text; init = n.initializer; }
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) { name = n.left.text; init = n.right; }
      if (name && init && !tainted.has(name) && refsTainted(init)) { tainted.add(name); changed = true; }
    });
  }

  let asserts = false;
  walkNodes(sf, (n) => {
    if (asserts || !ts.isCallExpression(n)) return;
    const name = calleeName(n);
    // text-search method on tainted text: src.includes('x'), re.test(src), src.indexOf(..)
    if (ts.isPropertyAccessExpression(n.expression) && TEXT_METHODS.has(name)) {
      if (refsTainted(n.expression.expression) || n.arguments.some(refsTainted)) { asserts = true; return; }
    }
    // expect(<tainted>).toMatch/toContain
    if (ts.isPropertyAccessExpression(n.expression) && TEXT_MATCHERS.has(name)) {
      let e = n.expression.expression;
      while (ts.isPropertyAccessExpression(e)) e = e.expression;
      if (ts.isCallExpression(e) && isExpectCall(e) && e.arguments.some(refsTainted)) { asserts = true; return; }
    }
    // assert.match(src, /re/)
    if (isAssertCall(n) && ASSERT_TEXT_FNS.has(name) && n.arguments.some(refsTainted)) asserts = true;
  });
  return asserts;
}

function fileNameIsPrdNamed(relPath) {
  const base = path.posix.basename(relPath);
  return /prd\d+/i.test(base) || /pn-\d+/i.test(base) || /ss-\d+/i.test(base) || /(?:^|[-_.])\d{3,4}(?:$|[-_.])/.test(base);
}

function analyze(relPath, text) {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind(relPath));
  const lines = text.split('\n');
  const loc = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);

  const tests = [];
  walkNodes(sf, (n) => {
    if (!ts.isCallExpression(n) || !isTestCallee(n.expression)) return;
    const fn = n.arguments.length ? n.arguments[n.arguments.length - 1] : null;
    if (fn && isFn(fn)) tests.push(fn);
  });

  let expects = 0;
  walkNodes(sf, (n) => {
    if (ts.isCallExpression(n) && (isExpectCall(n) || isAssertCall(n))) expects++;
  });

  let noAssert = false;
  let mockOnly = false;
  for (const fn of tests) {
    let count = 0;
    let expectCount = 0;
    let mockCount = 0;
    walkNodes(fn, (n) => {
      if (!ts.isCallExpression(n)) return;
      if (isExpectCall(n)) {
        count++;
        expectCount++;
        const m = matcherOf(n);
        if (m && MOCK_MATCHER.test(m)) mockCount++;
      } else if (isAssertCall(n)) count++;
    });
    if (count === 0) noAssert = true;
    if (expectCount > 0 && count === expectCount && mockCount === expectCount) mockOnly = true;
  }

  const smells = new Set();
  if (detectSourceText(sf, relPath)) smells.add('source-text');
  if (noAssert) smells.add('no-assert');
  if (mockOnly) smells.add('mock-only');
  if (fileNameIsPrdNamed(relPath)) smells.add('prd-named');

  return { file: relPath, tests: tests.length, expects, loc, smells, modules: relativeModules(sf, relPath) };
}

function finish(info, sharedModules) {
  const smells = new Set(info.smells);
  if (info.tests <= 2 && info.loc <= 40 && sharedModules) {
    for (const m of info.modules) if (sharedModules.has(m)) { smells.add('micro-file'); break; }
  }
  return {
    file: info.file,
    tests: info.tests,
    expects: info.expects,
    loc: info.loc,
    smells: SMELL_ORDER.filter((s) => smells.has(s)),
  };
}

/** Modules (extension-less repo-relative keys) required by >=2 of the given [{relPath,text}] files. */
function sharedModulesOf(entries) {
  const users = new Map();
  for (const { relPath, text } of entries) {
    const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind(relPath));
    for (const m of relativeModules(sf, relPath)) {
      if (!users.has(m)) users.set(m, new Set());
      users.get(m).add(relPath);
    }
  }
  return new Set([...users].filter(([, s]) => s.size >= 2).map(([m]) => m));
}

function scanTestSource(relPath, text, sharedModules) {
  return finish(analyze(relPath, text), sharedModules);
}

// ---- repo scan ------------------------------------------------------------

function collectSpecs(root, sub, exts, out) {
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.some((x) => e.name.endsWith(x))) out.add(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, sub));
}

// list-pure-tests.cjs's matcher turns `**/` into `.*/`, so it misses files sitting directly
// in `__tests__`; walk the same globs with `**` = zero or more directories and union.
function globRegExp(glob) {
  let re = '';
  const segs = glob.split('/');
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') re += last ? '.*' : '(?:[^/]+/)*';
    else re += seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}

function collectGlobbed(root, out) {
  const matchers = INCLUDE_GLOBS.map(globRegExp);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (matchers.some((re) => re.test(rel))) out.add(rel);
      }
    }
  };
  walk(root);
}

function scanRepo(root) {
  const rels = new Set(listIncludedFiles());
  collectGlobbed(root, rels);
  collectSpecs(root, 'tests/e2e', ['.spec.ts', '.spec.mjs'], rels);
  collectSpecs(root, 'tests/smoke', ['.spec.ts'], rels);

  const infos = [];
  for (const rel of [...rels].sort()) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    infos.push(analyze(rel, text));
  }
  const users = new Map();
  for (const info of infos) {
    for (const m of info.modules) {
      if (!users.has(m)) users.set(m, new Set());
      users.get(m).add(info.file);
    }
  }
  const shared = new Set([...users].filter(([, s]) => s.size >= 2).map(([m]) => m));

  const files = infos.map((i) => finish(i, shared));
  const bySmell = {};
  const totals = { files: files.length, tests: 0, expects: 0, loc: 0, bySmell };
  for (const f of files) {
    totals.tests += f.tests;
    totals.expects += f.expects;
    totals.loc += f.loc;
    for (const s of f.smells) bySmell[s] = (bySmell[s] || 0) + 1;
  }
  return { files, totals };
}

function formatTable(result) {
  const rows = [...result.files].sort((a, b) => b.smells.length - a.smells.length || b.loc - a.loc);
  const w = Math.max(4, ...rows.map((r) => r.file.length));
  const lines = [`${'file'.padEnd(w)}  ${'tests'.padStart(5)}  ${'loc'.padStart(5)}  smells`];
  for (const r of rows) lines.push(`${r.file.padEnd(w)}  ${String(r.tests).padStart(5)}  ${String(r.loc).padStart(5)}  ${r.smells.join(',')}`);
  const t = result.totals;
  lines.push('', `files=${t.files} tests=${t.tests} expects=${t.expects} loc=${t.loc} bySmell=${JSON.stringify(t.bySmell)}`);
  return lines.join('\n');
}

const RATCHETED = ['source-text', 'no-assert'];

/** Pure ratchet: returns diagnostic lines (empty = clean) for a scanRepo result vs an allowlist. */
function check(allowlist, scan) {
  const byFile = new Map(scan.files.map((f) => [f.file, f]));
  const findings = [];
  for (const smell of RATCHETED) {
    const allowed = new Set((allowlist && allowlist[smell]) || []);
    for (const f of scan.files) {
      if (f.smells.includes(smell) && !allowed.has(f.file)) {
        findings.push(`${f.file}: new ${smell} smell (fix the test; do not add it to the allowlist)`);
      }
    }
    for (const rel of [...allowed].sort()) {
      const f = byFile.get(rel);
      if (!f) findings.push(`${rel}: allowlisted for ${smell} but the file no longer exists — remove it from the allowlist`);
      else if (!f.smells.includes(smell)) findings.push(`${rel}: allowlisted for ${smell} but no longer has it — remove it from the allowlist`);
    }
  }
  return findings;
}

module.exports = { scanTestSource, scanRepo, sharedModulesOf, check, SMELL_ORDER };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(flagValue('--root') || process.cwd());
  const result = scanRepo(root);
  if (argv.includes('--check')) {
    const listPath = flagValue('--check');
    if (!listPath) {
      console.error('smells: --check requires an allowlist path');
      process.exit(1);
    }
    const allowlist = JSON.parse(fs.readFileSync(path.resolve(root, listPath), 'utf8'));
    const findings = check(allowlist, result);
    if (findings.length) {
      for (const f of findings) console.error(f);
      process.exit(1);
    }
    console.log('smells --check: OK');
  } else {
    console.log(argv.includes('--json') ? JSON.stringify(result) : formatTable(result));
  }
}
