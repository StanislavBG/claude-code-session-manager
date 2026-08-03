// Single esbuild entry point for the Project Pages CLI scripts that need
// pure logic (no React) — validation, plus the component library metadata.
// Kept separate from render.tsx's own bundle
// (scripts/build-project-pages-renderer.mjs) because that one externals
// react/react-dom for renderToStaticMarkup; this bundle has no such
// dependency and stays a plain, tiny CJS module. Extended in place as new
// logic-only CLIs are added rather than growing a third bundle per script.
export { validateProjectPageSummary } from './summaryValidate';
export { LENS_LIBRARY, LENS_ORDER } from './library';
