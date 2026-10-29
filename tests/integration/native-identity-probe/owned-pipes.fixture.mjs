// Owned synthetic process tree. The test controls cooperative exit through a
// private loopback connection; neither production cleanup nor tests guess PIDs.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

if (process.env.PROBE_OWNER_ROLE === "leader-exit") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, PROBE_OWNER_ROLE: "holder" }, detached: true, windowsHide: true,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  child.once("message", () => process.exit(0));
} else {
  const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.PROBE_OWNER_PORT) });
  // Backstop only, not a timing assertion: never leave this fixture alive if a
  // test runner disappears before sending its cooperative release command.
  const backstop = setTimeout(() => process.exit(7), 30_000);
  socket.on("error", () => process.exit(8));
  socket.on("close", () => process.exit(0));
  socket.once("connect", () => {
    if (process.env.PROBE_OWNER_ROLE === "holder") {
      process.once("disconnect", () => socket.write("ready\n"));
      process.send("ready");
    } else socket.write("ready\n");
  });
  let buffer = "", responded = false;
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), command = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (command === "release") {
        clearTimeout(backstop);
        socket.end("released\n", () => process.exit(0));
      }
      if (command === "respond" && !responded) {
        responded = true;
        if (process.env.PROBE_OWNER_PROTOCOL === "1") import("./codex-app-server.fixture.mjs").catch(() => process.exit(9));
        else process.stdout.write("synthetic output while pipe remains open\n", () => socket.write("responded\n"));
      }
    }
  });
}
