const MAX_SESSIONS = 32
const snapshots = new Map()

export function isEnvBearing(system) {
  if (!Array.isArray(system) || system.length === 0) return false
  const text = system.join("\n")
  return text.includes("<env>") || text.includes("Today's date:")
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
  const prev = snapshots.get(sessionID)
  if (!prev) {
    remember(sessionID, system)
    return "snapshot"
  }
  system.length = 0
  for (const part of prev) system.push(part)
  snapshots.delete(sessionID)
  snapshots.set(sessionID, prev)
  return "restore"
}

export function forgetSession(sessionID) {
  if (sessionID) snapshots.delete(sessionID)
}

export function resetSnapshots() {
  snapshots.clear()
}
