/** Pure proxy-pool bookkeeping, shared by the main process and tests. */

export interface PoolSlot {
  id: string
  assignedAccountIds: string[]
  /** Last 测速 result; a timed-out proxy (`ok: false`) is skipped by auto-assignment. */
  lastTest?: { ok: boolean }
}

/** Pool files written before N-per-proxy held a single `assignedAccountId`. */
export function migratePoolSlot<T extends PoolSlot>(raw: Omit<T, 'assignedAccountIds'> & { assignedAccountIds?: string[]; assignedAccountId?: string }): T {
  const { assignedAccountId, ...rest } = raw
  return { ...rest, assignedAccountIds: raw.assignedAccountIds ?? (assignedAccountId ? [assignedAccountId] : []) } as T
}

/**
 * Give every account in `accountIds` a pool slot. Accounts already bound keep
 * theirs (manual bindings are never limited); unbound ones go to the
 * least-loaded proxy that is under `limit` (0 = unlimited) and did not time out.
 *
 * A binding is dropped only when its account is neither listed nor kept alive
 * by `keep` (e.g. a login still in flight), so partial caller lists never free
 * a live account's proxy.
 */
export function planPoolAssignment<T extends PoolSlot>(
  pool: readonly T[],
  accountIds: readonly string[],
  keep: (accountId: string) => boolean = () => false,
  limit = 0
): { pool: T[]; assigned: Array<{ accountId: string; slot: T }> } {
  const listed = new Set(accountIds)
  const next = pool.map((slot) => ({
    ...slot,
    assignedAccountIds: slot.assignedAccountIds.filter((id) => listed.has(id) || keep(id))
  }))
  const assigned: Array<{ accountId: string; slot: T }> = []
  for (const accountId of listed) {
    let slot = next.find((s) => s.assignedAccountIds.includes(accountId))
    if (!slot) {
      for (const s of next) {
        if (s.lastTest?.ok === false || (limit > 0 && s.assignedAccountIds.length >= limit)) continue
        if (!slot || s.assignedAccountIds.length < slot.assignedAccountIds.length) slot = s
      }
      if (!slot) continue // every proxy is full or down: this account stays on its current setting
      slot.assignedAccountIds.push(accountId)
    }
    assigned.push({ accountId, slot })
  }
  return { pool: next, assigned }
}

/** Free the binding held by one account (failed/cancelled login, deleted account, switched away). */
export function releasePoolSlot<T extends PoolSlot>(pool: readonly T[], accountId: string): T[] {
  return pool.map((slot) =>
    slot.assignedAccountIds.includes(accountId)
      ? { ...slot, assignedAccountIds: slot.assignedAccountIds.filter((id) => id !== accountId) }
      : slot
  )
}

/** Manual binding: move the account onto `poolId`, ignoring any per-proxy limit. */
export function bindPoolSlot<T extends PoolSlot>(pool: readonly T[], accountId: string, poolId: string): T[] {
  return releasePoolSlot(pool, accountId).map((slot) =>
    slot.id === poolId ? { ...slot, assignedAccountIds: [...slot.assignedAccountIds, accountId] } : slot
  )
}

/** Serialize async read-modify-write sections (JSON stores on disk). */
export function createMutex(): <R>(fn: () => Promise<R> | R) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve()
  return <R>(fn: () => Promise<R> | R): Promise<R> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => undefined)
    return run
  }
}
