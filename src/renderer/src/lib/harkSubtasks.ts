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
interface SnapMessage { createdAt?: string | number | null; toolCalls?: SnapTool[] }
export interface HarkSnapshotLike {
  panels?: SnapPanel[]
  messages?: SnapMessage[]
  asks?: Array<{ dispatchId?: string; status?: string }>
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
