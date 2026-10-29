// Loaded with NODE_OPTIONS --import before Node tries the harness's owned-job
// argument. The private control connection belongs to this one test fixture.
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const holder = process.env.OWNED_HELPER_ROLE === "holder";
const control = createConnection({ host: "127.0.0.1", port: Number(process.env.OWNED_HELPER_CONTROL_PORT) });
const backstop = setTimeout(() => process.exit(7), 30_000);
control.on("error", () => process.exit(8));
control.on("close", () => process.exit(0));
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
let request, input = Buffer.alloc(0), commands = "", faulted = false;
if (holder) control.once("connect", () => {
  control.write("holder-ready\n", () => process.send?.("ready"));
});

function frame(kind, payload) {
  const bytes = Buffer.from(payload), header = Buffer.alloc(5);
  header[0] = kind.charCodeAt(0); header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

if (!holder) process.stdin.on("data", (bytes) => {
  if (request) return;
  input = Buffer.concat([input, bytes]);
  if (input.length < 5 || input.length < 5 + input.readUInt32BE(1)) return;
  request = JSON.parse(input.subarray(5, 5 + input.readUInt32BE(1)).toString("utf8"));
  process.stdout.write(frame("O", "READY"), () => control.write("ready\n"));
});

function finalReceipt() {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return frame("F", JSON.stringify({ v: 1, id: request.id, status: "completed", exit_code: 0,
    stdout_bytes: 5, stderr_bytes: 0, stdout_sha256: digest("READY"), stderr_sha256: digest("") }));
}

control.on("data", (bytes) => {
  commands += bytes.toString("utf8");
  while (commands.includes("\n")) {
    const end = commands.indexOf("\n"), command = commands.slice(0, end);
    commands = commands.slice(end + 1);
    if (command === "malformed") {
      faulted = true;
      process.stdout.write(frame("F", "{"), () => control.write("faulted\n"));
    } else if (command === "stdout-eof") {
      faulted = true;
      process.stdout.end(() => control.write("faulted\n"));
    } else if (command === "stdin-closed") {
      faulted = true;
      process.stdin.destroy();
      control.write("faulted\n");
    } else if (command === "final-stuck") {
      faulted = true;
      process.stdout.write(finalReceipt(), () => control.write("faulted\n"));
    } else if (command === "leader-exit") {
      faulted = true;
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, NODE_OPTIONS: "", OWNED_HELPER_ROLE: "holder" },
        windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      child.once("error", () => process.exit(9));
      child.once("message", () => control.write("faulted\n", () => process.exit(0)));
    } else if (command === "release") {
      clearTimeout(backstop);
      if (faulted || holder) process.exit(0);
      process.stdout.end(finalReceipt(), () => process.exit(0));
    }
  }
});

// Keep the preload pending: production still passes the real harness CLI argv.
await new Promise(() => {});
