import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { freezeSessionSystem, forgetSession, peekRecord, setMcpConnected } from "./freeze.js"
import { connectedNames, hasConnected, isSettled, waitMsFrom, waitUntil, wantedServers } from "./wait.js"

function digest(system) {
  return createHash("sha256").update(system.join("\n")).digest("hex").slice(0, 12)
}

function logPath() {
  return path.join(os.homedir(), ".local", "state", "opencode", "opencode-consistent.log")
}

function logRaw(line) {
  if (process.env.OPENCODE_CONSISTENT_LOG !== "1") return
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true })
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break a turn */
  }
}

function logSystem(kind, sessionID, system) {
  const rec = peekRecord(sessionID)
  const date = rec?.date ?? "none"
  logRaw(
    `${kind} session=${sessionID.slice(0, 12)} date=${date.replaceAll(" ", "_")} sha=${digest(system)} parts=${system.length} bytes=${system.join("\n").length}`,
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
      logSystem(kind, sessionID, system)
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

export default OpencodeConsistentPlugin
