'use strict';

/**
 * builtinMacros.cjs — the machine-local Macro library's seeded built-ins.
 *
 * These drive Project Home's one-click actions through the same (agent, tag,
 * prompt) hot-key framework as user-created macros. `macroLibrary.cjs`'s
 * `ensureBuiltins` seeds any entry here that is missing from macros.json, and
 * upgrades a stored copy whose `builtinVersion` is behind this file when it is
 * unedited: `updatedAt === createdAt`, OR its label/agent/tag match and its
 * prompt is one of `priorPrompts` (the editor re-stamps `updatedAt` on every
 * Save, so timestamps alone cannot prove a real edit). Changing a built-in
 * prompt means moving the OLD prompt into `priorPrompts` (oldest first) and
 * bumping `builtinVersion`; `builtinVersion === priorPrompts.length + 1`.
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
    builtinVersion: 2,
    job: Object.freeze({
      estimateMinutes: 20,
      entryKind: 'knowledge',
      artifactPaths: Object.freeze(['session-manager-operations/project-pages/knowledge/{id}/index.html']),
    }),
    priorPrompts: Object.freeze([
      "Generate this project's Project Home page: one self-contained HTML overview (what it is, who it is for, key features, structure, how to run it, key commands), grounded only in what you read in the repository. Save it with a single project_home_write call.",
    ]),
    prompt:
      "Generate ONE Knowledge Page for this project as one self-contained HTML page, grounded only in what you read in the repository. The page is named on a 'Page: <name>' line in the additional instructions: Overview (the default when there is no Page line: what it is, who it is for, key features, structure, how to run it, key commands), How it works (architecture and main flows), FAQ (common questions with answers), or 'Custom topic: <text>' (a page about that topic). Build only that page; other pages stay untouched. Save it with a single project_page_write call, passing pageId equal to the id on the 'Entry id' line.",
  }),
  Object.freeze({
    id: 'builtin-demo-video',
    label: 'Demo Video',
    agentName: 'demo-video-builder',
    tag: 'project-home-builder',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 5,
    job: Object.freeze({
      estimateMinutes: 60,
      entryKind: 'video',
      artifactPaths: Object.freeze(['session-manager-operations/project-pages/videos/{id}/index.html']),
    }),
    priorPrompts: Object.freeze([
      'Generate a 30-second demo video for this project as one self-contained HTML/JavaScript animation that presents its main goals and key features, grounded only in what you read in the repository. Save it with a single project_demo_video_write call.',
      'Generate a 30-second demo video for this project as one self-contained HTML/JavaScript animation that presents its main goals and key features, grounded only in what you read in the repository, with a matching on-device narration track per the audio policy in the persona. Save it with a single project_demo_video_write call.',
      'Generate a 30-second demo video for this project as one self-contained HTML/JavaScript animation that presents its main goals and key features, grounded only in what you read in the repository, with a matching on-device narration track: narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_demo_video_write call passing htmlPath.',
      "Generate a character and cute animated JavaScript video: a 30-second demo of this project as one self-contained HTML/JavaScript animation. Ground everything in what you read in the repository — invent an original mascot character whose look, name and personality match the project's theme and purpose, and tell the project's real goals and key features through it. The character, story and visuals must match the project's theme and purpose as read from the repository. Write the narration script first (hook, problem, solution, three features, call to action), then build every scene to match its line, with fun dynamic elements per the persona. Use the style named on a 'Video style: <name>' line in the additional instructions — Professional, Fun, Animated whiteboard, or Kinetic typography — otherwise pick the one that best fits the project. Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_demo_video_write call passing htmlPath.",
    ]),
    prompt:
      "Generate a character and cute animated JavaScript video: a demo of this project as one self-contained HTML/JavaScript animation, 60 seconds long when the additional instructions carry a 'Video length: 60' line and 30 seconds otherwise. Ground everything in what you read in the repository — invent an original mascot character whose look, name and personality match the project's theme and purpose, and tell the project's real goals and key features through it. The character, story and visuals must match the project's theme and purpose as read from the repository. Write the narration script first (hook, problem, solution, key features, call to action), then build every keystone to match its lines, with the pacing and fun dynamic elements per the persona. Use the style named on a 'Video style: <name>' line in the additional instructions — Professional, Fun, Animated whiteboard, or Kinetic typography — otherwise pick the one that best fits the project. Narrate with Kokoro (kokoro-onnx) using a natural female (af_heart) or male (am_michael) voice per the audio policy in the persona. Save it with a single project_demo_video_write call passing htmlPath.",
  }),
]);

module.exports = { BUILTIN_MACROS };
