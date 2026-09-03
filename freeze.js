import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAX_SESSIONS = 32
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

export function loadDisk(sessionID) {
  if (!sessionID) return null
  try {
    const raw = fs.readFileSync(fileFor(sessionID), "utf8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.system) && parsed.system.length > 0) return parsed.system
  } catch {
    return null
  }
  return null
}

export function saveDisk(sessionID, system) {
  if (!sessionID || !Array.isArray(system)) return
  fs.mkdirSync(stateDir(), { recursive: true })
  fs.writeFileSync(
    fileFor(sessionID),
    JSON.stringify({ system: system.slice(), savedAt: Date.now() }),
  )
}

export function forgetDisk(sessionID) {
  if (!sessionID) return
  try {
    fs.unlinkSync(fileFor(sessionID))
  } catch {
    /* missing is fine */
  }
}

function remember(sessionID, system) {
  if (snapshots.has(sessionID)) snapshots.delete(sessionID)
  snapshots.set(sessionID, system.slice())
  while (snapshots.size > MAX_SESSIONS) {
    const oldest = snapshots.keys().next().value
    snapshots.delete(oldest)
  }
}

/** @returns {"snapshot"|"restore"|"skip"} */
export function freezeSessionSystem(sessionID, system) {
  if (!sessionID || !Array.isArray(system) || !isEnvBearing(system)) return "skip"
  const prev = snapshots.get(sessionID) || loadDisk(sessionID)
  if (!prev) {
    remember(sessionID, system)
    saveDisk(sessionID, system)
    return "snapshot"
  }
  system.length = 0
  for (const part of prev) system.push(part)
  remember(sessionID, prev)
  return "restore"
}

export function forgetSession(sessionID) {
  if (!sessionID) return
  snapshots.delete(sessionID)
  forgetDisk(sessionID)
}

export function resetSnapshots() {
  snapshots.clear()
}
