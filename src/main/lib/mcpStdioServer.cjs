/**
 * mcpStdioServer.cjs — zero-dependency MCP server over newline-delimited
 * JSON-RPC 2.0 on stdio. Implements only what the scheduler MCP server uses:
 * initialize, ping, tools/list, tools/call. Stdout carries protocol messages
 * only; diagnostics go to stderr.
 */
'use strict';

// Copied verbatim from @modelcontextprotocol/sdk dist/cjs/types.js
// (LATEST_PROTOCOL_VERSION first).
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * @param {{
 *   name: string,
 *   version: string,
 *   listTools: () => any[] | Promise<any[]>,
 *   callTool: (params: any) => Promise<any>,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 * }} opts
 */
function createStdioServer({ name, version, listTools, callTool, input = process.stdin, output = process.stdout }) {
  let buffer = '';
  let started = false;
  let closed = false;

  function send(msg) {
    if (closed) return;
    try {
      output.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      process.stderr.write(`[mcpStdioServer] write failed: ${err && err.message}\n`);
    }
  }

  function sendError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function dispatch(msg) {
    const hasId = msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
    if (!hasId) return; // notification (or unusable message): never reply
    const { id, method, params } = msg;
    try {
      let result;
      switch (method) {
        case 'initialize': {
          const requested = params && params.protocolVersion;
          result = {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name, version },
          };
          break;
        }
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: await listTools() };
          break;
        case 'tools/call':
          result = await callTool(params);
          break;
        default:
          sendError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
          return;
      }
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      sendError(id, INTERNAL_ERROR, err && err.message ? err.message : String(err));
    }
  }

  function handleLine(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      sendError(null, PARSE_ERROR, 'Parse error');
      return;
    }
    dispatch(msg).catch((err) => {
      process.stderr.write(`[mcpStdioServer] dispatch failed: ${err && err.message}\n`);
    });
  }

  function onData(chunk) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  }

  function onEnd() {
    close();
  }

  function start() {
    if (started || closed) return;
    started = true;
    input.on('data', onData);
    input.on('end', onEnd);
  }

  function close() {
    if (closed) return;
    closed = true;
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    buffer = '';
  }

  return { start, close };
}

module.exports = { createStdioServer, SUPPORTED_PROTOCOL_VERSIONS };
