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

| Tool | Maps to | Use |
|------|---------|-----|
| `search` | `GET /search` | Semantic search — **use first** for any lookup |
| `list_nodes` | `GET /nodes` | Bulk read, optional type/iteration filter |
| `get_tree` | `GET /tree` | A node in context (ancestors/siblings/children/subtree) |
| `mutate` | `POST /mutate` | Create/update/delete nodes + phases; pass `idempotencyKey` to make retries safe |
| `list_iterations` | `GET /iterations` | Phases; `current:true` for the active one |
| `run_workflow` | `POST /workflow` | Story-Mapping methodology (add / task-curate / phase-assign) |
| `set_view` / `read_view` | `POST /view-command`, `GET /view-state` | Drive / read the live canvas |

Full API reference: <https://productbrain.com/docs/llm-guide.md>.
