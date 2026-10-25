// V2 (OpenCode 2.x) implementation of the prefix freeze.
//
// V2 replaced the plugin API wholesale: `experimental.chat.system.transform` no
// longer exists. The system prompt is assembled per model call and handed to a
// `context` hook as `event.system` (SystemPart[]), alongside `event.tools`.
// That hook is the same lever, one level over: rewrite the outgoing system block
// so the head of the prompt is byte-identical to the session's first turn.
//
// Why the whole block and not just the date: a prefix cache is a hash chain over
// tokens. One changed token at position k invalidates every block after it, so
// the date, the skills list, the AGENTS.md text and the MCP prose are all
// head-breakers. Freezing the block makes the head boring; new information still
// arrives, because anything appended goes *after* the frozen prefix.
//
// Snapshot lives on disk (one JSON per session) so a resumed session keeps the
// head it was stored under, even across an OpenCode service restart.

import fs from "node:fs"
import path from "node:path"
import {
  DATE_LINE,
  changedPartKeys,
  classifyPart,
  digestHex,
  partDigests,
  stateDir,
} from "./freeze.js"

const DATE_VALUE = /Today's date:\s+([A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4})/

export const MAX_STATE_FILES = 512
const TERMINAL = new Set(["connected", "failed", "needs_auth", "needs_client_registration"])

/** A SystemPart is `{ type: "text", text }`; tolerate plain strings. */
export function partText(part) {
  if (typeof part === "string") return part
  if (part && typeof part.text === "string") return part.text
  return ""
}

export function systemText(parts) {
  return (Array.isArray(parts) ? parts : []).map(partText).filter(Boolean).join("\n")
}

export function dateOf(parts) {
  const match = systemText(parts).match(DATE_VALUE)
  return match ? match[1] : null
}

/** Rewrite only the date field, leaving the rest of the prompt live. */
export function rewriteDate(parts, date) {
  if (!date || !Array.isArray(parts)) return false
  let hit = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const text = partText(part)
    if (!text || !DATE_LINE.test(text)) continue
    const next = text.replace(DATE_LINE, `Today's date: ${date}`)
    if (typeof part === "string") parts[i] = next
    else part.text = next
    hit = true
  }
  return hit
}

export function toolIds(tools) {
  return Object.keys(tools && typeof tools === "object" ? tools : {}).sort()
}

export function toolsDigest(tools) {
  const ids = toolIds(tools)
  const body = ids.map((id) => [
    id,
    String(tools[id]?.description ?? ""),
    JSON.stringify(tools[id]?.input ?? {}),
  ])
  return digestHex(JSON.stringify(body))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function fileFor(sessionID) {
  const safe = String(sessionID).replace(/[^A-Za-z0-9._-]/g, "_")
  return path.join(stateDir(), `v2-${safe}.json`)
}

export function loadSnapshot(sessionID) {
  if (!sessionID) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(sessionID), "utf8"))
    if (parsed?.v !== 2 || !Array.isArray(parsed.system)) return null
    return parsed
  } catch {
    return null
  }
}

function pruneState() {
  try {
    const dir = stateDir()
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("v2-") && name.endsWith(".json"))
      .map((name) => {
        const full = path.join(dir, name)
        return { full, mtime: fs.statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const extra of files.slice(MAX_STATE_FILES)) {
      try {
        fs.unlinkSync(extra.full)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* pruning must never break a turn */
  }
}

export function saveSnapshot(sessionID, snapshot) {
  if (!sessionID) return
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(fileFor(sessionID), JSON.stringify(snapshot))
    pruneState()
  } catch {
    /* a failed write only costs the next miss */
  }
}

export function forgetSnapshot(sessionID) {
  if (!sessionID) return
  try {
    fs.unlinkSync(fileFor(sessionID))
  } catch {
    /* missing is fine */
  }
}

// ---------------------------------------------------------------- MCP wait
// GET /api/mcp answers [{ name, status: { status: "connected" } }].
// Tolerate a bare string, a flat {status}, and the nested shape.
function statusOf(value) {
  if (typeof value === "string") return value
  const inner = value?.status ?? value?.state
  if (typeof inner === "string") return inner
  if (inner && typeof inner === "object") return String(inner.status ?? inner.state ?? "")
  return ""
}

function settled(statuses) {
  const names = Object.keys(statuses ?? {})
  if (names.length === 0) return true
  return names.every((name) => TERMINAL.has(statusOf(statuses[name])))
}

async function mcpStatus(ctx) {
  try {
    const out = await ctx?.mcp?.list?.()
    const data = out?.data ?? out
    if (Array.isArray(data)) {
      const map = {}
      for (const entry of data) {
        if (Array.isArray(entry)) map[String(entry[0])] = entry[1]
        else if (entry?.name) map[String(entry.name)] = entry.status ?? entry.state ?? entry
      }
      return map
    }
    return data && typeof data === "object" ? data : {}
  } catch {
    return {}
  }
}

/**
 * Wait for MCP servers to reach a terminal state before the first snapshot.
 * Connecting servers report `disabled` on the status endpoint, so `disabled`
 * is treated as in-flight (same rule as the V1 plugin).
 */
export async function waitForMcp(ctx, { timeoutMs = 5000, intervalMs = 150, sleep } = {}) {
  const nap = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const started = Date.now()
  if (!ctx?.mcp?.list || timeoutMs <= 0) return { ok: true, elapsed: 0, statuses: {} }
  let statuses = await mcpStatus(ctx)
  if (settled(statuses)) return { ok: true, elapsed: Date.now() - started, statuses }
  while (Date.now() - started < timeoutMs) {
    await nap(intervalMs)
    statuses = await mcpStatus(ctx)
    if (settled(statuses)) return { ok: true, elapsed: Date.now() - started, statuses }
  }
  return { ok: false, elapsed: Date.now() - started, statuses }
}

// ---------------------------------------------------------------- the hook
/**
 * @param {object} ctx        plugin context (needs ctx.mcp.list)
 * @param {object} options    mode: "all" | "date", freezeTools, waitMs, waitIntervalMs, log
 * @returns {(event: object) => Promise<void>}
 */
export function makeContextHook(ctx, options = {}) {
  const mode = options.mode === "date" ? "date" : "all"
  const freezeTools = options.freezeTools !== false
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 5000
  const waitIntervalMs = Number.isFinite(options.waitIntervalMs) ? options.waitIntervalMs : 150
  const log = typeof options.log === "function" ? options.log : () => {}

  async function apply(event) {
    const sessionID = event?.sessionID
    const parts = event?.system
    if (!sessionID || !Array.isArray(parts)) return
    const tools = event?.tools && typeof event.tools === "object" ? event.tools : {}
    const short = String(sessionID).slice(0, 12)

    const text = systemText(parts)
    const sha = digestHex(text)
    const partsNow = partDigests(parts.map(partText))
    const toolsSha = toolsDigest(tools)
    const snap = loadSnapshot(sessionID)

    if (!snap) {
      const waited = await waitForMcp(ctx, { timeoutMs: waitMs, intervalMs: waitIntervalMs })
      const connected = Object.entries(waited.statuses ?? {})
        .filter(([, v]) => statusOf(v) === "connected")
        .map(([k]) => k)
        .join(",")
      const date = dateOf(parts)
      saveSnapshot(sessionID, {
        v: 2,
        savedAt: Date.now(),
        date,
        sha,
        system: clone(parts),
        parts: partsNow,
        tools: toolIds(tools),
        toolsSha,
      })
      log(
        `snapshot v2 session=${short} date=${(date ?? "none").replaceAll(" ", "_")} sha=${sha} parts=${parts.length} bytes=${text.length} tools=${toolIds(tools).length} wait=${waited.ok ? "ok" : "timeout"}/${waited.elapsed}ms connected=${connected || "-"} ` +
          Object.keys(partsNow)
            .map((k) => `${k}=${partsNow[k]}`)
            .join(" "),
      )
      return
    }

    const vsSnap = changedPartKeys(snap.parts, partsNow)
    const vsLast = changedPartKeys(snap.lastParts ?? snap.parts, partsNow)
    let restored = 0
    let mismatched = 0

    if (mode === "all") {
      const frozen = Array.isArray(snap.system) ? snap.system : []
      const limit = Math.min(frozen.length, parts.length)
      for (let i = 0; i < limit; i++) {
        if (classifyPart(partText(parts[i])) !== classifyPart(partText(frozen[i]))) {
          mismatched += 1
          continue
        }
        if (partText(parts[i]) !== partText(frozen[i])) {
          parts[i] = clone(frozen[i])
          restored += 1
        }
      }
      // Parts the runtime dropped since the snapshot are re-added at their index;
      // parts it added are kept and stay *after* the frozen head (tail change only).
      if (frozen.length > parts.length) {
        for (let i = parts.length; i < frozen.length; i++) parts.push(clone(frozen[i]))
        restored += frozen.length - limit
      }
    } else if (snap.date) {
      if (rewriteDate(parts, snap.date)) restored += 1
    }

    const idsNow = toolIds(tools)
    const known = new Set(snap.tools ?? [])
    const added = idsNow.filter((id) => !known.has(id))
    const removed = [...known].filter((id) => !(id in tools))
    let dropped = 0
    if (freezeTools && added.length) {
      for (const id of added) delete tools[id]
      dropped = added.length
    }

    saveSnapshot(sessionID, {
      ...snap,
      lastSha: sha,
      lastParts: partsNow,
      restoredAt: Date.now(),
    })

    log(
      `restore v2 session=${short} mode=${mode} date=${(snap.date ?? "none").replaceAll(" ", "_")} sha=${sha} snap=${snap.sha} prev=${snap.lastSha ?? "-"} vs_snap=${vsSnap.join(",") || "-"} vs_last=${vsLast.join(",") || "-"} parts=${parts.length} bytes=${text.length} restored=${restored} mismatch=${mismatched} tools=${known.size} tools_added=${added.length} tools_dropped=${dropped} tools_removed=${removed.length} tools_changed=${toolsSha !== snap.toolsSha ? 1 : 0} ` +
        Object.keys(partsNow)
          .map((k) => `${k}=${partsNow[k]}`)
          .join(" "),
    )
  }

  // A plugin on the model path must never break a turn: any failure here only
  // costs the next cache miss.
  return async function contextHook(event) {
    try {
      await apply(event)
    } catch (err) {
      try {
        log(`error session=${String(event?.sessionID ?? "?").slice(0, 12)} ${err?.message ?? err}`)
      } catch {
        /* ignore */
      }
    }
  }
}

export function freezeMode(value) {
  const fromEnv = process.env.OPENCODE_CONSISTENT_FREEZE
  const chosen = String(value ?? fromEnv ?? "all").toLowerCase()
  return chosen === "date" ? "date" : "all"
}
