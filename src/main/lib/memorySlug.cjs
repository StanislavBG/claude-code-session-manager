'use strict';

/**
 * Shared workspace-memory filename regex. memoryTool.cjs (CRUD), memoryAggregate.cjs
 * (clustering), and ipcSchemas.cjs (IPC validation) all gate on the same slug shape —
 * single source of truth so the three don't drift.
 */
const MEMORY_SLUG_RE = /^[a-z0-9-_]+\.md$/;

module.exports = { MEMORY_SLUG_RE };
