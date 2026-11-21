'use strict';
// Boot wiring for the dead-stdio guard, extracted from index.cjs so it is behavior-testable.
// After the launching terminal closes, writes to the inherited stdout/stderr fail EIO/EPIPE and
// would surface as one uncaughtException per console line. The notice goes to the file logger
// (required lazily: logs.cjs pulls in electron's app), never to the dead stream.
const { guardStdio, createUncaughtReportFilter } = require('./stdioGuard.cjs');

function installBootStdioGuard({ streams, requireLogs = () => require('../../logs.cjs') } = {}) {
  try {
    guardStdio({
      streams,
      log: ({ stream, code }) => {
        try {
          requireLogs().writeLine({ scope: 'main', level: 'warn', message: 'stdio stream dead; output to it is dropped', meta: { stream, code } });
        } catch { /* best-effort */ }
      },
    });
  } catch { /* the guard must never stop boot */ }
}

function createUncaughtExceptionHandler({ reportError, writeLine }) {
  const shouldReport = createUncaughtReportFilter();
  return (err) => {
    if (!shouldReport(err)) return;
    try {
      reportError({ name: 'uncaughtException', msg: err?.message, stack: err?.stack });
    } catch { /* telemetry must never break the existing handling below */ }
    writeLine({ scope: 'main', level: 'error', message: 'uncaughtException', meta: { error: err?.message, stack: err?.stack } });
  };
}

module.exports = { installBootStdioGuard, createUncaughtExceptionHandler };
