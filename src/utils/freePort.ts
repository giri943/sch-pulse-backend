import { exec } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../config/logger";

const run = promisify(exec);

/**
 * Kill any process currently listening on `port` (other than ourselves), then
 * return. This mirrors how nodemon force-restarts on Windows: `tsx watch` can
 * leave the previous child process alive holding the port (and running its
 * crons), so the new instance reclaims the port instead of crashing with
 * EADDRINUSE. Best-effort and never throws — if inspection fails we just
 * fall back to the bind-retry logic in index.ts.
 */
export async function freePort(port: number): Promise<void> {
  const self = String(process.pid);
  try {
    const pids = await pidsOnPort(port);
    const stale = [...pids].filter((pid) => pid && pid !== self);
    for (const pid of stale) {
      const cmd =
        process.platform === "win32" ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`;
      await run(cmd).catch(() => {});
      logger.warn(`Reclaimed port ${port}: stopped stale backend process ${pid}`);
    }
  } catch (err) {
    logger.debug({ err }, `freePort: could not inspect port ${port} (continuing)`);
  }
}

async function pidsOnPort(port: number): Promise<Set<string>> {
  const pids = new Set<string>();
  if (process.platform === "win32") {
    const { stdout } = await run("netstat -ano -p tcp").catch(() => ({ stdout: "" }));
    for (const line of stdout.split(/\r?\n/)) {
      // Match the LOCAL address port in ANY state (LISTENING, TIME_WAIT, a
      // dying process still draining, etc.) — a half-closed socket on Windows
      // still blocks a rebind, so we must kill the owning PID regardless.
      // e.g. "  TCP    0.0.0.0:4000   0.0.0.0:0   LISTENING   12345"
      const m = line.match(/^\s*TCP\s+\S+?:(\d+)\s+\S+\s+\w+\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
  } else {
    const { stdout } = await run(`lsof -ti tcp:${port}`).catch(() => ({ stdout: "" }));
    for (const pid of stdout.split(/\s+/)) if (pid) pids.add(pid);
  }
  return pids;
}
