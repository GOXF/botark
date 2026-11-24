/**
 * Muse Usage / quota via Next.js Server Action (HTTPS + hatch_* cookies).
 * Not Noise RPC. Never logs cookies or tokens.
 */
import type { FetchFn } from './controlPlane'

const ORIGIN = 'https://muse.ai'

/** Known id (GOXF: captured from muse.ai 2026-11-23) — may change on deploy; we rediscover. */
const FALLBACK_ACTION_ID = '40e0249eeae158685b6a8d0c3b203f53dd4f2c7d63'

export interface MuseQuotaTier {
  tierId: string
  name: string
  tierCode: string
  isPaid: boolean
  rank: number
}

export interface MuseQuotaUsage {
  state: string
  percentUsed: number
  resetsAt: number | null
  quotaStatus: string
}

export interface MuseSubscription {
  tier: MuseQuotaTier
  usage: MuseQuotaUsage
  statusSubtitle: string | null
  usageRowLabel: string | null
  usageRowValueLabel: string | null
  usageRowFooter: string | null
  billingSubtitle: string | null
  topupBalance: number | null
  topupTotal: number | null
  topupRowLabel: string | null
  topupRowValueLabel: string | null
  topupEligible: boolean | null
  entryPointCtaLabel: string | null
}

export interface MuseQuotaSnapshot {
  fetchedAt: number
  stale: boolean
  success: boolean
  subscription: MuseSubscription | null
  error?: string
}

export class MuseQuotaError extends Error {
  constructor(
    message: string,
    readonly code?: 'signed_out' | 'action_not_found' | 'parse' | 'http'
  ) {
    super(message)
    this.name = 'MuseQuotaError'
  }
}

type ActionCacheKey = object | string
const accountActionIds = new Map<string, string>()
const deploymentActionIds = new WeakMap<object, string>()

function actionCache(key: ActionCacheKey) {
  return typeof key === 'string'
    ? { read: () => accountActionIds.get(key), write: (id: string) => accountActionIds.set(key, id) }
    : { read: () => deploymentActionIds.get(key), write: (id: string) => deploymentActionIds.set(key, id) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Parse Next Server Action `text/x-component` multi-line body for subscription JSON. */
export function parseSubscriptionActionBody(text: string): { success: boolean; subscription: MuseSubscription | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let found: Record<string, unknown> | null = null
  for (const line of lines) {
    const jsonPart = line.includes(':') && /^\d+:/.test(line) ? line.slice(line.indexOf(':') + 1) : line
    try {
      const parsed = JSON.parse(jsonPart) as unknown
      const o = obj(parsed)
      if (o['subscription'] || (o['success'] === true && o['subscription'])) {
        found = o
        break
      }
      // Some flight rows nest under result
      const nested = obj(o['result'])
      if (nested['subscription']) {
        found = nested
        break
      }
    } catch {
      /* skip non-JSON rows */
    }
  }
  if (!found) throw new MuseQuotaError('subscription action: no subscription JSON in response', 'parse')
  return { success: found['success'] !== false, subscription: normalizeSubscription(found['subscription']) }
}

export function normalizeSubscription(raw: unknown): MuseSubscription | null {
  const s = obj(raw)
  if (!Object.keys(s).length) return null
  const tier = obj(s['tier'])
  const usage = obj(s['usage'])
  return {
    tier: {
      tierId: str(tier['tierId'] || tier['tier_id']),
      name: str(tier['name']) || 'Muse',
      tierCode: str(tier['tierCode'] || tier['tier_code']),
      isPaid: bool(tier['isPaid'] ?? tier['is_paid']) === true,
      rank: num(tier['rank']) ?? 0
    },
    usage: {
      state: str(usage['state']) || 'UNKNOWN',
      percentUsed: Math.max(0, Math.min(100, Math.round(num(usage['percentUsed'] ?? usage['percent_used']) ?? 0))),
      resetsAt: num(usage['resetsAt'] ?? usage['resets_at']),
      quotaStatus: str(usage['quotaStatus'] || usage['quota_status'])
    },
    statusSubtitle: str(s['statusSubtitle'] || s['status_subtitle']) || null,
    usageRowLabel: str(s['usageRowLabel'] || s['usage_row_label']) || null,
    usageRowValueLabel: str(s['usageRowValueLabel'] || s['usage_row_value_label']) || null,
    usageRowFooter: str(s['usageRowFooter'] || s['usage_row_footer']) || null,
    billingSubtitle: str(s['billingSubtitle'] || s['billing_subtitle']) || null,
    topupBalance: num(s['topupBalance'] ?? s['topup_balance']),
    topupTotal: num(s['topupTotal'] ?? s['topup_total']),
    topupRowLabel: str(s['topupRowLabel'] || s['topup_row_label']) || null,
    topupRowValueLabel: str(s['topupRowValueLabel'] || s['topup_row_value_label']) || null,
    topupEligible: bool(s['topupEligible'] ?? s['topup_eligible']),
    entryPointCtaLabel: str(s['entryPointCtaLabel'] || s['entry_point_cta_label']) || 'Upgrade'
  }
}

const ACTION_RE =
  /(?:createServerReference|\.\w+)\(\s*["']([0-9a-f]{40,44})["'][\s\S]{0,200}?["']fetchSubscriptionAction["']/i
const ACTION_RE_REV =
  /["']fetchSubscriptionAction["'][\s\S]{0,200}?(?:createServerReference|\.\w+)\(\s*["']([0-9a-f]{40,44})["']/i
const LOOSE_NEAR =
  /fetchSubscriptionAction[\s\S]{0,140}?([0-9a-f]{40,44})|([0-9a-f]{40,44})[\s\S]{0,140}?fetchSubscriptionAction/i

function extractActionIdFromSource(source: string): string | null {
  return (
    source.match(ACTION_RE)?.[1] ||
    source.match(ACTION_RE_REV)?.[1] ||
    source.match(LOOSE_NEAR)?.[1] ||
    source.match(LOOSE_NEAR)?.[2] ||
    null
  )
}

/** Best-effort: scrape muse.ai bundles for the current Server Action id. */
export async function discoverSubscriptionActionId(fetchFn: FetchFn, signal?: AbortSignal): Promise<string | null> {
  const seenScripts = new Set<string>()
  const scriptQueue: string[] = []
  // Probe authenticated app routes (/settings, /chat) BEFORE `/` so marketing landing
  // chunks do not crowd out the authenticated settings/subscription chunks.
  for (const pagePath of ['/settings', '/chat', '/']) {
    signal?.throwIfAborted()
    try {
      const res = await fetchFn(ORIGIN + pagePath, {
        method: 'GET',
        headers: { Accept: 'text/html', 'Accept-Language': 'en-US' }
      })
      if (!res.ok) continue
      const html = await res.text()
      const fromHtml = extractActionIdFromSource(html)
      if (fromHtml) return fromHtml
      for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
        const src = m[1]!
        if (!/\.js(\?|$)/.test(src)) continue
        const url = src.startsWith('http') ? src : new URL(src, ORIGIN).href
        if ((!url.includes('muse.ai') && !src.startsWith('/')) || seenScripts.has(url)) continue
        seenScripts.add(url)
        scriptQueue.push(url)
      }
      for (const m of html.matchAll(/\/_next\/static\/(?:immutable\/)?chunks\/[A-Za-z0-9_-]+\.js/g)) {
        const url = `${ORIGIN}${m[0]}`
        if (!seenScripts.has(url)) {
          seenScripts.add(url)
          scriptQueue.push(url)
        }
      }
    } catch {
      /* try next page */
    }
  }
  for (const url of scriptQueue.slice(0, 96)) {
    signal?.throwIfAborted()
    try {
      const r = await fetchFn(url, { headers: { Accept: '*/*' } })
      if (!r.ok) continue
      const js = await r.text()
      const id = extractActionIdFromSource(js)
      if (id) return id
    } catch {
      /* try next chunk */
    }
  }
  return null
}

async function tryRestSubscriptionEndpoints(fetchFn: FetchFn, fetchedAt: number): Promise<MuseQuotaSnapshot | null> {
  for (const endpoint of ['/api/subscription', '/api/hatch/subscription', '/api/billing/subscription']) {
    try {
      const res = await fetchFn(ORIGIN + endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json', Origin: ORIGIN, Referer: ORIGIN + '/' }
      })
      if (!res.ok) continue
      const json = (await res.json()) as unknown
      const root = obj(json)
      const sub = normalizeSubscription(root['subscription'] ?? root['result'] ?? root)
      if (sub && (sub.tier.tierId || sub.tier.tierCode || sub.usage.state !== 'UNKNOWN')) {
        return { fetchedAt, stale: false, success: true, subscription: sub }
      }
    } catch {
      /* try next */
    }
  }
  return null
}

async function postAction(
  fetchFn: FetchFn,
  actionId: string,
  includeAgreement: boolean
): Promise<{ status: number; text: string }> {
  const body = JSON.stringify([{ includeAgreement }])
  let last = { status: 0, text: '' }
  // GOXF: muse.ai web posts this action to `/` (captured 2026-11-23); try it first.
  for (const actionPath of ['/', '/settings']) {
    const res = await fetchFn(ORIGIN + actionPath, {
      method: 'POST',
      headers: {
        Accept: 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': actionId,
        Origin: ORIGIN,
        Referer: ORIGIN + actionPath
      },
      body
    })
    const text = await res.text()
    last = { status: res.status, text }
    if (res.status === 401 || res.status === 403 || (res.ok && looksLikeSubscription(text))) return last
    if (res.status !== 409 && res.status !== 404 && !res.ok) return last
  }
  return last
}

function looksLikeSubscription(text: string): boolean {
  return /"subscription"\s*:/.test(text) || /"percentUsed"\s*:/.test(text)
}

/**
 * Fetch current subscription / usage for the account whose cookies the fetchFn carries.
 */
export async function fetchSubscription(
  fetchFn: FetchFn,
  opts: { includeAgreement?: boolean; rediscover?: boolean; accountId?: string; deployment?: string; signal?: AbortSignal } = {}
): Promise<MuseQuotaSnapshot> {
  const includeAgreement = opts.includeAgreement === true
  const fetchedAt = Date.now()
  const cache = actionCache(opts.accountId === undefined ? fetchFn : JSON.stringify([opts.accountId, opts.deployment ?? ORIGIN]))
  const cached = cache.read()
  const tryIds = new Set([cached ?? FALLBACK_ACTION_ID, FALLBACK_ACTION_ID])
  let lastStatus = 0
  let lastText = ''
  let parseError: MuseQuotaError | undefined

  const tryAction = async (id: string): Promise<MuseQuotaSnapshot | undefined> => {
    opts.signal?.throwIfAborted()
    const { status, text } = await postAction(fetchFn, id, includeAgreement)
    opts.signal?.throwIfAborted()
    lastStatus = status
    lastText = text
    if (status === 401 || status === 403) {
      throw new MuseQuotaError(`quota: not signed in (${status})`, 'signed_out')
    }
    if (status < 200 || status >= 300 || !looksLikeSubscription(text)) return
    try {
      const parsed = parseSubscriptionActionBody(text)
      if (parsed.success && parsed.subscription && (cache.read() === cached || cache.read() === id)) cache.write(id)
      return { fetchedAt, stale: false, success: parsed.success, subscription: parsed.subscription }
    } catch (error) {
      if (!(error instanceof MuseQuotaError) || error.code !== 'parse') throw error
      parseError = error
    }
  }

  for (const id of tryIds) {
    const snapshot = await tryAction(id)
    if (snapshot) return snapshot
  }
  if (opts.rediscover !== false) {
    const discovered = await discoverSubscriptionActionId(fetchFn, opts.signal)
    opts.signal?.throwIfAborted()
    if (discovered && !tryIds.has(discovered)) {
      const snapshot = await tryAction(discovered)
      if (snapshot) return snapshot
    }
  }

  const viaRest = await tryRestSubscriptionEndpoints(fetchFn, fetchedAt)
  opts.signal?.throwIfAborted()
  if (viaRest) return viaRest
  if (parseError) throw parseError
  if (lastStatus === 404 || lastStatus === 400 || lastStatus === 409 || !looksLikeSubscription(lastText)) {
    throw new MuseQuotaError(
      `quota: fetchSubscriptionAction unavailable (HTTP ${lastStatus || 'n/a'})`,
      'action_not_found'
    )
  }
  throw new MuseQuotaError(`quota: HTTP ${lastStatus}`, 'http')
}

/** @deprecated Prefer invite.ts; kept for quota poll compatibility. */
export { fetchInviteSummary } from './invite'
