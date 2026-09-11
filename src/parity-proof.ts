/**
 * Parity proof for the MCP shims added alongside the original 8 tools
 * (webhooks, share links, members/seats, projects, tier status).
 *
 * Sibling of spike-proof.ts: that one proved the transport works at all, this
 * one exercises every NEW tool once against a real deployment and prints what
 * came back. Run it against the agent's OWN staging sandbox — it creates and
 * then removes a throwaway project, webhook and share link:
 *
 *   PRODUCTBRAIN_API_URL=https://staging.productbrain.com/api/v1 \
 *   PRODUCTBRAIN_API_KEY=<AGENT_STAGING_API_KEY> \
 *   npx tsx src/parity-proof.ts
 *
 * Tier-gated tools (agent seats, contributor invites) are Team-tier only. On a
 * Builder key they return 403 team_tier_required, and that is the pass condition
 * for them. Be clear about what that does and doesn't prove: it shows the shim
 * reached the right route and passed the error plus its `_meta` coaching back
 * verbatim — it does NOT validate the request body, because the tier gate runs
 * before the body is read. A wrong body shape on those two tools would still
 * pass here. Run this with a Team key to check them properly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const { PRODUCTBRAIN_API_KEY } = process.env;
if (!PRODUCTBRAIN_API_KEY) {
  console.error('Set PRODUCTBRAIN_API_KEY (and optionally PRODUCTBRAIN_API_URL).');
  process.exit(1);
}

const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', serverPath], env });
const client = new Client({ name: 'parity-proof', version: '0.0.1' });
await client.connect(transport);

const text = (r: unknown): string => {
  const c = (r as { content?: { text?: string }[] })?.content;
  return Array.isArray(c) ? c[0]?.text ?? '' : '';
};
const json = (s: string): Record<string, unknown> => {
  try { return JSON.parse(s.replace(/^HTTP \d+: /, '')) as Record<string, unknown>; } catch { return {}; }
};

const failures: string[] = [];
let checked = 0;

/**
 * Exercise one tool. `expect` decides pass/fail from the raw response text, so
 * a deliberate 403 (tier gate) can be a pass while a 404 route is not.
 */
async function exercise(
  tool: string,
  args: Record<string, unknown>,
  expect: (body: string) => boolean,
  note = '',
): Promise<string> {
  checked++;
  let body: string;
  try {
    body = text(await client.callTool({ name: tool, arguments: args }));
  } catch (err) {
    body = `THREW: ${(err as Error).message}`;
  }
  const ok = expect(body);
  if (!ok) failures.push(tool);
  const oneLine = body.slice(0, 150).replace(/\s+/g, ' ');
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${tool.padEnd(20)} ${oneLine}${note ? `   (${note})` : ''}`);
  return body;
}

const tools = await client.listTools();
const names = tools.tools.map(t => t.name).sort();
console.log(`TOOLS (${names.length}): ${names.join(', ')}\n`);

// ── export: the plan as files ────────────────────────────────────────────────
// (exercised after the throwaway project exists — see below)

// ── tier status: no project needed, proves the unversioned-alias route works ──
const tierBody = await exercise('tier_status', {}, b => /"tier"/.test(b));
const tier = String(json(tierBody).tier ?? 'unknown');
const teamTier = tier === 'team';
console.log(`\n  key tier = ${tier} — agent-seat + contributor tools are Team-only; on ${tier} a 403 team_tier_required is the expected pass.\n`);

// ── projects: create a throwaway, rename it, archive/unarchive, list ──────────
const suffix = Math.random().toString(36).slice(2, 8);
const projectId = `mcp-parity-${suffix}`;

await exercise('create_project', { name: `MCP parity ${suffix}`, id: projectId }, b => /"success"\s*:\s*true/.test(b));
await exercise('list_projects', { includeArchived: true }, b => b.includes(projectId));
await exercise('rename_project', { projectId, name: `MCP parity ${suffix} renamed` }, b => /"success"\s*:\s*true/.test(b));
await exercise('archive_project', { projectId, archived: true }, b => /"archived"\s*:\s*true/.test(b));
await exercise('archive_project', { projectId, archived: false }, b => /"archived"\s*:\s*false/.test(b));

await exercise('export_okf', { projectId }, b => /files|nodes|bundle|\.md/.test(b));

// ── webhooks: create → list → patch → rotate → delete ────────────────────────
const hookBody = await exercise(
  'create_webhook',
  { projectId, url: 'https://example.com/pb-parity-hook', events: ['node.added'] },
  b => /"secret"\s*:\s*"whsec_/.test(b),
);
const hookId = (json(hookBody).webhook as { id?: string } | undefined)?.id;

if (hookId) {
  await exercise('list_webhooks', { projectId }, b => b.includes(hookId));
  await exercise('update_webhook', { projectId, id: hookId, events: ['node.added', 'node.updated'] }, b => /node.updated/.test(b));
  await exercise('update_webhook', { projectId, id: hookId, rotateSecret: true }, b => /"secret"\s*:\s*"whsec_/.test(b), 'rotate');
  await exercise('delete_webhook', { projectId, id: hookId }, b => /"success"\s*:\s*true/.test(b));
} else {
  failures.push('create_webhook (no id — downstream webhook tools not exercised)');
}

// ── share links: create → list → revoke ──────────────────────────────────────
const shareBody = await exercise('create_share_link', { projectId, expiresInDays: 1 }, b => /"token"/.test(b));
const shareToken = json(shareBody).token as string | undefined;

if (shareToken) {
  await exercise('list_share_links', { projectId }, b => b.includes(shareToken));
  await exercise('revoke_share_link', { projectId, token: shareToken }, b => /"revoked"\s*:\s*"/.test(b));
} else {
  failures.push('create_share_link (no token — downstream share tools not exercised)');
}

// ── members: list is open to any member; mutations are Team-tier ─────────────
await exercise('list_members', { projectId }, b => /"members"/.test(b));
await exercise(
  'add_agent_seat',
  { projectId, name: 'parity-proof-agent' },
  b => (teamTier ? /"apiKey"\s*:\s*"pb_/.test(b) : /team_tier_required/.test(b)),
  teamTier ? 'minted' : 'expected 403',
);
await exercise(
  'invite_contributor',
  { email: `parity-${suffix}@example.com`, projectIds: [projectId] },
  b => (teamTier ? /"success"\s*:\s*true/.test(b) : /team_tier_required/.test(b)),
  teamTier ? 'invited' : 'expected 403',
);
// revoke_member: no seat to remove on a non-Team key, so assert the 404 that
// proves the shim routed a DELETE with both query params through correctly.
await exercise(
  'revoke_member',
  { projectId, userId: 'agent_nonexistent' },
  b => /Not a member of this project|"success"\s*:\s*true/.test(b),
  'not-a-member is the expected reply',
);

// ── teardown: archive the throwaway (there is no project-delete endpoint) ────
console.log('');
await exercise('archive_project', { projectId, archived: true }, b => /"archived"\s*:\s*true/.test(b), 'teardown');

await client.close();

console.log(
  failures.length === 0
    ? `\nPARITY PASS — ${names.length} tools registered, ${checked} calls, every new shim reached its endpoint.`
    : `\nPARITY FAIL — ${failures.length}/${checked} failed: ${failures.join(', ')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
