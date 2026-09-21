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

const MCP_VERSION = '0.1.0';
const API_URL = (process.env.PRODUCTBRAIN_API_URL || 'https://productbrain.com/api/v1').replace(/\/$/, '');
const API_KEY = process.env.PRODUCTBRAIN_API_KEY;
const DEFAULT_PROJECT = process.env.PRODUCTBRAIN_PROJECT_ID;

if (!API_KEY) {
  console.error('PRODUCTBRAIN_API_KEY is required (your pb_ API key).');
  process.exit(1);
}

type FetchResult = { ok: boolean; status: number; text: string };

async function pb(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
      // Lets the server tell MCP traffic from raw REST calls (the monthly seed
      // report counts it). Version tracks package.json.
      'User-Agent': `productbrain-mcp/${MCP_VERSION}`,
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

const server = new McpServer({ name: 'productbrain', version: MCP_VERSION });

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

// The tool vocabulary (relation) is mapped onto the endpoint's `direction`
// query param (up | down | lateral | context). Before this map existed the shim
// sent `relation=` verbatim, which /tree rejects with 400, so the tool could
// never succeed. Both vocabularies are accepted.
const TREE_DIRECTION: Record<string, string> = {
  context: 'context', ancestors: 'up', up: 'up', subtree: 'down', children: 'down', down: 'down', siblings: 'lateral', lateral: 'lateral',
};
server.registerTool('get_tree', {
  description: 'Get a node in context. relation = context (ancestors+siblings+children, default) | ancestors | subtree | siblings. The endpoint\'s own names (up | down | lateral | context) are accepted too. There is no children-only view: subtree/children both return the full subtree.',
  inputSchema: { nodeId: z.string(), relation: z.string().optional(), projectId: z.string().optional() },
}, async ({ nodeId, relation, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  const direction = TREE_DIRECTION[(relation || 'context').toLowerCase()];
  if (!direction) {
    return { isError: true, content: [{ type: 'text' as const, text: `relation must be one of: ${Object.keys(TREE_DIRECTION).join(', ')}` }] };
  }
  return out(await pb('GET', '/tree', { query: { projectId: pid, nodeId, direction } }));
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

// ─── Webhooks (GET/POST/PATCH/DELETE /api/v1/webhooks) ───────────────────────
// Outbound change notifications. The secret is shown ONCE on create and once
// more on rotate — the `_meta._tip` the API returns says so; it passes through
// verbatim, same as every other tool here.

server.registerTool('list_webhooks', {
  description: 'List the outbound webhooks registered on a project (secrets are never returned). Shows lastStatus/lastDeliveryAt so you can spot a failing receiver.',
  inputSchema: { projectId: z.string().optional() },
}, async ({ projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/webhooks', { query: { projectId: pid } }));
});

server.registerTool('create_webhook', {
  description: 'Register an outbound webhook. events defaults to all (node.added|updated|deleted, iteration.added|updated|deleted). Returns the signing secret ONCE — store it immediately.',
  inputSchema: {
    url: z.string().describe('https URL; must be publicly routable'),
    events: z.array(z.string()).optional(),
    projectId: z.string().optional(),
  },
}, async ({ url, events, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('POST', '/webhooks', { body: { projectId: pid, url, ...(events && { events }) } }));
});

server.registerTool('update_webhook', {
  description: 'Reconfigure a webhook in place (same id). Change url and/or events without minting a new secret, or pass rotateSecret:true to mint a new one (returned once). Prefer this over delete+recreate, which breaks the receiver.',
  inputSchema: {
    id: z.string(),
    url: z.string().optional(),
    events: z.array(z.string()).optional(),
    rotateSecret: z.boolean().optional(),
    projectId: z.string().optional(),
  },
}, async ({ id, url, events, rotateSecret, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('PATCH', '/webhooks', {
    body: { projectId: pid, id, ...(url !== undefined && { url }), ...(events !== undefined && { events }), ...(rotateSecret !== undefined && { rotateSecret }) },
  }));
});

server.registerTool('delete_webhook', {
  description: 'Remove a webhook registration. Irreversible — the secret is gone; re-registering mints a new one.',
  inputSchema: { id: z.string(), projectId: z.string().optional() },
}, async ({ id, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('DELETE', '/webhooks', { query: { projectId: pid, id } }));
});

// ─── Share links (POST/GET/DELETE /api/v1/share) ─────────────────────────────

server.registerTool('create_share_link', {
  description: 'Mint a PUBLIC read-only link to the project view. Pass expiresInDays for a TTL (otherwise it never expires) and settings (e.g. { includedGoalIds: [...] }) to scope it. Treat the returned token as a secret.',
  inputSchema: {
    settings: z.record(z.string(), z.any()).optional(),
    expiresInDays: z.number().optional(),
    projectId: z.string().optional(),
  },
}, async ({ settings, expiresInDays, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('POST', '/share', {
    body: { projectId: pid, ...(settings !== undefined && { settings }), ...(expiresInDays !== undefined && { expiresInDays }) },
  }));
});

server.registerTool('list_share_links', {
  description: 'List every share token minted for a project, with createdAt/expiresAt/revokedAt and an `active` flag. The audit half of the share loop.',
  inputSchema: { projectId: z.string().optional() },
}, async ({ projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/share', { query: { projectId: pid } }));
});

server.registerTool('revoke_share_link', {
  description: 'Revoke a share token. The public link stops serving within ~30s (edge cache); the record dies immediately.',
  inputSchema: { token: z.string(), projectId: z.string().optional() },
}, async ({ token, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('DELETE', '/share', { query: { projectId: pid, token } }));
});

// ─── Members / seats (GET/POST/DELETE /api/v1/members) ───────────────────────

server.registerTool('list_members', {
  description: 'List the members (human and agent seats) on a project, plus the owner. Any member can read this.',
  inputSchema: { projectId: z.string().optional() },
}, async ({ projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/members', { query: { projectId: pid } }));
});

server.registerTool('add_agent_seat', {
  description: 'Mint an agent seat on a project (owner only, Team tier). Returns a pb_ API key ONCE — store it now, there is no retrieval.',
  inputSchema: {
    name: z.string().describe('display name for the agent seat'),
    projectId: z.string().optional(),
  },
}, async ({ name, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('POST', '/members', { body: { projectId: pid, agent: { name } } }));
});

server.registerTool('invite_contributor', {
  description: 'Invite a guest contributor by email to one or more projects you own (owner only, Team tier). Sends a passwordless Clerk invite; one seat regardless of project count.',
  inputSchema: {
    email: z.string(),
    projectIds: z.array(z.string()).describe('projects to scope the contributor to — you must own all of them'),
  },
}, async ({ email, projectIds }) => {
  return out(await pb('POST', '/members', { body: { contributor: { email, projectIds } } }));
});

server.registerTool('revoke_member', {
  description: 'Remove a member (human or agent) from a project. Removing an agent seat revokes its API key once its last membership is gone.',
  inputSchema: { userId: z.string(), projectId: z.string().optional() },
}, async ({ userId, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('DELETE', '/members', { query: { projectId: pid, userId } }));
});

// ─── Projects (GET/PATCH /api/v1/projects; create+rename via /mutate) ────────
// create/rename are mutate actions server-side, not REST verbs on /projects —
// the shim hides that split so an agent has one tool per operation.

server.registerTool('list_projects', {
  description: 'List the projects you own or are a member of. Archived ones are hidden unless includeArchived is true.',
  inputSchema: { includeArchived: z.boolean().optional() },
}, async ({ includeArchived }) => {
  return out(await pb('GET', '/projects', { query: { includeArchived: includeArchived ? 'true' : undefined } }));
});

server.registerTool('create_project', {
  description: 'Create a project you own and seed its system "Later" phase, so nodes can be added immediately. id defaults to a slug of the name.',
  inputSchema: {
    name: z.string(),
    id: z.string().optional().describe('2-63 chars, lowercase letters/numbers/dashes'),
  },
  // No idempotencyKey here, deliberately: /api/v1/mutate returns from its
  // addProject branch before it ever reads the Idempotency-Key header, so the
  // argument would advertise retry-safety the server does not provide. Pass an
  // explicit `id` instead — a repeat then fails cleanly on the existing project
  // rather than creating a second one.
}, async ({ name, id }) => {
  return out(await pb('POST', '/mutate', { body: { action: 'addProject', project: { name, ...(id && { id }) } } }));
});

server.registerTool('rename_project', {
  description: 'Change a project\'s display name (owner only). The id is immutable — keep using the same projectId afterwards.',
  inputSchema: { name: z.string(), projectId: z.string().optional() },
}, async ({ name, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('POST', '/mutate', { body: { action: 'renameProject', projectId: pid, name } }));
});

server.registerTool('archive_project', {
  description: 'Archive (archived:true) or unarchive (false) a project you own. Archiving hides it from list_projects without deleting anything — reversible, unlike delete.',
  inputSchema: { archived: z.boolean(), projectId: z.string().optional() },
}, async ({ archived, projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('PATCH', '/projects', { body: { projectId: pid, archived } }));
});

// ─── Export (GET /api/v1/export-okf) ─────────────────────────────────────────

server.registerTool('export_okf', {
  description: 'Serialize the whole plan to a portable OKF file bundle (markdown with frontmatter, one file per node). Use when you want the plan as files — for a repo, a diff, or handing it to a tool that reads markdown — rather than as JSON.',
  inputSchema: { projectId: z.string().optional() },
}, async ({ projectId }) => {
  const pid = needProject(projectId); if (!pid) return noProject;
  return out(await pb('GET', '/export-okf', { query: { projectId: pid } }));
});

// ─── Tier / budget (GET /api/v1/tier-status) ─────────────────────────────────

server.registerTool('tier_status', {
  description: 'Read your own tier, API access, AI-credit balance, seat/project/node limits and billing period. Check this BEFORE a large run so you self-throttle instead of discovering a 402 mid-flight.',
  // inputSchema deliberately OMITTED rather than `{}`. The SDK turns an empty
  // shape into z.object({}) and validates request.params.arguments — which the
  // MCP spec allows a client to leave out entirely on a zero-argument call. With
  // `{}` such a call fails with InvalidParams ("expected object, received
  // undefined") instead of running. Omitting it skips validation.
}, async () => {
  return out(await pb('GET', '/tier-status'));
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`ProductBrain MCP server on stdio → ${API_URL}`);
