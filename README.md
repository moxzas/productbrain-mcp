# ProductBrain MCP server

Drive your ProductBrain plan from an MCP client — **Claude Desktop, Cursor, Claude Code** — with tools for search, read, mutate, the methodology workflow, and the live view.

## Design — a thin shim, on purpose

This server is a **thin transport over ProductBrain's versioned v1 REST API**. Each tool is one call to an existing `/api/v1` endpoint. The REST contract stays canonical:

- It's **stable when the MCP spec churns** — the contract you depend on is the frozen v1 API, not the protocol.
- You can **drop to raw HTTP or bring your own LLM** at any time; MCP is one front-door, not the only one.
- Responses carry the same in-band `_meta` coaching the API returns, so your agent self-corrects.

## Install

```jsonc
// Claude Desktop — claude_desktop_config.json
{
  "mcpServers": {
    "productbrain": {
      "command": "npx",
      "args": ["-y", "@productbrain-com/mcp"],
      "env": {
        "PRODUCTBRAIN_API_KEY": "pb_your_key",
        "PRODUCTBRAIN_PROJECT_ID": "your-project-id"
      }
    }
  }
}
```

```bash
# Claude Code
claude mcp add productbrain \
  -e PRODUCTBRAIN_API_KEY=pb_your_key \
  -e PRODUCTBRAIN_PROJECT_ID=your-project-id \
  -- npx -y @productbrain-com/mcp
```

Cursor and other clients: add an `mcpServers` entry with the same `command`/`args`/`env`.

## Config (env)

| Var | Required | Default |
|-----|----------|---------|
| `PRODUCTBRAIN_API_KEY` | yes | — (your `pb_` key from the app's API Key modal) |
| `PRODUCTBRAIN_PROJECT_ID` | no | — (tools also accept a `projectId` argument) |
| `PRODUCTBRAIN_API_URL` | no | `https://productbrain.com/api/v1` |

## Tools

Every agent-facing `/api/v1` endpoint has a tool. One tool, one endpoint, same `_meta` coaching passed back verbatim.

**The plan**

| Tool | Maps to | Use |
|------|---------|-----|
| `search` | `GET /search` | Semantic search — **use first** for any lookup |
| `list_nodes` | `GET /nodes` | Bulk read, optional type/iteration filter |
| `get_tree` | `GET /tree` | A node in context (ancestors/siblings/children/subtree) |
| `mutate` | `POST /mutate` | Create/update/delete nodes + phases; pass `idempotencyKey` to make retries safe |
| `list_iterations` | `GET /iterations` | Phases; `current:true` for the active one |
| `run_workflow` | `POST /workflow` | Story-Mapping methodology (add / task-curate / phase-assign) |
| `export_okf` | `GET /export-okf` | The plan as a portable OKF file bundle |

**The view**

| Tool | Maps to | Use |
|------|---------|-----|
| `set_view` / `read_view` | `POST /view-command`, `GET /view-state` | Drive / read the live canvas |

**Projects**

| Tool | Maps to | Use |
|------|---------|-----|
| `list_projects` | `GET /projects` | Projects you own or are a member of; `includeArchived` for the rest |
| `create_project` | `POST /mutate {addProject}` | Bootstrap a brain — seeds the system "Later" phase. Pass an explicit `id`: `addProject` runs before mutate reads `Idempotency-Key`, so it is not retry-safe |
| `rename_project` | `POST /mutate {renameProject}` | Change the display name; the id is immutable |
| `archive_project` | `PATCH /projects` | Hide/unhide without deleting (reversible) |

**Webhooks**

| Tool | Maps to | Use |
|------|---------|-----|
| `list_webhooks` | `GET /webhooks` | Registered hooks with `lastStatus` — spot a failing receiver |
| `create_webhook` | `POST /webhooks` | Register; returns the signing secret **once** |
| `update_webhook` | `PATCH /webhooks` | Change url/events in place, or `rotateSecret:true`. Prefer over delete+recreate |
| `delete_webhook` | `DELETE /webhooks` | Remove a registration |

**Share links**

| Tool | Maps to | Use |
|------|---------|-----|
| `create_share_link` | `POST /share` | Mint a **public** read-only link; `expiresInDays` for a TTL |
| `list_share_links` | `GET /share` | Audit every token minted, with an `active` flag |
| `revoke_share_link` | `DELETE /share` | Kill a leaked or stale link |

**Members and budget**

| Tool | Maps to | Use |
|------|---------|-----|
| `list_members` | `GET /members` | Humans and agent seats on a project |
| `add_agent_seat` | `POST /members` | Mint an agent seat; the `pb_` key is returned **once** (Team tier) |
| `invite_contributor` | `POST /members` | Passwordless guest invite, scoped to the projects you name (Team tier) |
| `revoke_member` | `DELETE /members` | Remove a seat; an agent's key dies with its last membership |
| `tier_status` | `GET /tier-status` | Your tier, API access, credit balance and limits — check before a large run |
| `submit_feedback` | `POST /feedback` | Tell the PB team what to improve: feature requests, friction, bugs, notes |

Full API reference: <https://productbrain.com/docs/llm-guide.md>.

## Source, licence, registry

- Source: <https://github.com/moxzas/productbrain-mcp> (MIT). Issues and pull requests welcome there.
- npm: [`@productbrain-com/mcp`](https://www.npmjs.com/package/@productbrain-com/mcp). Every release is published from the repository's tag of the same version.
- MCP registry name: `io.github.moxzas/productbrain` (`server.json` in this repo is the registry manifest).
- The server sends `User-Agent: productbrain-mcp/<version>` so you can tell MCP traffic from raw REST calls in your own logs.

## Proving it works

Two headless scripts in the repository (`src/spike-proof.ts`, `src/parity-proof.ts`; not shipped in the npm package), both run against a real deployment. Use a throwaway project on your own account:

```bash
PRODUCTBRAIN_API_KEY=pb_your_key \
PRODUCTBRAIN_PROJECT_ID=your-sandbox-project \
npm run spike     # transport + auth + one read + one write

PRODUCTBRAIN_API_KEY=pb_your_key \
npm run parity    # every non-plan tool once, on a throwaway project
```

`parity` creates its own throwaway project and cleans up after itself (archiving it at the end — there is no project-delete endpoint).

The Team-tier tools (`add_agent_seat`, `invite_contributor`) return `403 team_tier_required` on a Builder key, and that counts as a pass — with one caveat worth knowing. It proves the shim reached the right route and passed the error and its `_meta` tip straight through; it does **not** validate the request body, because the tier gate runs before the body is read. Run `parity` with a Team-tier key to check those two properly.
