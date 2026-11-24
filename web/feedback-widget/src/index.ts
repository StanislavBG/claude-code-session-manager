// Entry of the one-file IIFE bundle (dist/feedback.js).
import { installBuffers } from './buffers';
import { watchFontResources } from './fontProbe';
import { getHost, getReporter, init, resolveConfig, type FeedbackApi } from './host';
import { startOutbox } from './outbox';
import { mountApp } from './ui/App';

/** bilko.run relay — the widget's own traffic, never buffered (architecture/site-feedback.md). */
export const RELAY_BASE = 'https://bilko.run/api/sm-relay';

// As early as possible: errors and failed requests before the reporter opens the widget count.
export const buffers = installBuffers({
  ownUrlPrefixes: [RELAY_BASE, resolveConfig().endpoint],
});
// Records font URLs from Resource Timing so a capture can match FontFace-API faces to files.
watchFontResources();

/** Mounts App inside host.ts's shadow root and wires window.Feedback to it. */
export function start(): boolean {
  if (!init()) return false;
  const host = getHost();
  const api = window.Feedback;
  if (!host || !api) return false;
  const app = mountApp({
    config: host.config,
    hostEl: host.host,
    shadow: host.shadow,
    buffers,
    user: getReporter(),
  });
  const wired: FeedbackApi = {
    open: () => app.open(),
    close: () => app.close(),
    identify(user) {
      api.identify(user); // host.ts normalises and stores the reporter
      app.identify(getReporter());
    },
    version: api.version,
  };
  window.Feedback = wired;
  return true;
}

// Script load: retry anything a previous page left in the outbox, whether or not the widget renders.
startOutbox();
start();
