# Validation: unit-suite-fails-when-packages-drift

Base: 18f804d7. Landed commit: b6159625 (2 files: the test, tests/README.md). Self-review used (no background reviews run).

## unit-suite-fails-when-packages-drift — VERIFIED

- AC1: installedPackagesMatch.test.cjs:123-133 reads package.json dependencies + devDependencies, reads node_modules/<name>/package.json (:113-121); missing → `null` → fail (:95, :130).
- AC2: formatMismatches :135-146 lists `name: declared <range>, installed <ver|missing>` per package and ends with "Fix: run npm install in the main checkout …"; asserted by the test at :187-195.
- AC3: parseRange :65-86 handles exact, ^, ~, >=, >, <=, <, =; anything else returns null → `unreadable-range` → the package fails with its name (:94, :137). Test at :182-186 covers `||`, `1.x`, `latest`, hyphen, `github:`, `*`.
- AC4: unit cases at :149-161: 3.25.76 vs ^4.6.7 fails, 4.6.7 vs ^4.6.7 passes, 42.11.10 vs exact 42.11.18 fails, missing fails. The real-tree test (:198) passes today. Not proved by editing node_modules, as instructed.
- AC5: tests/README.md gained two lines (under Environment gotchas) saying what it guards and what to do on failure.

Gate (re-run): `npx vitest run src/main/__tests__/installedPackagesMatch.test.cjs` → 10 passed; `npm run lint` exit 0; `npm run typecheck` exit 0.

## Coverage record

Direct dependencies covered: 43 (6 dependencies + 37 devDependencies; no optional or peer sections exist).
- dependencies: chokidar, electron, electron-updater, node-pty, ws, zod
- devDependencies: @huggingface/transformers, @monaco-editor/react, @playwright/test, @ricky0123/vad-web, @tiptap/extension-link, @tiptap/react, @tiptap/starter-kit, @types/node, @types/react, @types/react-dom, @vitejs/plugin-react, @vitest/coverage-v8, @xterm/addon-fit, @xterm/addon-web-links, @xterm/xterm, autoprefixer, concurrently, dockview-react, dompurify, electron-builder, esbuild, jsdom, marked, monaco-editor, onnxruntime-web, postcss, react, react-dom, react-force-graph-2d, sharp, tailwindcss, tiptap-markdown, typescript, vite, vitest, wait-on, zustand

Range forms in package.json today: 4 exact, 39 caret; zero tilde, comparison, `||`, x-range, tag or URL. Every form in use is handled; any other form fails loudly, so none passes silently. Scoped names resolve via `name.split('/')` (:114).

## Findings

Critical: none
Important: none
Minor: none
