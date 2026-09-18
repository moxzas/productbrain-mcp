// Network-free fetch for the MCP smoke test. Loaded ahead of the server with
//   node --import ./scripts/mock-fetch.mjs dist/server.js
// so every fetch the server makes is answered here and nothing leaves the
// process. The body echoes the URL and method so the caller can assert on the
// request the tool handler built (e.g. that get_tree sends direction=, not
// relation=). Used only by scripts/smoke.mjs; never shipped (package.json
// "files" is dist + README only).
globalThis.fetch = async (input, init) =>
  new Response(JSON.stringify({ mockUrl: String(input), method: init?.method }), { status: 200 });
