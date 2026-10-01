# Publishing the ProductBrain MCP server

Maintainer notes. Everything below is prepared; the steps marked **founder** need the owner's accounts (GitHub `moxzas`, npm owner of `@productbrain-com`) and take about 15 minutes in total, once. After the granular token exists, future releases are agent-run.

## 0. What is already in place (this folder)

- `package.json`: `version` 0.1.0, `repository` → `github.com/moxzas/productbrain-mcp`, `bugs`, `homepage`, `mcpName` `io.github.moxzas/productbrain` (the registry validates npm ownership by reading this field from the published package), `engines`, `files` (dist, README, LICENSE, server.json).
- `server.json`: the registry manifest (schema 2025-12-11), npm package `@productbrain-com/mcp` 0.1.0, stdio transport, the three env vars documented.
- `LICENSE`: MIT, Trisafe trading as ProductBrain.
- `README.md`: install for Claude Desktop / Claude Code / Cursor, the 27 tools, source + licence + registry section. No "clone a private repo" instruction remains.
- Secret scan (2026-09-20): no `pb_`, `sk-`, `eyJ…`, `ghp_`, `npm_`, `.env*` or key-shaped strings under `mcp/` outside `node_modules`. The proof scripts read keys from env only.
- The server sends `User-Agent: productbrain-mcp/0.1.0`.

## 1. Create the public repository (**founder**, 2 min)

```bash
# from the productbrain monorepo, on staging after the install PRs are merged
gh repo create moxzas/productbrain-mcp --public --description "MCP server for ProductBrain — drive your product plan from Claude Desktop, Claude Code or Cursor" --homepage https://productbrain.com
git subtree split --prefix=mcp -b mcp-public          # history of mcp/ only
git push git@github.com:moxzas/productbrain-mcp.git mcp-public:main
git branch -D mcp-public
gh repo edit moxzas/productbrain-mcp --add-topic mcp --add-topic mcp-server --add-topic model-context-protocol --add-topic product-management --add-topic claude --add-topic ai-agents --add-topic productbrain
```

`git subtree split` keeps only commits touching `mcp/`; none of them contain secrets (scan above), and `admin/`, `SESSION_NOTES.md` and the rest of the monorepo never enter the new history. The monorepo `mcp/` folder stays the source of truth: CI's `mcp-smoke` job still runs here. Re-sync after a change with the same `subtree split` + push (agent-run once the repo exists).

## 2. Publish 0.1.0 to npm (**founder**, 5 min, needs the owner account + 2FA)

```bash
cd mcp
npm ci && npm run build && npm run smoke
npm pack --dry-run                 # expect: LICENSE, README.md, server.json, dist/server.js (+ maps)
npm login                          # owner account
npm publish --access public        # prepublishOnly builds again
npm view @productbrain-com/mcp version   # → 0.1.0
```

## 3. Mint a granular token so future publishes are agent-run (**founder**, 3 min)

npm → Access Tokens → *Generate New Token* → **Granular Access Token**: packages and scopes → *Only select packages* → `@productbrain-com/mcp`, permission **Read and write**, expiry 1 year, bypass 2FA **on** (otherwise CI cannot use it). Store it in Bitwarden Secrets Manager (project `ops`) as `NPM_TOKEN_PRODUCTBRAIN_MCP` with a note (consumer: agent publishes of `@productbrain-com/mcp`), and as the GitHub Actions secret `NPM_TOKEN` on `moxzas/productbrain-mcp`. A later release is then `npm version patch && npm publish` with `NODE_AUTH_TOKEN` set.

## 4. Register in the official MCP registry (**founder** for the login, 3 min; agent thereafter)

```bash
# once, on the founder's Mac
brew install mcp-publisher            # or: curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/').tar.gz" | tar xz mcp-publisher
cd mcp
mcp-publisher login github            # authorises the io.github.moxzas namespace via the founder's GitHub account
mcp-publisher publish                 # reads server.json; validates mcpName inside the npm tarball
curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=productbrain' | jq '.servers[].server.name'
```

Order matters: step 2 (npm 0.1.0 with `mcpName`) before step 4, or validation fails. Re-publishing a new version = bump `version` in both `package.json` and `server.json`, `npm publish`, `mcp-publisher publish`.

Optional later: a `com.productbrain/mcp` name needs a DNS TXT record (`mcp-publisher login dns`); nothing depends on it.

## 5. Aggregators (no accounts, no pitch)

- **Glama** (glama.ai/mcp/servers): auto-indexes from GitHub once the npm package carries the `repository` field and the repo is public. Nothing to submit; check the listing in the monthly report (`https://glama.ai/mcp/servers/moxzas/productbrain-mcp` once indexed). If it has not appeared after four weeks, the "Add server" form at glama.ai/mcp/servers takes the GitHub URL only.
- **mcp.so**: listing is a GitHub issue on `chatmcp/mcp-directory` titled `Add server: ProductBrain` with the body below. This is a form, not a pitch; the founder pastes it or the agent opens it once the repo exists (an issue on someone else's repo is outward-facing, so it waits for the founder's go).

  ```
  Name: ProductBrain
  Repository: https://github.com/moxzas/productbrain-mcp
  npm: @productbrain-com/mcp
  Description: Drive a ProductBrain product plan (goals, needs, approaches, jobs) from your agent: search, read, mutate, run the planning workflow, steer the live view. Thin transport over a versioned REST API.
  Transport: stdio
  ```

- **Smithery**: skipped. Its URL listing needs a remote streamable-HTTP endpoint; this server is stdio only (14 §2 F3.2).
- **awesome-mcp-servers**: the one-line entry is prepared in the install report (install 7); a PR to that repo is outward-facing and the founder's.

## 6. What the monthly report reads afterwards

npm last-month downloads, registry `?search=productbrain`, Glama page, GitHub traffic for `moxzas/productbrain-mcp` (needs the founder's `gh` token; the CI PAT cannot read traffic), and server-side requests with `User-Agent: productbrain-mcp/*` once a log drain exists.
