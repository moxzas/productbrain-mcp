#!/usr/bin/env node
// MCP smoke test. Drives the BUILT server (dist/server.js) over stdio the way
// a real client does and asserts the tool surface plus one handler that once
// failed on every call for three months because nothing exercised it
// (get_tree sent relation= to an endpoint that only reads direction=; review
// finding reads-1). No network: the API URL points at a closed port and the
// handler check replaces globalThis.fetch via scripts/mock-fetch.mjs.
//
//   cd mcp && npm run build && npm run smoke
//
// Exit 0 on success, 1 with a "SMOKE FAIL:" line on any failure. A hard
// timeout kills the child processes so this can never hang CI.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARD_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 60_000;
const EXPECTED_TOOL_COUNT = 26; // 26th: get_changelog (plan history)
const REQUIRED_TOOLS = ['get_tree', 'search', 'mutate', 'run_workflow'];
const SERVER_ENV = {
  ...process.env,
  PRODUCTBRAIN_API_KEY: 'pb_smoke_dummy',
  // Port 9 (discard) on loopback: nothing listens, nothing is bound, and a
  // stray real fetch fails fast with ECONNREFUSED instead of reaching staging.
  PRODUCTBRAIN_API_URL: 'http://127.0.0.1:9/api/v1',
};

const children = new Set();
function killAll() {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  killAll();
  process.exit(1);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
const hardTimer = setTimeout(() => fail(`hard timeout after ${HARD_TIMEOUT_MS} ms`), HARD_TIMEOUT_MS);

// Minimal MCP stdio client: newline-delimited JSON-RPC 2.0 on stdin/stdout.
class McpClient {
  constructor(label, nodeArgs) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.child = spawn(process.execPath, nodeArgs, { cwd: MCP_DIR, env: SERVER_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(this.child);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => process.stderr.write(`[${label} stderr] ${chunk}`));
    this.child.on('exit', (code, signal) => {
      children.delete(this.child);
      for (const { reject } of this.pending.values()) {
        reject(new Error(`${label}: server exited (code ${code}, signal ${signal}) before replying`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(`${this.label}: non-JSON line on stdout: ${line}`); }
      if (message.id == null || !this.pending.has(message.id)) continue; // server notification, ignore
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${this.label}: JSON-RPC error ${message.error.code}: ${message.error.message}`));
      else resolve(message.result);
    }
  }

  send(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'productbrain-mcp-smoke', version: '0.0.0' },
    });
    this.notify('notifications/initialized');
    return result;
  }

  async close() {
    this.child.stdin.end();
    const killer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    await new Promise((resolve) => (this.child.exitCode != null ? resolve() : this.child.once('exit', resolve)));
    clearTimeout(killer);
  }
}

async function checkToolSurface() {
  console.log('--- 1. tool surface (real server, real fetch, closed port) ---');
  const client = new McpClient('server', ['dist/server.js']);
  const init = await client.initialize();
  console.log(`initialize: server ${init.serverInfo?.name} ${init.serverInfo?.version}, protocol ${init.protocolVersion}`);
  const { tools } = await client.request('tools/list', {});
  const names = tools.map((t) => t.name);
  console.log(`tools/list: ${names.length} tools`);
  console.log(names.join(', '));
  assert(names.length === EXPECTED_TOOL_COUNT, `expected ${EXPECTED_TOOL_COUNT} tools, got ${names.length}`);
  for (const required of REQUIRED_TOOLS) {
    assert(names.includes(required), `required tool missing from tools/list: ${required}`);
  }
  assert(new Set(names).size === names.length, 'duplicate tool names in tools/list');
  await client.close();
  console.log('tool surface OK');
}

async function checkGetTreeHandler() {
  console.log('--- 2. get_tree handler (fetch replaced by scripts/mock-fetch.mjs) ---');
  const client = new McpClient('mocked', ['--import', './scripts/mock-fetch.mjs', 'dist/server.js']);
  await client.initialize();

  async function callGetTree(args) {
    const result = await client.request('tools/call', { name: 'get_tree', arguments: args });
    const text = (result.content || []).map((c) => c.text ?? '').join('');
    console.log(`get_tree ${JSON.stringify(args)} -> isError=${result.isError === true} text=${text}`);
    return { result, text };
  }

  const context = await callGetTree({ nodeId: 'goal-1', relation: 'context', projectId: 'smoke' });
  assert(context.result.isError !== true, 'get_tree(context) returned isError');
  assert(context.text.includes('/tree?'), 'get_tree(context) did not call /tree');
  assert(context.text.includes('direction=context'), 'get_tree(context) did not send direction=context');
  assert(context.text.includes('nodeId=goal-1'), 'get_tree(context) did not send nodeId=goal-1');
  assert(context.text.includes('projectId=smoke'), 'get_tree(context) did not send projectId=smoke');
  assert(!context.text.includes('relation='), 'get_tree(context) still sends relation= (reads-1 regression)');
  const echoed = JSON.parse(context.text);
  assert(echoed.method === 'GET', `get_tree used ${echoed.method}, expected GET`);
  assert(echoed.mockUrl.startsWith('http://127.0.0.1:9/api/v1/tree?'), `get_tree hit an unexpected URL: ${echoed.mockUrl}`);

  // The tool vocabulary maps onto the endpoint's direction param (TREE_DIRECTION in src/server.ts).
  const subtree = await callGetTree({ nodeId: 'goal-1', relation: 'subtree', projectId: 'smoke' });
  assert(subtree.result.isError !== true, 'get_tree(subtree) returned isError');
  assert(subtree.text.includes('direction=down'), 'get_tree(subtree) did not map to direction=down');
  assert(!subtree.text.includes('relation='), 'get_tree(subtree) still sends relation=');

  const bogus = await callGetTree({ nodeId: 'goal-1', relation: 'sideways', projectId: 'smoke' });
  assert(bogus.result.isError === true, 'get_tree(sideways) should be a tool error, not a fetch');
  assert(bogus.text.includes('relation must be one of'), 'get_tree(sideways) error text does not list the accepted relations');

  await client.close();
  console.log('get_tree handler OK');
}

try {
  await checkToolSurface();
  await checkGetTreeHandler();
} catch (err) {
  fail(err && err.stack ? err.stack : String(err));
}
clearTimeout(hardTimer);
killAll();
console.log('SMOKE OK');
