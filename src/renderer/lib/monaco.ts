import { loader } from '@monaco-editor/react'

// Memoized promise — ensures loader.config({ monaco }) is called exactly once
// before any @monaco-editor/react Editor component calls loader.init().
let _promise: Promise<typeof import('monaco-editor')> | null = null

/**
 * Languages actually used by the app's editors (see LANG in CodeEditorPane.tsx,
 * plus the `json`/`markdown` defaultLanguage props on JsonEditor/MarkdownEditor):
 * typescript, javascript, python, go, rust, ruby, c/cpp, java, shell, css, scss,
 * less, html, xml, yaml, ini, sql, markdown, graphql, dockerfile, json.
 */
export function ensureMonaco(): Promise<typeof import('monaco-editor')> {
  if (!_promise) {
    _promise = Promise.all([
      import('monaco-editor/esm/vs/editor/editor.api.js'),
      // Pulls in every core editor contrib (find, folding, bracket matching,
      // clipboard, …) as a side effect — the same set editor.all.js provides,
      // but with a typed module (editor.all.js ships no .d.ts). JSON support
      // itself is always needed (JsonEditor's schema validation).
      import('monaco-editor/esm/vs/language/json/monaco.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/python/python.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/go/go.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/java/java.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/css/css.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/less/less.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/html/html.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js'),
    ]).then(([monacoApi, json]) => {
      // `monaco-editor`'s top-level module adds `json`/`css`/`html`/`typescript` namespaces
      // on top of editor.api's `editor`/`languages`/`Uri` — we only load+expose `json`
      // (JsonEditor's schema validation needs `monaco.json.jsonDefaults`).
      const m = { ...monacoApi, json } as unknown as typeof import('monaco-editor')
      // Pin @monaco-editor/react to the bundled package so it never attempts
      // to fetch from cdn.jsdelivr.net (blocked by our CSP: script-src 'self').
      loader.config({ monaco: m })
      return m
    })
  }
  return _promise
}
