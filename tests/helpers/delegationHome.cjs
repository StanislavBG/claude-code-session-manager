'use strict';

/**
 * delegationHome.cjs — fixture user-scope state for the delegation chain
 * (scheduler MCP registration, dev plugin install, dev-lead persona), so tests
 * never depend on the real home. Shared by delegationReadiness.test.cjs and
 * health-delegation-chain.test.cjs.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const REQUIRED_TOOLS = ['scheduler_create_prd', 'session_manager_help'];

async function writeJson(absPath, value) {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, JSON.stringify(value), 'utf8');
}

/** A stub stdio MCP server: answers initialize + tools/list over stdin/stdout. */
async function writeAnsweringStub(dir, { toolNames = REQUIRED_TOOLS, countFile = null } = {}) {
  const scriptPath = path.join(dir, 'stub-mcp-server.cjs');
  const body = `
    'use strict';
    const readline = require('node:readline');
    ${countFile ? `require('node:fs').appendFileSync(${JSON.stringify(countFile)}, 'x\\n');` : ''}
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '1' } } }) + '\\n');
      } else if (msg.id === 2) {
        const tools = ${JSON.stringify(toolNames)}.map((name) => ({ name }));
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }) + '\\n');
      }
    });
  `;
  await fsp.writeFile(scriptPath, body, 'utf8');
  return scriptPath;
}

async function writeDevPluginInstall(homeDir) {
  const installPath = path.join(homeDir, '.claude', 'plugins', 'cache', 'session-manager', 'session-manager-dev', '0.0.1');
  const marketplace = path.join(homeDir, 'marketplace-src');
  await fsp.mkdir(path.join(installPath, 'skills', 'develop'), { recursive: true });
  await fsp.writeFile(path.join(installPath, 'skills', 'develop', 'SKILL.md'), '# develop', 'utf8');
  await fsp.mkdir(marketplace, { recursive: true });
  await writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'session-manager-dev@session-manager': [{ scope: 'user', installPath, version: '0.0.1' }] },
  });
  await writeJson(path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json'), {
    'session-manager': { source: { source: 'directory', path: marketplace }, installLocation: marketplace },
  });
  return { installPath, marketplace };
}

/** Seed homeDir with everything the user-scope delegation checks read. */
async function seedDelegationHome(homeDir) {
  const scriptPath = await writeAnsweringStub(homeDir);
  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: { 'session-manager-scheduler': { type: 'stdio', command: 'node', args: [scriptPath] } },
  });
  await writeJson(path.join(homeDir, '.claude', 'settings.json'), {
    enabledPlugins: { 'session-manager-dev@session-manager': true },
  });
  await writeDevPluginInstall(homeDir);
  await fsp.mkdir(path.join(homeDir, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(homeDir, '.claude', 'agents', 'dev-lead.md'), '# dev-lead', 'utf8');
  return { scriptPath };
}

module.exports = { REQUIRED_TOOLS, writeAnsweringStub, writeDevPluginInstall, seedDelegationHome };
