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
    builtinVersion: 4,
    prompt:
      "Generate a character and cute animated JavaScript video: a 30-second demo of this project as one self-contained HTML/JavaScript animation. Ground everything in what you read in the repository — invent an original mascot character whose look, name and personality match the project's theme and purpose, and tell the project's real goals and key features through it. The character, story and visuals must match the project's theme and purpose as read from the repository. Write the narration script first (hook, problem, solution, three features, call to action), then build every scene to match its line, with fun dynamic elements per the persona. Use the style named on a 'Video style: <name>' line in the additional instructions — Professional, Fun, Animated whiteboard, or Kinetic typography — otherwise pick the one that best fits the project. Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_demo_video_write call passing htmlPath.",
  }),
]);

module.exports = { BUILTIN_MACROS };
