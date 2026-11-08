import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  changedPartKeys,
  digestSystem,
  freezeSessionSystem,
  forgetSession,
  partDigests,
  PART_KEYS,
  peekRecord,
  recordSystemDigest,
  setMcpConnected,
} from "./freeze.js"
import { connectedNames, hasConnected, isSettled, waitMsFrom, waitUntil, wantedServers } from "./wait.js"
import { freezeMode, makeContextHook, makeCompactionHook } from "./v2.js"

function logPath() {
  return path.join(os.homedir(), ".local", "state", "opencode", "opencode-consistent.log")
}

/** On by default so an overnight miss is captured. Set OPENCODE_CONSISTENT_LOG=0 to disable. */
export function loggingEnabled() {
  const v = process.env.OPENCODE_CONSISTENT_LOG
  if (v === undefined || v === "") return true
  return v === "1" || v === "true"
}

function logRaw(line) {
  if (!loggingEnabled()) return
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true })
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break a turn */
  }
}

function logSystem(kind, sessionID, system) {
  const sha = digestSystem(system)
  const parts = partDigests(system)
  const before = peekRecord(sessionID)
  const rec = recordSystemDigest(sessionID, sha, parts, kind) ?? peekRecord(sessionID)
  const date = rec?.date ?? "none"
  const snap = rec?.sha ?? sha
  const prev = before?.lastSha ?? before?.sha ?? "-"
  const vsSnap = kind === "snapshot" ? [] : changedPartKeys(before?.parts, parts)
  const vsLast = kind === "snapshot" ? [] : changedPartKeys(before?.lastParts, parts)
  const partLog = PART_KEYS.map((key) => `${key}=${parts[key]}`).join(" ")
  logRaw(
    `${kind} session=${sessionID.slice(0, 12)} date=${date.replaceAll(" ", "_")} sha=${sha} snap=${snap} prev=${prev} vs_snap=${vsSnap.join(",") || "-"} vs_last=${vsLast.join(",") || "-"} parts=${system.length} bytes=${system.join("\n").length} ${partLog}`,
  )
}

export async function readStatus(client) {
  if (!client?.mcp?.status) return {}
  try {
    const result = await client.mcp.status()
    const data = result?.data
    if (data && typeof data === "object" && !Array.isArray(data)) return data
    return {}
  } catch {
    return {}
  }
}

async function readWanted(client) {
  if (!client?.config?.get) return []
  try {
    const result = await client.config.get()
    const cfg = result?.data ?? result
    return wantedServers(cfg?.mcp)
  } catch {
    return []
  }
}

export const OpencodeConsistentPlugin = async (ctx = {}, options = {}) => {
  const client = ctx.client
  let wanted = []
  /** @type {Map<string, Record<string, { status: string }>>} */
  const lastWait = new Map()
  const timeoutMs = waitMsFrom(options.mcpWaitMs)
  const intervalMs =
    options.mcpWaitIntervalMs !== undefined && Number.isFinite(Number(options.mcpWaitIntervalMs))
      ? Math.max(0, Number(options.mcpWaitIntervalMs))
      : undefined

  return {
    config: async (cfg) => {
      wanted = wantedServers(cfg?.mcp)
    },
    "chat.message": async (input) => {
      const sessionID = input?.sessionID
      if (!sessionID) return
      try {
        if (wanted.length === 0) wanted = await readWanted(client)
        const rec = peekRecord(sessionID)
        const required = rec?.mcp?.connected
        let mode
        let predicate
        if (Array.isArray(required)) {
          if (required.length === 0) {
            logRaw(`wait skip session=${sessionID.slice(0, 12)} reason=no-mcp`)
            lastWait.set(sessionID, {})
            return
          }
          mode = "restore"
          predicate = (status) => hasConnected(status, required)
        } else {
          if (wanted.length === 0) {
            logRaw(`wait skip session=${sessionID.slice(0, 12)} reason=no-wanted`)
            lastWait.set(sessionID, {})
            return
          }
          mode = rec ? "upgrade" : "first"
          predicate = (status) => isSettled(status, wanted)
        }
        const result = await waitUntil({
          poll: () => readStatus(client),
          ok: predicate,
          timeoutMs,
          intervalMs,
        })
        lastWait.set(sessionID, result.last ?? {})
        const connected = connectedNames(result.last).join(",") || "-"
        logRaw(
          `wait ${result.ok ? "ok" : "timeout"} mode=${mode} session=${sessionID.slice(0, 12)} elapsed=${result.elapsed} connected=${connected}`,
        )
      } catch (err) {
        logRaw(`wait error session=${sessionID.slice(0, 12)} ${err?.message ?? err}`)
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID
      const system = output?.system
      const kind = freezeSessionSystem(sessionID, system)
      if (kind === "skip") return
      const rec = peekRecord(sessionID)
      const waited = lastWait.get(sessionID)
      const shouldCapture = waited !== undefined && (kind === "snapshot" || rec?.mcp == null)
      if (shouldCapture) setMcpConnected(sessionID, connectedNames(waited))
      if (Array.isArray(system)) logSystem(kind, sessionID, system)
    },
    event: async ({ event }) => {
      const type = event?.type
      const id = event?.properties?.sessionID ?? event?.properties?.info?.id
      if (typeof id === "string" && type === "session.deleted") {
        lastWait.delete(id)
        forgetSession(id)
      }
    },
  }
}

/**
 * V2 entrypoint (OpenCode 2.x). V2 reads the default export's `id` and calls
 * `setup(ctx)`; it ignores `server()`. V1 called the default export as a
 * function, so `server` keeps the old factory reachable for 1.18.x users.
 *
 * Why a separate implementation: V2 removed `experimental.chat.system.transform`.
 * The equivalent lever is `ctx.session.hook("context", event => …)`, whose
 * `event.system` is the assembled SystemPart[] for the outgoing call. See v2.js.
 */
export default {
  id: "opencode-consistent",
  async setup(ctx, options) {
    const opts = { ...(ctx?.options ?? {}), ...(options ?? {}) }
    const mode = freezeMode(opts.freeze)
    const waitEnv = process.env.OPENCODE_CONSISTENT_MCP_WAIT_MS
    const waitMs =
      opts.mcpWaitMs !== undefined
        ? waitMsFrom(opts.mcpWaitMs)
        : waitEnv !== undefined && waitEnv !== ""
          ? waitMsFrom()
          : 5000
    const hook = makeContextHook(ctx, {
      mode,
      freezeTools: opts.freezeTools !== false,
      waitMs,
      waitIntervalMs:
        opts.mcpWaitIntervalMs !== undefined && Number.isFinite(Number(opts.mcpWaitIntervalMs))
          ? Math.max(0, Number(opts.mcpWaitIntervalMs))
          : undefined,
      log: logRaw,
    })
    const registration = await ctx.session.hook("context", (event) => hook(event))
    // The compaction request is assembled separately and never reaches the context hook; this is the
    // only seam that sees it. Diagnostic until rewriteCompaction is switched on.
    const chook = makeCompactionHook(ctx, {
      freezeTools: opts.freezeTools !== false,
      rewriteCompaction: opts.rewriteCompaction !== false,
      log: logRaw,
    })
    const compactionRegistration = await ctx.session.hook("compaction", (event) => chook(event))
    logRaw(
      `setup v2 mode=${mode} hook=session.context+session.compaction freezeTools=${opts.freezeTools !== false} rewriteCompaction=${opts.rewriteCompaction !== false}`,
    )
    return () => {
      registration?.dispose?.()
      compactionRegistration?.dispose?.()
    }
  },
  server: OpencodeConsistentPlugin,
}
