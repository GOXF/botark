import { describe, expect, it } from 'vitest'
import { bindPoolSlot, createMutex, migratePoolSlot, planPoolAssignment, releasePoolSlot } from './proxyPool'

const pool = (...owners: Array<string[] | string | undefined>) =>
  owners.map((o, i) => ({ id: `p${i}`, assignedAccountIds: o === undefined ? [] : Array.isArray(o) ? o : [o] }))
const owners = (p: Array<{ assignedAccountIds: string[] }>) => p.map((s) => s.assignedAccountIds)

describe('planPoolAssignment', () => {
  it('keeps existing bindings and fills new accounts from the least-loaded proxy', () => {
    const { pool: next, assigned } = planPoolAssignment(pool('a', undefined, undefined), ['a', 'b'])
    expect(owners(next)).toEqual([['a'], ['b'], []])
    expect(assigned.map((x) => [x.accountId, x.slot.id])).toEqual([['a', 'p0'], ['b', 'p1']])
  })

  it('does not drop an in-flight account binding', () => {
    // "a" is still logging in and was left out of the caller list.
    const { pool: next } = planPoolAssignment(pool('a', undefined), ['b'], (id) => id === 'a')
    expect(owners(next)).toEqual([['a'], ['b']])
  })

  it('unlimited (0) spreads evenly and shares once every proxy is used', () => {
    const { pool: next, assigned } = planPoolAssignment(pool(undefined, undefined), ['a', 'b', 'c', 'd', 'e'])
    expect(owners(next)).toEqual([['a', 'c', 'e'], ['b', 'd']])
    expect(assigned).toHaveLength(5)
  })

  it('a limit caps auto-assignment; accounts beyond capacity stay unassigned', () => {
    const { pool: next, assigned } = planPoolAssignment(pool(undefined, undefined), ['a', 'b', 'c', 'd', 'e'], undefined, 2)
    expect(owners(next)).toEqual([['a', 'c'], ['b', 'd']])
    expect(assigned.map((x) => x.accountId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('limit 1 is one-account-per-proxy', () => {
    const { pool: next, assigned } = planPoolAssignment(pool(undefined), ['a', 'b'], undefined, 1)
    expect(owners(next)).toEqual([['a']])
    expect(assigned.map((x) => x.accountId)).toEqual(['a'])
  })

  it('never unbinds manual bindings above the limit, but fills nothing more there', () => {
    // p0 was manually given three accounts with limit 2.
    const { pool: next } = planPoolAssignment(pool(['m1', 'm2', 'm3'], undefined), ['m1', 'm2', 'm3', 'x'], undefined, 2)
    expect(owners(next)).toEqual([['m1', 'm2', 'm3'], ['x']])
  })

  it('skips proxies whose last test timed out', () => {
    const slots = pool(undefined, undefined).map((s, i) => (i === 0 ? { ...s, lastTest: { ok: false } } : s))
    const { pool: next } = planPoolAssignment(slots, ['a', 'b'])
    expect(owners(next)).toEqual([[], ['a', 'b']])
  })

  it('handles accounts from several platforms in one call without dropping kept ones', () => {
    // Muse "m" and Hark "h" are targets; Grok "g" (unticked platform) is kept on its manual binding.
    const { pool: next } = planPoolAssignment(pool('g', undefined), ['m', 'h'], (id) => id === 'g')
    expect(owners(next)).toEqual([['g', 'h'], ['m']])
  })

  it('keeps the first saved binding when an account sits on two proxies', () => {
    const { pool: next } = planPoolAssignment(pool('a', ['a', 'b']), ['a', 'b'])
    expect(owners(next)).toEqual([['a'], ['b']])
  })

  it('does not mutate the input', () => {
    const input = pool('x')
    planPoolAssignment(input, ['y'])
    expect(input[0]!.assignedAccountIds).toEqual(['x'])
  })
})

describe('releasePoolSlot / bindPoolSlot / migratePoolSlot', () => {
  it('frees only that account', () => {
    expect(owners(releasePoolSlot(pool(['a', 'c'], 'b'), 'a'))).toEqual([['c'], ['b']])
  })

  it('manual binding moves the account and ignores any limit', () => {
    expect(owners(bindPoolSlot(pool(['a', 'b'], 'c'), 'c', 'p0'))).toEqual([['a', 'b', 'c'], []])
  })

  it('reads the old single-owner pool format', () => {
    expect(migratePoolSlot({ id: 'p', assignedAccountId: 'a' })).toEqual({ id: 'p', assignedAccountIds: ['a'] })
    expect(migratePoolSlot({ id: 'p' })).toEqual({ id: 'p', assignedAccountIds: [] })
  })
})

describe('createMutex', () => {
  it('runs sections one at a time even across awaits', async () => {
    const lock = createMutex()
    let value = 0
    const bump = () =>
      lock(async () => {
        const read = value
        await new Promise((r) => setTimeout(r, 5))
        value = read + 1
      })
    await Promise.all([bump(), bump(), bump()])
    expect(value).toBe(3)
  })

  it('keeps going after a section throws', async () => {
    const lock = createMutex()
    await expect(lock(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(lock(() => 1)).resolves.toBe(1)
  })
})
