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

// ---------------------------------------------------------------- the head
/**
 * Put the frozen head back on an outgoing request: the system parts (mode "all") and the tool
 * block, in both directions. The context hook and the compaction hook share it. A compaction
 * request is assembled from the same head as the session's own request, so freezing it there is
 * what lets the summary reuse the session's prompt cache instead of prefilling the conversation.
 *
 * Mutates `event.system` and `event.tools` in place, which is what the hook event hands over.
 */
export function freezeHead(event, snap, options = {}) {
  const mode = options.mode === "date" ? "date" : "all"
  const freezeTools = options.freezeTools !== false
  const parts = event?.system
  let restored = 0
  let mismatched = 0

  if (Array.isArray(parts) && Array.isArray(snap?.system)) {
    if (mode === "all") {
      const frozen = snap.system
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
  }

  const tools = event?.tools && typeof event.tools === "object" ? event.tools : null
  const idsNow = toolIds(tools)
  const known = new Set(snap?.tools ?? [])
  const added = idsNow.filter((id) => !known.has(id))
  const removed = [...known].filter((id) => !(tools && id in tools))
  let dropped = 0
  let readded = 0
  if (tools && freezeTools) {
    if (added.length) {
      for (const id of added) delete tools[id]
      dropped = added.length
    }
    // A tool that went away (an MCP server disconnecting, a preset switching) shrinks the
    // array and moves the head just as an addition does. Put its stored definition back so
    // the block stays byte-identical: a call to it now fails at the tool, which is cheaper
    // than losing the whole conversation's prefix to a re-prefill.
    if (removed.length && snap.toolDefs && typeof snap.toolDefs === "object") {
      for (const id of removed) {
        if (!(id in snap.toolDefs)) continue
        tools[id] = clone(snap.toolDefs[id])
        readded += 1
      }
    }
  }
  return { restored, mismatched, known, added, removed, dropped, readded }
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
  // The conversation is kept so a compaction request can be rebuilt from the real history
  // instead of the re-rendered transcript. Capped: one turn of a 1M-token session is a few MB,
  // and past the cap the rewrite simply is not offered (a compaction stays cold, no worse).
  const maxChars =
    Number.isFinite(options.compactionMaxMb) && options.compactionMaxMb > 0
      ? options.compactionMaxMb * 1024 * 1024
      : 16 * 1024 * 1024
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
        // The definitions, not just the ids: a tool that DISAPPEARS mid-session shrinks the
        // array and moves the tool block, which sits ahead of the conversation. Without these
        // the head cannot be restored; ids alone can only drop a tool that arrived late.
        toolDefs: clone(tools),
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
    const { restored, mismatched, known, added, removed, dropped, readded } = freezeHead(event, snap, {
      mode,
      freezeTools,
    })

    // Keep the conversation this turn carried: a compaction request is built from a re-rendered
    // transcript, so the real history has to come from here. Skipped above the cap.
    const msgs = Array.isArray(event.messages) ? event.messages : null
    let msgsChars = 0
    let compactionMessages = snap.compactionMessages ?? null
    if (msgs && msgs.length) {
      msgsChars = JSON.stringify(msgs).length
      if (msgsChars <= maxChars) compactionMessages = clone(msgs)
      else compactionMessages = null
    }

    saveSnapshot(sessionID, {
      ...snap,
      lastSha: sha,
      lastParts: partsNow,
      compactionMessages,
      compactionChars: msgsChars,
      restoredAt: Date.now(),
    })

    log(
      `restore v2 session=${short} keys=${Object.keys(event ?? {}).join(",")} mode=${mode} date=${(snap.date ?? "none").replaceAll(" ", "_")} sha=${sha} snap=${snap.sha} prev=${snap.lastSha ?? "-"} vs_snap=${vsSnap.join(",") || "-"} vs_last=${vsLast.join(",") || "-"} parts=${parts.length} bytes=${text.length} restored=${restored} mismatch=${mismatched} tools=${known.size} tools_added=${added.length} tools_dropped=${dropped} tools_removed=${removed.length} tools_readded=${readded} tools_changed=${toolsSha !== snap.toolsSha ? 1 : 0} msgs=${msgs ? msgs.length : 0} msgs_chars=${msgsChars} kept=${compactionMessages ? 1 : 0} ` +
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

/**
 * The compaction hook: the one event the context hook never sees.
 *
 * A compaction request is assembled from the session's own head (system + tool block) and then the
 * conversation. When the conversation fits the model's window it is sent as the real messages plus a
 * trailing instruction — measured on the serving pair, the request size tracks the session's prompt
 * to within the instruction (610,665 vs 610,290 tokens), so the body is not re-rendered. What was
 * missing is the head: the context hook never fires for a compaction, so the system block went out
 * live instead of frozen and the prefix cache resumed at a few hundred tokens.
 *
 * `freezeHead` here fixes exactly that: the compaction request then shares the session's prefix and
 * only the instruction is new. When the conversation does NOT fit, OpenCode squeezes it into a
 * transcript (detail levels, `[N older exchanges omitted]`) and no prefix survives past the head —
 * that one is inherent. `rewriteCompaction` additionally substitutes the real conversation when it
 * sees a rendered one; it is a no-op on a request that was already real.
 *
 * Diagnostic logging is always on; the freeze itself is always applied when a snapshot exists.
 */
export function makeCompactionHook(ctx, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {}
  const mode = options.mode === "date" ? "date" : "all"
  const freezeTools = options.freezeTools !== false
  // Verified against a real compaction the moment it can be: on, and reversible by setting
  // rewriteCompaction: false. It only acts when a stored conversation exists.
  const rewrite = options.rewriteCompaction === true

  return async function compactionHook(event) {
    const short = String(event?.sessionID ?? "?").slice(0, 12)
    try {
      const tools = event?.tools && typeof event.tools === "object" ? event.tools : null
      const msgs = Array.isArray(event?.messages) ? event.messages : null
      const text = (m) => (typeof m === "string" ? m : Array.isArray(m?.content) ? m.content.map((c) => c?.text ?? "").join("") : "")
      const sizes = msgs ? msgs.map((m) => text(m).length) : []
      // The transcript renderer prefixes each line with "[User]: " / "[Assistant]: " (and
      // "[Assistant tool call]: ", "[Tool result]: "), not "## User" as an earlier guess had it.
      const rendered = msgs
        ? /^\[(User|Assistant)\]:/.test(text(msgs[0]) ?? "") ||
          msgs.some((m) => /\[\d+ older exchanges? omitted\]/.test(text(m)))
        : false
      log(
        `compaction session=${short} keys=${Object.keys(event ?? {}).join(",")} ` +
          `tools=${tools ? Object.keys(tools).length : "none"} messages=${msgs ? msgs.length : "none"} ` +
          `chars=${msgs ? sizes.reduce((a, b) => a + b, 0) : 0} rendered=${rendered ? 1 : 0} ` +
          `roles=${msgs ? msgs.map((m) => String(m?.role ?? "?")).join("").slice(0, 40) : "-"}`,
      )
      const snap = loadSnapshot(event.sessionID)
      if (!snap) return log(`compaction session=${short} head skipped: no snapshot`)
      // The same head the session's own turns went out under. Without this the compaction request
      // starts with the live system block and shares nothing with the cached prefix.
      const head = freezeHead(event, snap, { mode, freezeTools })
      log(
        `compaction session=${short} head restored=${head.restored} mismatch=${head.mismatched} ` +
          `tools_added=${head.added.length} tools_dropped=${head.dropped} tools_readded=${head.readded}`,
      )
      if (!rewrite || !msgs) return
      let real = Array.isArray(snap.compactionMessages) ? snap.compactionMessages : null
      if (!real) {
        // A session that has not taken a turn in this process (a fresh fork, a resume) has nothing
        // captured yet. Ask the server for its context instead of giving up: the conversation is
        // there, it just never passed through the context hook.
        try {
          const out = await ctx?.session?.context?.({ sessionID: event.sessionID })
          // GET /api/session/{id}/context answers { data: Message.Info[] } — an array, not
          // { messages }. Tolerate both, and any wrapper the SDK adds.
          const c = out?.data ?? out
          const list = Array.isArray(c) ? c : Array.isArray(c?.messages) ? c.messages : null
          if (list && list.length) {
            real = list
            log(`compaction session=${short} context fetched from the server messages=${real.length}`)
          } else {
            log(`compaction session=${short} context fetch returned no messages shape=${Object.keys(c ?? {}).join(",") || typeof c}`)
          }
        } catch (err) {
          log(`compaction session=${short} context fetch failed ${err?.message ?? err}`)
        }
      }
      if (!real) return log(`compaction session=${short} rewrite skipped: no conversation available`)
      // The instruction is NOT part of this event: OpenCode appends it to the messages AFTER the
      // hook (messages: [...le, wa.user(instruction)]). So substitute the real conversation and
      // append nothing — the harness adds its own instruction, which is what its reply validation
      // expects, and the prefix then matches the session's own tokens.
      log(`compaction session=${short} rendered=${rendered ? 1 : 0} real=${real.length} event=${msgs.length}`)
      event.messages = real
      log(`compaction session=${short} rewritten messages=${real.length} tools=${Object.keys(event.tools ?? {}).length}`)
    } catch (err) {
      try {
        log(`compaction error session=${short} ${err?.message ?? err}`)
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
