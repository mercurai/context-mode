// Test-run lifecycle adapter only. MCP, registration, storage and permissions are
// implemented by the normal built SharedService; no proxy or diagnostic tools.
function specs(input) {
  if (!Array.isArray(input) || !input.length || input.length > 32) throw new Error("Invalid production launches");
  const names = new Set();
  return input.map((launch) => {
    if (!launch || !/^[A-Za-z0-9_-]{1,64}$/.test(launch.name) || names.has(launch.name) ||
        !["codex", "claude"].includes(launch.provider) ||
        [launch.home, launch.userHome, launch.workspace].some((path) => typeof path !== "string" || !path)) {
      throw new Error("Invalid production launch");
    }
    names.add(launch.name);
    // Canonical, existing-directory validation belongs to the real authority.
    return Object.freeze({ name: launch.name, provider: launch.provider, home: launch.home,
      userHome: launch.userHome, workspace: launch.workspace });
  });
}

export async function createProductionProbe({ launches: input, now = () => new Date() } = {}) {
  const launches = specs(input);
  if (typeof now !== "function") throw new Error("Invalid production clock");
  // Normal TypeScript build output, never a second service implementation.
  const { createSharedService } = await import("../../../build/shared/service.js");

  async function open() {
    const service = await createSharedService({ now, ttlMs: 3_600_000, maxIdentities: 4096,
      maxLaunches: launches.length, maxProjects: launches.length, maxSessions: 256,
      mcpServerName: "probe", http: { host: "127.0.0.1", port: 0, allowedOrigins: [], limits: {
        maxTransportSessions: 128, maxPendingInitializations: 16, maxInFlightRequests: 32, maxBodyBytes: 1_048_576,
      } } });
    try {
      const issued = launches.map((launch) => service.issue({
        provider: launch.provider === "claude" ? "claude-code" : "codex", home: launch.home,
        userHome: launch.userHome, workspace: launch.workspace,
      }));
      await service.listen();
      const base = `http://127.0.0.1:${service.address().port}`;
      const grants = new Map(launches.map((launch, index) => [launch.name, Object.freeze({
        provider: launch.provider, home: launch.home, userHome: launch.userHome, workspace: launch.workspace,
        mcpUrl: `${base}/mcp`, hookUrl: `${base}/hooks`,
        mcpCapability: issued[index].mcpCapability, hookCapability: issued[index].hookCapability,
      })]));
      return { service, grants };
    } catch (error) {
      try { await service.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Production adapter startup cleanup failed"); }
      throw error;
    }
  }

  let current = await open();
  let epoch = 1;
  let closed = false;
  let restartPromise;
  let closePromise;
  return Object.freeze({
    launch(name) {
      if (closed || restartPromise || !current.grants.has(name)) throw new Error("Production launch unavailable");
      // Returned only to the trusted runner for environment injection. Never log.
      return current.grants.get(name);
    },
    report: () => ({ backend: "shared-service", epoch, health: current.service.health(),
      launches: launches.map((launch, index) => ({ alias: `l${index + 1}`, provider: launch.provider })) }),
    restart() {
      if (closed) return Promise.reject(new Error("Production adapter is closed"));
      if (restartPromise) return restartPromise;
      current.grants.clear();
      restartPromise = (async () => {
        try {
          await current.service.close();
          if (closed) return;
          const replacement = await open();
          if (closed) { await replacement.service.close(); return; }
          current = replacement;
          epoch++;
        } catch (error) { closed = true; throw error; }
        finally { restartPromise = undefined; }
      })();
      return restartPromise;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      current.grants.clear();
      const restarting = restartPromise;
      closePromise = (async () => {
        let restartError;
        try { await restarting; } catch (error) { restartError = error; }
        try { await current.service.close(); }
        catch (error) {
          if (restartError) throw new AggregateError([restartError, error], "Production adapter cleanup failed");
          throw error;
        }
        if (restartError) throw restartError;
      })();
      return closePromise;
    },
  });
}
