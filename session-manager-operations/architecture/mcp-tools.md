# MCP tools — reference

Every tool the `session-manager-scheduler` MCP server offers, with its group, required args and a one-line summary.

The table below is generated from `src/main/lib/mcpToolCatalog.cjs` (and each tool's input schema in
`scripts/scheduler-mcp-server.cjs`) by `npm run readme:build`. Do not edit it by hand: `npm run lint:readme`
fails when it is out of date. For one tool in depth, call `session_manager_help` with `tool`.

<!-- gen:mcp-tools -->
| Tool | Group | Required args | What it does |
| --- | --- | --- | --- |
| `scheduler_reset_job` | scheduler | `slug` | Reset a stuck job so the scheduler runs it again. |
| `scheduler_pause` | scheduler | — | Pause new job starts for every project on this machine. |
| `scheduler_resume` | scheduler | — | Lift a scheduler pause so jobs start again. |
| `scheduler_list_jobs` | scheduler | — | List queued, running and finished jobs on this machine. |
| `scheduler_create_prd` | scheduler | `title`, `goal`, `acceptanceCriteria`, `implementationNotes`, `gate`, `files` | Queue one PRD (a written work order) in an Epic a human approved. |
| `scheduler_create_prds` | scheduler | `prds` | Queue a whole plan of PRDs in one all-or-nothing call. |
| `scheduler_release_plan` | scheduler | `epicId`, `validateSlug` | Release a reviewed plan, or request its single re-review. |
| `scheduler_list_prds` | scheduler | — | List PRDs and their job status, by project, Epic or status. |
| `scheduler_get_prd` | scheduler | `slug` | Read one PRD in full, with its frontmatter. |
| `scheduler_update_prd` | scheduler | `slug` | Edit a PRD that has not run yet or has stopped. |
| `scheduler_archive_prd` | scheduler | `slugs` | Archive PRDs that are done or no longer needed. |
| `scheduler_cancel_job` | scheduler | `slug` | Cancel a job that has not finished. |
| `scheduler_dismiss_cancelled` | scheduler | `slug` | Clear a cancelled job out of the queue. |
| `scheduler_retag_prd` | scheduler | `items` | Change a PRD's group number or time estimate. |
| `chat_send_prompt` | chat | `tabId`, `prompt` | Send a prompt to a session tab that is already open. |
| `feedback_list_projects` | feedback | — | List the other projects on this machine that can take feedback. |
| `feedback_open_session` | feedback | `toCwd`, `fromCwd`, `title`, `motivation`, `acceptanceCriteria`, `body` | Hand a finding to another project as a proposed session there. |
| `feedback_reply` | feedback | `message`, `outcome` | Answer the project that sent this session its feedback. |
| `service_pair_local` | feedback | `stateDir`, `name`, `homeCwd`, `tools` | Pair a same-machine service with Session Manager, no window step. |
| `project_home_write` | project-home | `html` | Write the Overview page of Project Home (same as project_page_write). |
| `project_page_write` | project-home | `pageId`, `title`, one of `html` / `htmlPath` | Write one HTML knowledge page for Project Home. |
| `project_matrix_read` | project-home | — | Read the saved competitor feature matrix and its schema. |
| `project_matrix_write` | project-home | one of `matrix` / `matrixPath` | Save the competitor feature matrix as one JSON object. |
| `project_video_write` | project-home | `videoId`, `title`, `kind`, `lengthS`, `meta`, one of `html` / `htmlPath` | Save one self-contained HTML video for Project Home. |
| `project_demo_video_write` | project-home | one of `html` / `htmlPath` | Save a 30-second or 1-minute demo video (same as project_video_write). |
| `project_character_write` | project-home | `json`, one of `js` / `jsPath` | Save the reusable character used in this project's videos. |
| `project_video_review_write` | project-home | `videoId`, `text`, `imagePaths` | Save a script and images for a human to review a video. |
| `project_video_outcome_write` | project-home | `videoId`, `outcome`, `text` | Record that a video run ended with no video on purpose. |
| `voice_list` | project-home | — | List the voices this project can use for speech. |
| `voice_preview` | project-home | `voiceId`, `text` | Hear one voice say a short line and get the clip path. |
| `customer_feedback_list` | customer-feedback | — | List feedback that users sent to the owner's inbox. |
| `customer_feedback_set_status` | customer-feedback | `id`, `status` | Set the status of one feedback item, with an optional note. |
| `customer_feedback_get` | customer-feedback | `id`, `source` | Read one website feedback report in full, with its image paths. |
| `customer_feedback_submit` | customer-feedback | `goal`, `description`, `tag` | Send feedback about Session Manager to its maintainers. |
| `feedback_widget_create` | feedback-widget | `label`, `allowedOrigins` | Make a feedback widget for a website and get its snippet. |
| `feedback_widget_list` | feedback-widget | — | List this project's website feedback widgets. |
| `feedback_widget_update` | feedback-widget | `boxId` | Change a feedback widget label, sites, or pause it. |
| `feedback_widget_delete` | feedback-widget | `boxId` | Delete a website feedback widget for good. |
| `feedback_widget_snippet` | feedback-widget | `boxId` | Get the one-line snippet for a feedback widget. |
| `macro_list` | macros | — | List this project's saved one-click macros. |
| `macro_save` | macros | `label`, `agentName`, `tag`, `prompt` | Create or change a saved one-click macro (agent, mission, prompt). |
| `macro_delete` | macros | `id` | Delete one saved macro. |
| `epic_list` | epics | `cwd` | List the open sessions of one project and what state each is in. |
| `epic_get` | epics | `cwd`, one of `id` / `externalRef` | Read one session by its id or by the outside reference it was opened with. |
| `agent_list` | agents | — | List the agents you can launch and the model each one runs on. |
| `task_list` | tasks | `cwd` | List a project's Tasks with their status, model and cost. |
| `task_get` | tasks | `cwd`, `id` | Read one Task in full, with its prompt and output. |
| `task_switch_set` | tasks | `enabled`, `humanRequestQuote` | Turn Scripts may run Tasks on or off when the human asks. |
| `video_script_switch_set` | project-home | `enabled`, `humanRequestQuote` | Turn Scripts may run Demo Video on or off when the human asks. |
| `scheduler_slots_get` | scheduler | — | See how many sessions may run at once and how many are busy. |
| `usage_hold_get` | scheduler | — | See if automatic runs are on hold. |
| `scheduler_slots_set` | scheduler | `cap`, `quote` | Raise or lower the session limit when the human asks. |
| `session_manager_help` | help | — | Start here: list every tool, or explain one tool or recipe. |
| `artifact_publish` | artifacts | `path` | Publish a file for review. |
| `artifact_list` | artifacts | — | List stored artifacts. |
<!-- /gen:mcp-tools -->
