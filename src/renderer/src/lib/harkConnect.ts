import { getBridge } from '@/lib/bridge'

/** Where Hark's link session returns once the provider granted access. */
export const HARK_CONNECT_RETURN_URL = 'https://app.hark.com/settings/connected-accounts'

type Rpc = (path: string, method: 'GET' | 'POST', body?: unknown) => Promise<unknown>

function harkRpc(accountId: string): Rpc | undefined {
  const hark = getBridge()?.hark
  if (!hark?.rpc) return undefined
  return async (path, method, body) => {
    const res = await hark.rpc({ accountId, op: 'call', method, path, ...(body ? { body } : {}) })
    if (!res.ok) throw new Error(res.message || 'request failed')
    return res.data
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** True when Hark's /connectors list shows `provider` connected (flag or at least one account). */
export function providerConnected(list: unknown, provider: string): boolean {
  const rows = obj(list)?.['connectors']
  if (!Array.isArray(rows)) return false
  const want = provider.toLowerCase()
  return rows.some((row) => {
    const r = obj(row) ?? {}
    const id = String(r['id'] ?? r['provider'] ?? '').toLowerCase()
    if (id !== want) return false
    return Boolean(r['connected']) || (Array.isArray(r['accounts']) && r['accounts'].length > 0)
  })
}

export async function isHarkProviderConnected(accountId: string, provider: string): Promise<boolean> {
  const rpc = harkRpc(accountId)
  if (!rpc) return false
  try {
    return providerConnected(await rpc('/connectors', 'GET'), provider)
  } catch {
    return false
  }
}

/**
 * GOXF: connect a Hark connector from a chat card. The auth page opens in a BotArk window on
 * the Hark account's session (system browser only when asked), and we report back whether the
 * provider is connected afterwards. `external` means the page went to the system browser.
 */
export async function connectHarkProvider(
  accountId: string,
  provider: string,
  opts: { origin?: 'chat' | 'settings'; external?: boolean } = {}
): Promise<'connected' | 'not-connected' | 'external'> {
  const bridge = getBridge()
  let startUrl = HARK_CONNECT_RETURN_URL
  const rpc = harkRpc(accountId)
  if (rpc) {
    try {
      const d = obj(
        await rpc('/connectors/link-sessions', 'POST', {
          provider,
          returnUrl: HARK_CONNECT_RETURN_URL,
          origin: opts.origin ?? 'chat'
        })
      )
      const url = String(d?.['startUrl'] ?? d?.['url'] ?? d?.['authUrl'] ?? '')
      if (/^https?:\/\//i.test(url)) startUrl = url
      else console.warn('[hark] link-sessions gave no startUrl', d)
    } catch (err) {
      console.warn('[hark] link-sessions failed', err)
    }
  }
  const inApp = bridge?.goxfInApp
  if (!inApp) {
    await bridge?.muse?.openHttps?.(startUrl)
    return 'external'
  }
  const res = await inApp.open({ url: startUrl, accountId, doneUrlPrefix: HARK_CONNECT_RETURN_URL, external: opts.external })
  if (res.result === 'external') return 'external'
  return (await isHarkProviderConnected(accountId, provider)) ? 'connected' : 'not-connected'
}
