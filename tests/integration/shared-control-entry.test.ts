import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import * as control from "../../src/shared/control.js";

type Entry = (run: (input: Readable, output: Writable, errors: Writable) => Promise<void>,
  options: { platform: NodeJS.Platform; pipeNames?: string; connectTimeoutMs?: number }) => Promise<void>;

// Resolve through the existing public control boundary. The baseline lacks the
// entry adapter; after implementation these exercise real socket I/O and cleanup.
function entry(): Entry {
  const candidate = (control as unknown as { runServiceEntry?: Entry }).runServiceEntry;
  expect(candidate, "the control package must expose the shared entry adapter").toBeTypeOf("function");
  return candidate!;
}

const servers: Server[] = [];
const clients: Socket[] = [];
const closed: Promise<unknown>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  closed.length = 0;
});

function names(): [string, string, string] {
  const nonce = randomBytes(16).toString("hex");
  return ["in", "out", "err"].map((role) => `\\\\.\\pipe\\harness-${nonce}-${role}`) as [string, string, string];
}

async function listen(path: string, connected: (socket: Socket) => void): Promise<void> {
  const server = createServer((socket) => {
    clients.push(socket);
    closed.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
    socket.on("error", () => undefined);
    connected(socket);
  });
  servers.push(server);
  server.listen(path);
  await once(server, "listening");
}

function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(text, (error) => error ? reject(error) : resolve()));
}

describe("managed service entry transport", () => {
  it("connects all three host pipes before running and preserves their separate roles", async () => {
    const paths = names();
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    await listen(paths[0], (socket) => socket.write("bootstrap"));
    await listen(paths[1], (socket) => socket.on("data", (chunk) => output.push(chunk)));
    await listen(paths[2], (socket) => socket.on("data", (chunk) => errors.push(chunk)));

    await entry()(async (input, result, diagnostics) => {
      expect(clients).toHaveLength(3);
      const [chunk] = await once(input, "data");
      expect(chunk.toString()).toBe("bootstrap");
      await write(result, "ready");
      await write(diagnostics, "diagnostic");
    }, { platform: "win32", pipeNames: paths.join(";") });

    await Promise.all(closed);
    expect(Buffer.concat(output).toString()).toBe("ready");
    expect(Buffer.concat(errors).toString()).toBe("diagnostic");
  });

  it("closes partial connections and never runs the service when a pipe is missing", async () => {
    const paths = names();
    await listen(paths[0], () => undefined);
    await listen(paths[1], () => undefined);
    let ran = false;
    await expect(entry()(async () => { ran = true; }, {
      platform: "win32", pipeNames: paths.join(";"), connectTimeoutMs: 500,
    })).rejects.toThrow("Shared service control failed");
    await Promise.all(closed);
    expect(ran).toBe(false);
  });

  it("closes every pipe after service failure and emits only a fixed diagnostic", async () => {
    const paths = names();
    const errors: Buffer[] = [];
    await listen(paths[0], () => undefined);
    await listen(paths[1], () => undefined);
    await listen(paths[2], (socket) => socket.on("data", (chunk) => errors.push(chunk)));
    await expect(entry()(async () => { throw new Error("private service detail"); }, {
      platform: "win32", pipeNames: paths.join(";"),
    })).rejects.toThrow("Shared service control failed");
    await Promise.all(closed);
    expect(Buffer.concat(errors).toString()).toBe("Shared service control failed\n");
  });

  it.each([false, true])("rejects an unfinished output destroyed at service completion (error=%s)", async (withError) => {
    const paths = names();
    const errors: Buffer[] = [];
    await listen(paths[0], () => undefined);
    await listen(paths[1], () => undefined);
    await listen(paths[2], (socket) => socket.on("data", (chunk) => errors.push(chunk)));
    await expect(entry()(async (_input, output) => {
      output.destroy(withError ? new Error("private transport detail") : undefined);
    }, { platform: "win32", pipeNames: paths.join(";") }))
      .rejects.toThrow("Shared service control failed");
    await Promise.all(closed);
    expect(Buffer.concat(errors).toString()).toBe("Shared service control failed\n");
  });

  it.each([undefined, "", "stdin;stdout;stderr", "\\\\remote\\pipe\\host-in;out;err"])(
    "refuses absent or nonlocal pipe authority before running: %s", async (pipeNames) => {
      let ran = false;
      await expect(entry()(async () => { ran = true; }, { platform: "win32", pipeNames }))
        .rejects.toThrow("Shared service control failed");
      expect(ran).toBe(false);
    },
  );

  it("refuses mixed generations and swapped roles", async () => {
    const first = names();
    const second = names();
    for (const paths of [[first[0], second[1], first[2]], [first[1], first[0], first[2]]]) {
      let ran = false;
      await expect(entry()(async () => { ran = true; }, {
        platform: "win32", pipeNames: paths.join(";"),
      })).rejects.toThrow("Shared service control failed");
      expect(ran).toBe(false);
    }
  });
});
