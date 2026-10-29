import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";

const require = createRequire(join(process.cwd(), "node_modules", "context-mode", "package.json"));
const cjs = require.resolve("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const esm = cjs.replace(/([/\\])dist\1cjs\1/, "$1dist$1esm$1");
assert.notEqual(esm, cjs, "resolve both independently patched SDK formats");

function initialize() {
  return new Request("http://127.0.0.1/mcp", { method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-probe", version: "1" },
    } }),
  });
}

async function check(Transport) {
  const originalSet = Map.prototype.set;
  const originalDelete = Map.prototype.delete;
  const retained = [];
  let allocated = 0;
  Map.prototype.set = function (key, value) {
    if (typeof value?.resolveJson === "function") { allocated++; retained.push({ map: this, key }); }
    return originalSet.call(this, key, value);
  };
  Map.prototype.delete = function (key) {
    const index = retained.findIndex((item) => item.map === this && item.key === key);
    if (index >= 0) retained.splice(index, 1);
    return originalDelete.call(this, key);
  };
  let transport;
  try {
    transport = new Transport({ enableJsonResponse: true });
    transport.onmessage = (message) => {
      void transport.send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "package-probe", version: "1" },
      } });
    };
    const response = await transport.handleRequest(initialize());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 1);
    assert.equal(allocated, 1);
    assert.equal(retained.length, 0, "completed JSON response must release its stream record");
  } finally {
    Map.prototype.set = originalSet;
    Map.prototype.delete = originalDelete;
    await transport?.close();
  }

  transport = new Transport({ enableJsonResponse: true });
  let entered;
  const received = new Promise((resolve) => { entered = resolve; });
  transport.onmessage = () => entered();
  const pending = transport.handleRequest(initialize());
  try {
    await received;
    await transport.close();
    // close() must settle the held response before the next event-loop turn.
    // No delay, polling interval, SDK private field, or wall-clock assertion.
    const response = await Promise.race([pending, nextTurn().then(() => "still pending")]);
    assert.notEqual(response, "still pending", "close must release a held JSON POST");
    assert.equal(response.status, 503);
  } finally { await transport.close(); }
}

await check((await import(pathToFileURL(esm).href)).WebStandardStreamableHTTPServerTransport);
await check(require(cjs).WebStandardStreamableHTTPServerTransport);
console.log("SDK package cleanup verified");
