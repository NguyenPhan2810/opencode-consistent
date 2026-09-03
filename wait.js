export const DEFAULT_WAIT_MS = 15_000
export const DEFAULT_INTERVAL_MS = 200

const TERMINAL = new Set(["connected", "failed", "needs_auth", "needs_client_registration"])

export function waitMsFrom(option) {
  if (option !== undefined && option !== null && Number.isFinite(Number(option))) {
    return Math.max(0, Number(option))
  }
  const env = process.env.OPENCODE_CONSISTENT_MCP_WAIT_MS
  if (env !== undefined && env !== "" && Number.isFinite(Number(env))) {
    return Math.max(0, Number(env))
  }
  return DEFAULT_WAIT_MS
}

/** MCP names that OpenCode will try to connect (enabled !== false). */
export function wantedServers(mcpConfig) {
  if (!mcpConfig || typeof mcpConfig !== "object") return []
  return Object.entries(mcpConfig)
    .filter(([, value]) => value && typeof value === "object" && value.enabled !== false)
    .map(([name]) => name)
    .sort()
}

export function connectedNames(status) {
  if (!status || typeof status !== "object") return []
  return Object.entries(status)
    .filter(([, value]) => value && value.status === "connected")
    .map(([name]) => name)
    .sort()
}

/**
 * Connecting servers report as "disabled" on GET /mcp until they finish.
 * Treat disabled/missing as in-flight for names that are configured and enabled.
 */
export function isSettled(status, wanted) {
  if (!Array.isArray(wanted) || wanted.length === 0) return true
  return wanted.every((name) => TERMINAL.has(status?.[name]?.status))
}

export function hasConnected(status, required) {
  if (!Array.isArray(required) || required.length === 0) return true
  return required.every((name) => status?.[name]?.status === "connected")
}

/**
 * Poll until `ok(last)` or timeout. First poll is immediate.
 * @returns {{ ok: boolean, elapsed: number, last: any, timedOut: boolean }}
 */
export async function waitUntil({ poll, ok, timeoutMs, intervalMs, sleep, now }) {
  const t0 = (now ?? Date.now)()
  const timeout = timeoutMs ?? DEFAULT_WAIT_MS
  const step = intervalMs ?? DEFAULT_INTERVAL_MS
  const nap = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const clock = now ?? Date.now

  let last = await poll()
  if (ok(last)) return { ok: true, elapsed: clock() - t0, last, timedOut: false }
  if (timeout <= 0) return { ok: false, elapsed: clock() - t0, last, timedOut: true }

  while (clock() - t0 < timeout) {
    await nap(step)
    last = await poll()
    if (ok(last)) return { ok: true, elapsed: clock() - t0, last, timedOut: false }
  }
  return { ok: false, elapsed: clock() - t0, last, timedOut: true }
}
