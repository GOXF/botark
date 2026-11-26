import { useEffect } from 'react'
import { create } from 'zustand'
import { getBridge } from '@/lib/bridge'
import { useBotStore } from '@/store/botStore'

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** Hark /billing/summary says the account has no tokens left (state, the period pool or today's allowance). */
export function harkQuotaExhausted(summary: unknown): boolean {
  const s = obj(summary)
  if (!s) return false
  const t = obj(obj(s['meters'])?.['harkTokens'])
  const n = (k: string) => Number(t?.[k] ?? 0)
  return s['state'] === 'exhausted' ||
    (n('poolLimit') > 0 && n('poolUsed') >= n('poolLimit')) ||
    (n('dailyLimit') > 0 && n('dailyUsed') >= n('dailyLimit'))
}

/** GOXF: which Hark accounts are out of quota, for the sidebar badge. Filled by the info panel and the watcher. */
export const useHarkQuota = create<{ exhausted: Record<string, boolean>; set: (accountId: string, v: boolean) => void }>((set) => ({
  exhausted: {},
  set: (accountId, v) => set((s) => (s.exhausted[accountId] === v ? s : { exhausted: { ...s.exhausted, [accountId]: v } }))
}))

const CHECK_MS = 10 * 60_000
const lastCheck = new Map<string, number>()

async function check(accountId: string): Promise<void> {
  const hark = getBridge()?.hark
  if (!hark?.rpc) return
  lastCheck.set(accountId, Date.now())
  const res = await hark.rpc({ accountId, op: 'call', method: 'GET', path: '/billing/summary' }).catch(() => null)
  if (res?.ok) useHarkQuota.getState().set(accountId, harkQuotaExhausted(res.data))
}

/** Look at a signed-in Hark account's quota now and every 10 minutes (shared across rows of one account). */
export function useHarkQuotaWatch(accountId: string | undefined, enabled: boolean): boolean {
  const status = useBotStore((s) => (accountId ? s.accounts[accountId]?.status : undefined))
  const signedIn = enabled && !!accountId && status !== undefined && status !== 'offline' && status !== 'error'
  useEffect(() => {
    if (!signedIn || !accountId) return
    const tick = () => { if (Date.now() - (lastCheck.get(accountId) ?? 0) >= CHECK_MS) void check(accountId) }
    tick()
    const timer = setInterval(tick, 60_000)
    return () => clearInterval(timer)
  }, [accountId, signedIn])
  return useHarkQuota((s) => (accountId ? Boolean(s.exhausted[accountId]) : false))
}
