'use strict';
// The one list of loopback admin routes the app registers. index.cjs calls
// registerAppAdminRoutes once at boot; tests call it with a recording fake to see
// exactly what the running app serves. Every module is required INSIDE the
// function, so requiring this file has no side effect.

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ onMacrosChanged?: Function, onNeedsYouChanged?: Function }} [deps]
 */
function registerAppAdminRoutes(adminHttp, deps = {}) {
  const scheduler = require('./scheduler.cjs');
  const chatRunner = require('./chatRunner.cjs');
  scheduler.registerAdminRoutes(adminHttp);
  // GET/POST /admin/scheduler/slots — read the slot cap; change it only on the human's verified words.
  require('./lib/scheduler/slotsRoute.cjs').registerSlotsRoute(adminHttp);
  // GET /admin/usage-hold — the 'pause above' hold POST /admin/tasks refuses on, for runners that start claude -p directly (read-only).
  require('./lib/scheduler/usageHoldRoute.cjs').registerUsageHoldRoute(adminHttp);
  require('./lib/prd/prdCreate.cjs').registerAdminRoute(adminHttp, scheduler.remote);
  require('./lib/prd/prdAdminRoutes.cjs').registerAdminRoute(adminHttp, scheduler.remote);
  require('./lib/feedback-remote/projectHomeAdminRoutes.cjs').registerAdminRoute(adminHttp);
  // GET /admin/voices + POST /admin/voices/preview — voice library reads for agents; no route changes a voice.
  require('./lib/project-pages/voiceAdminRoutes.cjs').registerAdminRoute(adminHttp);
  // POST /admin/project-home/videos/script-switch — 'Scripts may run Demo Video', only on the human's verified words.
  require('./lib/project-pages/videoScriptSwitchRoute.cjs').registerVideoScriptSwitchRoute(adminHttp);
  // POST /admin/project-home/videos/run — a project's own script presses Demo Video, only while that switch is on.
  require('./lib/project-pages/videoScriptRunRoute.cjs').registerAdminRoute(adminHttp, {
    startExternalNewSession: chatRunner.startExternalNewSession,
    isTabBusy: chatRunner.isTabBusy,
    listJobRows: () => scheduler.remote.listJobRows(),
  });
  require('./lib/feedback-remote/macroAdminRoutes.cjs').registerAdminRoute(adminHttp, {
    onChanged: deps.onMacrosChanged,
    startExternalNewSession: chatRunner.startExternalNewSession,
    isTabBusy: chatRunner.isTabBusy,
  });
  chatRunner.registerAdminRoute(adminHttp);
  // Outside apps' "Needs you" items (lib/feedback-remote/needsYouStore.cjs); changes broadcast `needsYou:changed`.
  require('./lib/feedback-remote/needsYouAdminRoutes.cjs').registerAdminRoute(adminHttp, {
    onChanged: deps.onNeedsYouChanged,
  });
  // Project-to-project feedback conduit — the app is the only process holding
  // several projects' operations roots open, so it performs the cross-folder
  // write (lib/feedback-remote/crossProjectFeedback.cjs).
  require('./lib/feedback-remote/crossProjectFeedback.cjs').registerAdminRoute(adminHttp);
  // POST /admin/projects/create — a paired service's new local (+ private GitHub) project; broadcasts `projects:created`.
  require('./lib/feedback-remote/projectCreate.cjs').registerAdminRoute(adminHttp);
  // Its return leg: the receiving session answers INTO the Epic that asked
  // (lib/feedback-remote/crossProjectReply.cjs).
  require('./lib/feedback-remote/crossProjectReply.cjs').registerAdminRoute(adminHttp);
  require('./lib/feedback-remote/customerFeedbackAdminRoutes.cjs').registerAdminRoute(adminHttp);
  // Website-feedback widgets + their decrypted inbox, behind the Feedback MCP tools.
  require('./lib/feedback-remote/siteFeedbackAdminRoutes.cjs').registerAdminRoute(adminHttp);
  // Per-project Artifacts store (publish + list), behind the artifact MCP tool.
  require('./lib/epic/artifactAdminRoutes.cjs').registerAdminRoute(adminHttp);
  // Cursor read over the audit log for outside scripts (read-only).
  require('./lib/telemetry/eventsAdminRoutes.cjs').registerAdminRoute(adminHttp);
  // Outside-facing Epic records for scripts/other projects (read-only).
  require('./lib/epic/epicAdminRoutes.cjs').registerAdminRoute(adminHttp, {
    isTabBusy: chatRunner.isTabBusy,
    listJobs: () => scheduler.remote.listJobRows(),
  });
  // Validator quality numbers per project for outside callers (read-only).
  require('./validationQualityHandlers.cjs').registerAdminRoute(adminHttp);
  // Persona roster + per-project effective model/effort for outside apps (read-only).
  require('./lib/persona-macro/agentAdminRoutes.cjs').registerAdminRoute(adminHttp);
  // Task primitive: one headless claude -p run for a project, under the slot cap (POST /admin/tasks).
  require('./lib/tasks/taskAdminRoutes.cjs').registerAdminRoute(adminHttp);
}

module.exports = { registerAppAdminRoutes };
