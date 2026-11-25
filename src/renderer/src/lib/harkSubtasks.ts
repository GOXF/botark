/**
 * GOXF v25 看板: the work a Hark project runs at once (browser sessions,
 * subagents, other tools), read from one `conversationSnapshot`. Panels and
 * message tool calls are merged by dispatchId. Kind and status words are
 * guesses from the names the stream uses; times are the message's own.
 */
export interface HarkSubtask {
  id: string
  kind: 'browser' | 'subagent' | 'other'
  title: string
  status: 'running' | 'waiting' | 'done' | 'failed'
  startedAt?: number
}

interface SnapPanel { dispatchId?: string; kind?: string; status?: string; title?: string; url?: string; command?: string }
interface SnapTool { dispatchId?: string; name?: string; status?: string; url?: string; command?: string; detail?: string }
interface SnapMessage { id?: string; role?: string; content?: string; createdAt?: string | number | null; triggeredBy?: string; toolCalls?: SnapTool[] }
export interface HarkSnapshotLike {
  panels?: SnapPanel[]
  messages?: SnapMessage[]
  asks?: Array<{ dispatchId?: string; status?: string }>
  requests?: Record<string, { state?: string; title?: string; doneTitle?: string; boundTo?: string }>
  activeWork?: Array<{ dispatchId?: string; messageId?: string; state?: string }>
}

export function subtaskStatus(raw: string | undefined): HarkSubtask['status'] {
  const s = (raw ?? '').toLowerCase()
  if (/wait|input|ask|block/.test(s)) return 'waiting'
  if (/fail|error|cancel/.test(s)) return 'failed'
  if (/complete|done|success|finish/.test(s)) return 'done'
  return 'running'
}

export function subtaskKind(name: string | undefined): HarkSubtask['kind'] {
  const s = (name ?? '').toLowerCase()
  if (/browser|computer/.test(s)) return 'browser'
  if (/subagent|agent/.test(s)) return 'subagent'
  return 'other'
}

function toTime(v: string | number | null | undefined): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(n) ? n : undefined
}

const ORDER: Record<HarkSubtask['status'], number> = { waiting: 0, running: 1, failed: 2, done: 3 }

export function deriveSubtasks(snap: HarkSnapshotLike | null | undefined): HarkSubtask[] {
  const out = new Map<string, HarkSubtask>()
  for (const m of snap?.messages ?? []) {
    for (const tc of m.toolCalls ?? []) {
      if (!tc.dispatchId) continue
      out.set(tc.dispatchId, {
        id: tc.dispatchId,
        kind: subtaskKind(tc.name),
        title: tc.detail || tc.url || tc.command || tc.name || '子任务',
        status: subtaskStatus(tc.status),
        startedAt: toTime(m.createdAt)
      })
    }
  }
  // Panels are the live view: they win on status and title.
  for (const p of snap?.panels ?? []) {
    if (!p.dispatchId) continue
    const prev = out.get(p.dispatchId)
    out.set(p.dispatchId, {
      id: p.dispatchId,
      kind: prev?.kind === 'subagent' ? 'subagent' : subtaskKind(p.kind) === 'other' ? (prev?.kind ?? 'other') : subtaskKind(p.kind),
      title: p.title || prev?.title || p.url || p.command || '子任务',
      status: subtaskStatus(p.status),
      startedAt: prev?.startedAt
    })
  }
  for (const a of snap?.asks ?? []) {
    const t = a.dispatchId ? out.get(a.dispatchId) : undefined
    if (t && subtaskStatus(a.status) !== 'done') t.status = 'waiting'
  }
  return [...out.values()].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/** One task = one request Hark took up (a user message), with the work its replies dispatched. */
export interface HarkTask {
  id: string
  title: string
  state: 'working' | 'open' | 'done'
  createdAt?: number
  subtasks: HarkSubtask[]
}

/**
 * Group a project's work the way Hark does: `requests` keyed by the user message,
 * a follow-up `boundTo` another request folds into it, each reply names its
 * request in `triggeredBy`, and `activeWork` lists the dispatches still running.
 */
export function deriveTasks(snap: HarkSnapshotLike | null | undefined): HarkTask[] {
  const requests = snap?.requests ?? {}
  const root = (id: string): string => {
    let cur = id
    for (let i = 0; i < 20; i++) {
      const next = requests[cur]?.boundTo
      if (!next || next === cur || !requests[next]) break
      cur = next
    }
    return cur
  }
  const subtasks = new Map(deriveSubtasks(snap).map((t) => [t.id, t]))
  const live = new Set((snap?.activeWork ?? []).filter((w) => !/complete|done|fail|cancel/i.test(w.state ?? '')).map((w) => w.dispatchId))
  for (const id of live) {
    const t = id ? subtasks.get(id) : undefined
    if (t && t.status === 'done') t.status = 'running'
  }
  const tasks = new Map<string, HarkTask>()
  const task = (id: string): HarkTask => {
    let t = tasks.get(id)
    if (!t) {
      const r = requests[id] ?? {}
      const state = /complete|done|answer|closed/i.test(r.state ?? '') ? 'done' : /work/i.test(r.state ?? '') ? 'working' : 'open'
      t = { id, title: (state === 'done' && r.doneTitle) || r.title || '', state, subtasks: [] }
      tasks.set(id, t)
    }
    return t
  }
  for (const id of Object.keys(requests)) if (root(id) === id) task(id)
  for (const m of snap?.messages ?? []) {
    if (m.id && /^user$/i.test(m.role ?? '') && requests[m.id]) {
      const t = task(root(m.id))
      if (t.id === m.id) {
        t.createdAt = toTime(m.createdAt)
        if (!t.title) t.title = (m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
      }
      continue
    }
    if (!m.triggeredBy) continue
    const t = task(root(m.triggeredBy))
    for (const tc of m.toolCalls ?? []) {
      const st = tc.dispatchId ? subtasks.get(tc.dispatchId) : undefined
      if (st && !t.subtasks.includes(st)) t.subtasks.push(st)
    }
  }
  const out = [...tasks.values()].filter((t) => t.title || t.subtasks.length)
  for (const t of out) {
    t.subtasks.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.startedAt ?? 0) - (b.startedAt ?? 0))
    if (t.state !== 'done' && t.subtasks.some((s) => s.status === 'running' || s.status === 'waiting')) t.state = 'working'
    if (!t.title) t.title = '未命名任务'
  }
  const rank = { working: 0, open: 1, done: 2 } as const
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (b.createdAt ?? 0) - (a.createdAt ?? 0))
}
