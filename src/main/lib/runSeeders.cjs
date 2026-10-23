// Runs first-boot seeders one at a time. `claude plugin install` and
// `claude mcp add --scope user` both rewrite Claude's config files; run
// concurrently, one write can drop the other's entry after its marker says done.
// A failing step is logged and never skips the steps after it.

/**
 * @param {Array<{ name: string, run: () => Promise<unknown> }>} steps
 * @returns {Promise<void>}
 */
async function runSeedersSerially(steps) {
  for (const step of steps) {
    try {
      await step.run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[seed] ${step.name} failed: ${message}`);
    }
  }
}

module.exports = { runSeedersSerially };
