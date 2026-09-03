import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAX_SESSIONS = 32
/** JS Date#toDateString: "Thu Sep 03 2026" */
export const DATE_LINE = /Today's date:\s+[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}/
const DATE_VALUE = /Today's date:\s+([A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4})/

/** @type {Map<string, { date: string, mcp: { connected: string[] } | null, savedAt?: number }>} */
const snapshots = new Map()

export function extractDate(system) {
  const text = Array.isArray(system) ? system.join("\n") : typeof system === "string" ? system : ""
  const match = text.match(DATE_VALUE)
  return match ? match[1] : null
}

export function applyDate(system, date) {
  if (!date || !Array.isArray(system)) return false
  let hit = false
  for (let i = 0; i < system.length; i++) {
    if (DATE_LINE.test(system[i])) {
      system[i] = system[i].replace(DATE_LINE, `Today's date: ${date}`)
      hit = true
    }
  }
  return hit
}

export function isEnvBearing(system) {
  return extractDate(system) != null
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
    date: rec.date,
    mcp: rec.mcp && Array.isArray(rec.mcp.connected) ? { connected: rec.mcp.connected.slice() } : null,
    savedAt: rec.savedAt,
  }
}

export function loadRecord(sessionID) {
  if (!sessionID) return null
  try {
    const raw = fs.readFileSync(fileFor(sessionID), "utf8")
    const parsed = JSON.parse(raw)
    let date = typeof parsed.date === "string" ? parsed.date : null
    if (!date && Array.isArray(parsed.system)) date = extractDate(parsed.system)
    if (!date) return null
    const mcp =
      parsed.mcp && Array.isArray(parsed.mcp.connected) ? { connected: parsed.mcp.connected.map(String) } : null
    return { date, mcp, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

export function saveRecord(sessionID, rec) {
  if (!sessionID || !rec?.date) return
  fs.mkdirSync(stateDir(), { recursive: true })
  const body = { date: rec.date, savedAt: rec.savedAt ?? Date.now() }
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
  if (!sessionID || !Array.isArray(system)) return "skip"
  const date = extractDate(system)
  if (!date) return "skip"
  const prev = snapshots.get(sessionID) || loadRecord(sessionID)
  if (!prev) {
    const rec = { date, mcp: null, savedAt: Date.now() }
    remember(sessionID, rec)
    saveRecord(sessionID, rec)
    return "snapshot"
  }
  applyDate(system, prev.date)
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
