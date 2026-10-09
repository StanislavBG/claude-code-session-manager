#!/usr/bin/env node
/**
 * page-surface.cjs — derived page → renderer-files map for the page steward subagents
 * (see session-manager-operations/architecture/page-stewards.md). Nothing here is
 * hand-maintained: pages come from NAV_ITEMS, entries from computeScreenComponent's switch,
 * and ownership from a static import graph. Complexity: O(total renderer bytes) — each
 * source file is read and preprocessed at most once per classifyPages call.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const NAV_GROUPS = 'src/renderer/lib/navGroups.ts';
const SCREEN_COMPONENTS = 'src/renderer/components/screenComponents.tsx';
const WRAPPERS = new Set(['LazyScreen', 'Suspense', 'SectionFrame', 'Fragment']);
const ASSET_EXT = new Set(['.css', '.scss', '.svg', '.png', '.jpg', '.gif', '.json', '.wasm', '.onnx', '.md', '.html', '.txt']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs']);

const toPosix = (p) => p.split(path.sep).join('/');
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function parse(root, rel, kind) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

const strings = (arr) => arr.elements.filter(ts.isStringLiteralLike).map((e) => e.text);

function listPages(root) {
  const sf = parse(root, NAV_GROUPS, ts.ScriptKind.TS);
  const consts = new Map();
  let items = null;
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !n.initializer) return;
    const init = n.initializer;
    if (n.name.text === 'NAV_ITEMS' && ts.isArrayLiteralExpression(init)) items = init;
    else if (ts.isArrayLiteralExpression(init)) consts.set(n.name.text, strings(init));
  });
  if (!items) throw new Error('page-surface: NAV_ITEMS not found in ' + NAV_GROUPS);

  const entries = resolveEntries(root);
  const pages = [];
  for (const obj of items.elements) {
    if (!ts.isObjectLiteralExpression(obj)) continue;
    let key = null, label = null, faces = [];
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
      const v = p.initializer;
      if (p.name.text === 'key' && ts.isStringLiteralLike(v)) key = v.text;
      else if (p.name.text === 'label' && ts.isStringLiteralLike(v)) label = v.text;
      else if (p.name.text === 'faces') {
        if (ts.isIdentifier(v)) faces = consts.get(v.text) || [];
        else if (ts.isArrayLiteralExpression(v)) faces = strings(v);
      }
    }
    if (key === null) continue;
    pages.push({ key, label, faces, entry: entries.has(key) ? entries.get(key) : null });
  }
  return pages;
}

/** key → repo-relative entry file, for every `case '<key>'` in computeScreenComponent. */
function resolveEntries(root) {
  const sf = parse(root, SCREEN_COMPONENTS, ts.ScriptKind.TSX);
  const specs = new Map();
  const dir = path.join(root, path.dirname(SCREEN_COMPONENTS));
  let fn = null;
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      for (const el of n.importClause.namedBindings.elements) specs.set(el.name.text, n.moduleSpecifier.text);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(sf) === 'lazy') {
      walk(n.initializer, (c) => {
        if (ts.isCallExpression(c) && c.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(c.arguments[0])) {
          if (!specs.has(n.name.text)) specs.set(n.name.text, c.arguments[0].text);
        }
      });
    } else if (ts.isFunctionDeclaration(n) && n.name?.text === 'computeScreenComponent') fn = n;
  });
  if (!fn) throw new Error('page-surface: computeScreenComponent not found in ' + SCREEN_COMPONENTS);

  const out = new Map();
  walk(fn, (n) => {
    if (!ts.isCaseClause(n) || !ts.isStringLiteralLike(n.expression)) return;
    const key = n.expression.text;
    if (out.has(key)) return;
    let tag = null;
    walk(n, (c) => {
      if (tag || !(ts.isJsxSelfClosingElement(c) || ts.isJsxOpeningElement(c))) return;
      const name = c.tagName.getText(sf);
      if (!WRAPPERS.has(name)) tag = name;
    });
    const spec = tag && specs.get(tag);
    const resolved = spec && resolveSpecifier(dir, spec, root);
    if (!resolved) throw new Error(`page-surface: cannot resolve entry for NavKey '${key}'`);
    out.set(key, resolved);
  });
  return out;
}

function resolveSpecifier(fromDirAbs, spec, root) {
  if (!spec.startsWith('.')) return null;
  const clean = spec.replace(/\?.*$/, '');
  const ext = path.extname(clean);
  if (ASSET_EXT.has(ext)) return null;
  const base = path.resolve(fromDirAbs, clean);
  const candidates = [];
  if (CODE_EXT.has(ext)) candidates.push(base);
  for (const e of CODE_EXT) candidates.push(base + e);
  candidates.push(path.join(base, 'index.ts'), path.join(base, 'index.tsx'));
  const hit = candidates.find(isFile);
  return hit ? toPosix(path.relative(root, hit)) : null;
}

function importsOf(root, rel, cache) {
  let hit = cache.get(rel);
  if (hit) return hit;
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const dir = path.dirname(path.join(root, rel));
  hit = [];
  for (const f of ts.preProcessFile(text, true, true).importedFiles) {
    const r = resolveSpecifier(dir, f.fileName, root);
    if (r && r.startsWith('src/renderer/') && !/\/__tests__\/|\.(test|spec)\./.test(r)) hit.push(r);
  }
  cache.set(rel, hit);
  return hit;
}

function importGraph(root, file, cache = new Map()) {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    for (const dep of importsOf(root, queue.shift(), cache)) {
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  return [...seen].sort();
}

function classifyPages(root) {
  const cache = new Map();
  const reach = new Map();
  for (const p of listPages(root)) {
    if (!p.entry) continue;
    reach.set(p.key, importGraph(root, p.entry, cache));
  }
  const reachers = new Map();
  for (const [key, files] of reach) {
    for (const f of files) {
      if (!reachers.has(f)) reachers.set(f, []);
      reachers.get(f).push(key);
    }
  }
  const out = {};
  for (const [key, files] of reach) {
    const owned = [], shared = [];
    for (const f of files) {
      const pages = reachers.get(f).slice().sort();
      if (pages.length === 1) owned.push(f);
      else shared.push({ file: f, pages });
    }
    out[key] = { owned, shared };
  }
  return out;
}

module.exports = { listPages, importGraph, classifyPages, resolveSpecifier };
