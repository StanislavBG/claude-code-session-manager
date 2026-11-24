// Entry of the one-file IIFE bundle (dist/feedback.js).
import { installBuffers } from './buffers';
import { init, resolveConfig } from './host';

/** bilko.run relay — the widget's own traffic, never buffered (architecture/site-feedback.md). */
export const RELAY_BASE = 'https://bilko.run/api/sm-relay';

// As early as possible: errors and failed requests before the reporter opens the widget count.
export const buffers = installBuffers({
  ownUrlPrefixes: [RELAY_BASE, resolveConfig().endpoint],
});

init();
