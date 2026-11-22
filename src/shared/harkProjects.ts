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
