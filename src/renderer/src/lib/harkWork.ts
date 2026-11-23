/**
 * GOXF: per-project "工作中 / 完成" for Hark, same rules as the Go app
 * (hark-hub-go mod_work.go): working while a run signal came in the last 25 s
 * or Hark's status list says so; a run shorter than 8 s is not a "done"; the
 * done marker stays until the user looks at that project.
 */
export const HARK_RUN_WINDOW_MS = 25_000
export const HARK_FLASH_MS = 8_000

export interface HarkProjectWork {
  lastRun: number
  polled: boolean
  working: boolean
  since: number
  doneAt: number
}

export interface HarkWorkState {
  /** accountId → conversationId → state */
  projects: Record<string, Record<string, HarkProjectWork>>
  /** accountId → last time its bot was on screen (sidebar "完成" only counts later finishes) */
  seenAt: Record<string, number>
}

const blank: HarkProjectWork = { lastRun: -Infinity, polled: false, working: false, since: 0, doneAt: 0 }

function patch(s: HarkWorkState, acc: string, conv: string, p: Partial<HarkProjectWork>): HarkWorkState {
  const prev = s.projects[acc]?.[conv] ?? blank
  return { ...s, projects: { ...s.projects, [acc]: { ...s.projects[acc], [conv]: { ...prev, ...p } } } }
}

/** A live sign from the stream (status line, delta, tool update). */
export function markRun(s: HarkWorkState, acc: string, conv: string, now: number): HarkWorkState {
  return patch(s, acc, conv, { lastRun: now })
}

/** Hark's own status list for the account: the conversations it reports as working. */
export function setPolled(s: HarkWorkState, acc: string, workingIds: readonly string[]): HarkWorkState {
  const ids = new Set(workingIds)
  let next = s
  for (const conv of new Set([...Object.keys(s.projects[acc] ?? {}), ...ids])) {
    if ((s.projects[acc]?.[conv]?.polled ?? false) !== ids.has(conv)) next = patch(next, acc, conv, { polled: ids.has(conv) })
  }
  return next
}

/** Recompute working / done; `visible` is the project on screen, `viewed` the accounts whose bot is on screen. */
export function evaluate(
  s: HarkWorkState,
  now: number,
  visible: (acc: string, conv: string) => boolean,
  viewed: readonly string[]
): HarkWorkState {
  let next = s
  for (const [acc, convs] of Object.entries(s.projects)) {
    for (const [conv, w] of Object.entries(convs)) {
      const on = now - w.lastRun < HARK_RUN_WINDOW_MS || w.polled
      const seen = visible(acc, conv)
      if (on && !w.working) next = patch(next, acc, conv, { working: true, since: now, doneAt: 0 })
      else if (!on && w.working) {
        const done = now - w.since >= HARK_FLASH_MS && !seen
        next = patch(next, acc, conv, { working: false, ...(done ? { doneAt: now } : {}) })
      } else if (seen && w.doneAt) next = patch(next, acc, conv, { doneAt: 0 })
    }
  }
  if (viewed.length) next = { ...next, seenAt: { ...next.seenAt, ...Object.fromEntries(viewed.map((a) => [a, now])) } }
  return next
}

/** Sidebar row: how many projects work now, and the latest finish not seen yet (0 = none). */
export function accountWork(s: HarkWorkState, accountIds: readonly string[]): { working: number; doneAt: number } {
  let working = 0
  let doneAt = 0
  for (const acc of accountIds) {
    for (const w of Object.values(s.projects[acc] ?? {})) {
      if (w.working) working++
      else if (w.doneAt > (s.seenAt[acc] ?? 0)) doneAt = Math.max(doneAt, w.doneAt)
    }
  }
  return { working, doneAt }
}

/**
 * Conversation ids `/conversations/status` reports as working. Hark's web app
 * reads `.statuses` from it; the inner shape is not confirmed.
 * shortcut: accepts a map or a list and a few "working" spellings; pin it down from a real response.
 */
export function workingFromStatuses(payload: unknown): string[] | null {
  const statuses = (payload as { statuses?: unknown } | null)?.statuses
  const working = (v: unknown): boolean =>
    typeof v === 'string'
      ? /^(working|running|busy|in_progress|streaming|thinking)$/i.test(v)
      : Boolean(v && typeof v === 'object' && ((v as { working?: unknown }).working === true || working((v as { status?: unknown }).status)))
  if (Array.isArray(statuses)) {
    return statuses.flatMap((r) => {
      const id = (r as { conversationId?: unknown; id?: unknown } | null)?.conversationId ?? (r as { id?: unknown } | null)?.id
      return typeof id === 'string' && working(r) ? [id] : []
    })
  }
  if (statuses && typeof statuses === 'object') return Object.entries(statuses).filter(([, v]) => working(v)).map(([k]) => k)
  return null
}
