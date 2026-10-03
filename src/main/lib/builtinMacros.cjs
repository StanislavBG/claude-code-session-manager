'use strict';

/**
 * builtinMacros.cjs — the machine-local Macro library's seeded built-ins.
 *
 * These drive Project Home's one-click actions through the same (agent, tag,
 * prompt) hot-key framework as user-created macros. `macroLibrary.cjs`'s
 * `ensureBuiltins` seeds any entry here that is missing from macros.json, and
 * upgrades an unedited stored copy whose `builtinVersion` is behind this file.
 *
 * Plain Node, no Electron imports.
 */

const BUILTIN_MACROS = Object.freeze([
  Object.freeze({
    id: 'builtin-project-home',
    label: 'Project Home',
    agentName: 'project-home-builder',
    tag: 'project-home-builder',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 1,
    prompt:
      "Generate this project's Project Home page: one self-contained HTML overview (what it is, who it is for, key features, structure, how to run it, key commands), grounded only in what you read in the repository. Save it with a single project_home_write call.",
  }),
  Object.freeze({
    id: 'builtin-demo-video',
    label: 'Demo Video',
    agentName: 'demo-video-builder',
    tag: 'project-home-builder',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 1,
    prompt:
      'Generate a 30-second demo video for this project as one self-contained HTML/JavaScript animation that presents its main goals and key features, grounded only in what you read in the repository. Save it with a single project_demo_video_write call.',
  }),
]);

module.exports = { BUILTIN_MACROS };
