import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAX_SESSIONS = 32
/** @type {Map<string, { system: string[], mcp: { connected: string[] } | null, savedAt?: number }>} */
const snapshots = new Map()

export function isEnvBearing(system) {
  if (!Array.isArray(system) || system.length === 0) return false
  const text = system.join("\n")
  return text.includes("<env>") || text.includes("Today's date:")
}

export function stateDir() {
  return process.env.OPENCODE_CONSISTENT_DIR || path.join(os.homedir(), ".local", "state", "opencode", "consistent")
}

function fileFor(sessionID) {
  const safe = String(sessionID).replace(/[^A-Za-z0-9._-]/g, "_")
  return path.join(stateDir(), `${safe}.json`)
}

function cloneRecord(rec) {
  return {
    system: rec.system.slice(),
    mcp: rec.mcp && Array.isArray(rec.mcp.connected) ? { connected: rec.mcp.connected.slice() } : null,
    savedAt: rec.savedAt,
  }
}

export function loadRecord(sessionID) {
  if (!sessionID) return null
  try {
    const raw = fs.readFileSync(fileFor(sessionID), "utf8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.system) || parsed.system.length === 0) return null
    const mcp =
      parsed.mcp && Array.isArray(parsed.mcp.connected) ? { connected: parsed.mcp.connected.map(String) } : null
    return { system: parsed.system.slice(), mcp, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

export function saveRecord(sessionID, rec) {
  if (!sessionID || !rec || !Array.isArray(rec.system)) return
  fs.mkdirSync(stateDir(), { recursive: true })
  const body = { system: rec.system.slice(), savedAt: rec.savedAt ?? Date.now() }
  if (rec.mcp && Array.isArray(rec.mcp.connected)) {
    body.mcp = { connected: rec.mcp.connected.slice() }
  }
  fs.writeFileSync(fileFor(sessionID), JSON.stringify(body))
}

export function forgetDisk(sessionID) {
  if (!sessionID) return
  try {
    fs.unlinkSync(fileFor(sessionID))
  } catch {
    /* missing is fine */
  }
}

function remember(sessionID, rec) {
  if (snapshots.has(sessionID)) snapshots.delete(sessionID)
  snapshots.set(sessionID, cloneRecord(rec))
  while (snapshots.size > MAX_SESSIONS) {
    const oldest = snapshots.keys().next().value
    snapshots.delete(oldest)
  }
}

export function peekRecord(sessionID) {
  if (!sessionID) return null
  const live = snapshots.get(sessionID)
  if (live) return cloneRecord(live)
  const disk = loadRecord(sessionID)
  return disk ? cloneRecord(disk) : null
}

/** @returns {"snapshot"|"restore"|"skip"} */
export function freezeSessionSystem(sessionID, system) {
  if (!sessionID || !Array.isArray(system) || !isEnvBearing(system)) return "skip"
  const prev = snapshots.get(sessionID) || loadRecord(sessionID)
  if (!prev) {
    const rec = { system: system.slice(), mcp: null, savedAt: Date.now() }
    remember(sessionID, rec)
    saveRecord(sessionID, rec)
    return "snapshot"
  }
  system.length = 0
  for (const part of prev.system) system.push(part)
  remember(sessionID, prev)
  return "restore"
}

export function setMcpConnected(sessionID, connected) {
  const rec = snapshots.get(sessionID) || loadRecord(sessionID)
  if (!rec) return
  rec.mcp = { connected: [...new Set((connected ?? []).map(String))].sort() }
  remember(sessionID, rec)
  saveRecord(sessionID, rec)
}

export function forgetSession(sessionID) {
  if (!sessionID) return
  snapshots.delete(sessionID)
  forgetDisk(sessionID)
}

export function resetSnapshots() {
  snapshots.clear()
}
