export interface HarkProject {
  id: string
  title: string
  archived: boolean
  main: boolean
}

export function harkProjects(payload: unknown): HarkProject[] {
  const rows = Array.isArray(payload) ? payload : (payload as { conversations?: unknown } | null)?.conversations
  if (!Array.isArray(rows)) throw new Error('Hark returned an invalid conversation list')
  return rows.flatMap((row) => typeof row?.id === 'string' ? [{
    id: row.id,
    title: row.title ?? '主会话',
    main: row.title == null,
    archived: row.archivedAt != null
  }] : [])
}

/**
 * Body for `POST /conversations` (new Hark project). Hark now rejects the
 * request with "autoTitle is required for projects" unless `autoTitle` is sent,
 * and expects the client's IANA `timezone` alongside the title.
 * A user-supplied title is kept as-is (`autoTitle: false`); an empty one lets
 * Hark name the project from its first message.
 */
export function harkCreateProjectBody(title: string | undefined, timezone: string): {
  title: string
  timezone: string
  autoTitle: boolean
} {
  const trimmed = title?.trim() ?? ''
  return { title: trimmed || '新项目', timezone, autoTitle: trimmed === '' }
}

/** Background re-fetch cadence for the project list while BotArk is visible. */
export const HARK_PROJECTS_POLL_MS = 60_000
/** Focus / menu-open refreshes closer together than this are skipped. */
export const HARK_PROJECTS_MIN_REFRESH_GAP_MS = 5_000
/** Hark may not list a just-created project yet; keep it locally this long. */
export const HARK_PENDING_PROJECT_TTL_MS = 120_000

export interface HarkPendingProject {
  id: string
  title: string
  createdAt: number
}

/**
 * Merge projects BotArk just created into the server list. Hark's
 * `GET /conversations` can lag the `POST` by a moment, which used to leave a
 * freshly created project missing from the list until the next reload.
 * A pending entry is dropped as soon as the server lists that id, or once it
 * is older than {@link HARK_PENDING_PROJECT_TTL_MS}.
 */
export function mergePendingHarkProjects(
  rows: HarkProject[],
  pending: HarkPendingProject[],
  now: number
): HarkProject[] {
  const known = new Set(rows.map((r) => r.id))
  const extra = pending
    .filter((p) => !known.has(p.id) && now - p.createdAt < HARK_PENDING_PROJECT_TTL_MS)
    .map((p) => ({ id: p.id, title: p.title, main: false, archived: false }))
  if (!extra.length) return rows
  const mainIndex = rows.findIndex((r) => r.main)
  // Keep the main conversation first, then the newest projects.
  return mainIndex === -1
    ? [...extra, ...rows]
    : [...rows.slice(0, mainIndex + 1), ...extra, ...rows.slice(mainIndex + 1)]
}

/** Pending entries still worth keeping after a fresh server list. */
export function prunePendingHarkProjects(
  rows: HarkProject[],
  pending: HarkPendingProject[],
  now: number
): HarkPendingProject[] {
  const known = new Set(rows.map((r) => r.id))
  return pending.filter((p) => !known.has(p.id) && now - p.createdAt < HARK_PENDING_PROJECT_TTL_MS)
}

/** Throttle for opportunistic refreshes (window focus, menu open). */
export function shouldRefreshHarkProjects(lastFetchAt: number, now: number): boolean {
  return now - lastFetchAt >= HARK_PROJECTS_MIN_REFRESH_GAP_MS
}
