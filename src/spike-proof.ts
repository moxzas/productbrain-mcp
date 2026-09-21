/**
 * Spike proof — prove the MCP seam end-to-end, headless (no GUI client).
 * Spawns server.ts over stdio via the MCP client, lists tools, then exercises a READ
 * (search) and a WRITE (mutate add → delete cleanup). If this passes, the transport +
 * pb_ auth + tool plumbing all work, and the remaining tools (same mechanism) are
 * mechanical. Run against the agent's OWN staging sandbox:
 *
 *   PRODUCTBRAIN_API_URL=https://staging.productbrain.com/api/v1 \
 *   PRODUCTBRAIN_API_KEY=<AGENT_STAGING_API_KEY> \
 *   PRODUCTBRAIN_PROJECT_ID=agent-sandbox \
 *   npx tsx src/spike-proof.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const { PRODUCTBRAIN_API_KEY, PRODUCTBRAIN_PROJECT_ID, PRODUCTBRAIN_API_URL } = process.env;
if (!PRODUCTBRAIN_API_KEY || !PRODUCTBRAIN_PROJECT_ID) {
  console.error('Set PRODUCTBRAIN_API_KEY + PRODUCTBRAIN_PROJECT_ID (and optionally PRODUCTBRAIN_API_URL).');
  process.exit(1);
}

const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url));

// Pass the full env (PATH for npx/tsx) plus the PB config.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', serverPath], env });
const client = new Client({ name: 'spike-proof', version: '0.0.1' });
await client.connect(transport);

const text = (r: unknown): string => {
  const c = (r as { content?: { text?: string }[] })?.content;
  return Array.isArray(c) ? c[0]?.text ?? '' : '';
};

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map(t => t.name).join(', '));

const search = await client.callTool({ name: 'search', arguments: { q: 'webhook' } });
const searchText = text(search);
console.log('search →', searchText.slice(0, 110).replace(/\s+/g, ' '));

const add = await client.callTool({
  name: 'mutate',
  arguments: { action: 'add', payload: { node: { type: 'goal', data: { label: 'mcp-spike-proof' } } } },
});
const addText = text(add);
console.log('mutate add →', addText.slice(0, 150).replace(/\s+/g, ' '));
let addedId: string | undefined;
try { addedId = JSON.parse(addText)?.node?.id; } catch { /* leave undefined */ }

if (addedId) {
  const del = await client.callTool({ name: 'mutate', arguments: { action: 'delete', payload: { nodeId: addedId } } });
  console.log('cleanup delete →', text(del).slice(0, 90).replace(/\s+/g, ' '));
}

await client.close();

const ok = tools.tools.length >= 6 && /results|_meta|node/.test(searchText) && !!addedId;
console.log(ok
  ? `\nSPIKE PASS — stdio + pb_ auth + read(search) + write(mutate add/delete) all work (${tools.tools.length} tools)`
  : '\nSPIKE FAIL');
process.exit(ok ? 0 : 1);
