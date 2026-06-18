#!/usr/bin/env node
/**
 * ProductBrain MCP server — a THIN transport over the versioned v1 REST API.
 * Each tool is one fetch to an existing /api/v1 endpoint; the REST contract stays
 * canonical (you can always drop to raw HTTP or bring your own LLM). Auth + project
 * come from the client's config (env):
 *
 *   PRODUCTBRAIN_API_KEY     your pb_ API key (required)
 *   PRODUCTBRAIN_PROJECT_ID  default project (optional; tools also take projectId)
 *   PRODUCTBRAIN_API_URL     base URL (default https://productbrain.com/api/v1)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.PRODUCTBRAIN_API_URL || 'https://productbrain.com/api/v1').replace(/\/$/, '');
const API_KEY = process.env.PRODUCTBRAIN_API_KEY;
const DEFAULT_PROJECT = process.env.PRODUCTBRAIN_PROJECT_ID;

if (!API_KEY) {
  console.error('PRODUCTBRAIN_API_KEY is required (your pb_ API key).');
  process.exit(1);
}

type FetchResult = { ok: boolean; status: number; text: string };

async function pb(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Record<string, string | undefined>; body?: unknown; idempotencyKey?: string } = {},
): Promise<FetchResult> {
  const qs = opts.query
    ? '?' + Object.entries(opts.query)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
        .join('&')
    : '';
  const res = await fetch(`${API_URL}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function out(r: FetchResult) {
  return { isError: !r.ok, content: [{ type: 'text' as const, text: r.ok ? r.text : `HTTP ${r.status}: ${r.text}` }] };
}
function needProject(p?: string): string | null {
  return p || DEFAULT_PROJECT || null;
}
const noProject = { isError: true, content: [{ type: 'text' as const, text: 'projectId required: set PRODUCTBRAIN_PROJECT_ID or pass projectId.' }] };

const server = new McpServer({ name: 'productbrain', version: '0.0.1' });

server.registerTool('search', {
  description: 'Semantic search over the ProductBrain plan. Returns nodes ranked by similarity with ancestor paths. Use this FIRST for any lookup — never scan all nodes by label.',
  inputSchema: { q: z.string().describe('natural-language query'), projectId: z.string().optional() },
}, async ({ q, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/search', { query: { q, projectId: pid } }));
});

server.registerTool('list_nodes', {
  description: 'List nodes in a project (bulk read). Optional type (goal|need|approach|job|task) and iteration filters.',
  inputSchema: { projectId: z.string().optional(), type: z.string().optional(), iteration: z.string().optional() },
}, async ({ projectId, type, iteration }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/nodes', { query: { projectId: pid, type, iteration } }));
});

server.registerTool('get_tree', {
  description: 'Get a node in context. relation = context (ancestors+siblings+children, default) | subtree | ancestors | siblings | children.',
  inputSchema: { nodeId: z.string(), relation: z.string().optional(), projectId: z.string().optional() },
}, async ({ nodeId, relation, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/tree', { query: { projectId: pid, nodeId, relation: relation || 'context' } }));
});

server.registerTool('mutate', {
  description: 'Create/update/delete plan nodes and phases. action = add|update|delete|batch|addIteration|updateIteration|deleteIteration|classify. Put the rest of the v1 mutate body in payload (node | nodeId+data | mutations | iteration). Pass idempotencyKey (a UUID) to make a retry safe — a replay returns the original result instead of double-creating.',
  inputSchema: {
    action: z.string(),
    payload: z.record(z.string(), z.any()).describe('rest of the mutate body, e.g. { node: {...} } or { nodeId, data } or { mutations: [...] }'),
    projectId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  },
}, async ({ action, payload, projectId, idempotencyKey }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('POST', '/mutate', { body: { action, projectId: pid, ...(payload || {}) }, idempotencyKey }));
});

server.registerTool('list_iterations', {
  description: 'List phases/iterations. current:true returns the active phase; status:active filters to active.',
  inputSchema: { projectId: z.string().optional(), current: z.boolean().optional(), status: z.string().optional() },
}, async ({ projectId, current, status }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/iterations', { query: { projectId: pid, current: current ? 'true' : undefined, status } }));
});

server.registerTool('run_workflow', {
  description: 'Run the Story-Mapping methodology workflow (flow = add | task-curate | phase-assign). Returns the next prompt + opaque state, or a terminal changeset with a focus hint. Put the v1 workflow body in body.',
  inputSchema: { body: z.record(z.string(), z.any()).describe('workflow request: { flow, state?, response? }'), projectId: z.string().optional() },
}, async ({ body, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('POST', '/workflow', { body: { projectId: pid, ...(body || {}) } }));
});

server.registerTool('set_view', {
  description: 'Drive the live canvas. command = { type: setViewMode|selectIteration|zoomToNode|expandNode|collapseNode|focusGoals, ... }.',
  inputSchema: { command: z.record(z.string(), z.any()), projectId: z.string().optional() },
}, async ({ command, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('POST', '/view-command', { body: { projectId: pid, command } }));
});

server.registerTool('read_view', {
  description: 'Read what the user is looking at now: view_mode, selected_iteration, expanded_nodes, focused_goals, selected_node.',
  inputSchema: { projectId: z.string().optional() },
}, async ({ projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/view-state', { query: { projectId: pid } }));
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`ProductBrain MCP server on stdio → ${API_URL}`);
