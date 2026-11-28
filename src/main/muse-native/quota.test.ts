import { expect, it, vi } from 'vitest'
import { extractActionIdFromSource, extractSubscriptionFromHtml, fetchSubscription } from './quota'

const subscription = '1:{"success":true,"subscription":{"tier":{"tierId":"free"},"usage":{"state":"ACTIVE"}}}'

function deployment(id: string, body = subscription) {
  const postIds: string[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const action = new Headers(init.headers).get('Next-Action') ?? ''
      postIds.push(action)
      return action === id ? new Response(body) : new Response('', { status: 404 })
    }
    if (url.endsWith('/settings')) return new Response(`createServerReference('${id}', 'fetchSubscriptionAction')`)
    return new Response('', { status: 404 })
  })
  return { fetch, postIds }
}

it('remembers validated quota IDs independently for accounts and deployments', async () => {
  const first = deployment('a'.repeat(40))
  const second = deployment('b'.repeat(40))
  const redeploy = deployment('c'.repeat(40))
  await fetchSubscription(first.fetch, { accountId: 'quota-a' })
  await fetchSubscription(second.fetch, { accountId: 'quota-b' })
  await fetchSubscription(redeploy.fetch, { accountId: 'quota-a', deployment: 'new' })
  first.postIds.length = 0
  second.postIds.length = 0
  redeploy.postIds.length = 0
  await fetchSubscription(first.fetch, { accountId: 'quota-a' })
  await fetchSubscription(second.fetch, { accountId: 'quota-b' })
  await fetchSubscription(redeploy.fetch, { accountId: 'quota-a', deployment: 'new' })
  expect(first.postIds).toEqual(['a'.repeat(40)])
  expect(second.postIds).toEqual(['b'.repeat(40)])
  expect(redeploy.postIds).toEqual(['c'.repeat(40)])
})

it('does not cache a discovered action that returns an invalid subscription payload', async () => {
  const invalid = deployment('d'.repeat(40), 'invalid "subscription":')
  await expect(fetchSubscription(invalid.fetch, { accountId: 'invalid' })).rejects.toMatchObject({ code: 'parse' })
  invalid.postIds.length = 0
  await expect(fetchSubscription(invalid.fetch, { accountId: 'invalid' })).rejects.toMatchObject({ code: 'parse' })
  expect(invalid.postIds[0]).not.toBe('d'.repeat(40))
})

it('discovers minified Turbopack Server Actions in nested lazy chunks and survives 403 on stale IDs', async () => {
  const liveId = 'e'.repeat(42)
  expect(
    extractActionIdFromSource(
      `(0,s.createServerReference)("${liveId}",s.callServer,void 0,s.findSourceMapURL,"fetchSubscriptionAction")`
    )
  ).toBe(liveId)

  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const action = new Headers(init.headers).get('Next-Action') ?? ''
      if (url.endsWith('/settings')) return new Response('{"error":"Forbidden"}', { status: 403 })
      if (action === liveId) return new Response(subscription)
      return new Response('{"error":"Forbidden"}', { status: 403 })
    }
    if (url === 'https://muse.ai/settings') return new Response('{"error":"Authentication required"}', { status: 401 })
    if (url === 'https://muse.ai/') {
      return new Response('<script src="/_next/static/immutable/chunks/app.1234.js"></script>')
    }
    if (url === 'https://muse.ai/_next/static/immutable/chunks/app.1234.js') {
      return new Response('const lazy = "static/immutable/chunks/settings.usage.9999.js";')
    }
    if (url === 'https://muse.ai/_next/static/immutable/chunks/settings.usage.9999.js') {
      return new Response(
        `var x=(0,e.createServerReference)("${liveId}",e.callServer,void 0,e.findSourceMapURL,"fetchSubscriptionAction");`
      )
    }
    return new Response('', { status: 404 })
  })

  const snap = await fetchSubscription(fetch, { accountId: 'turbopack-nested' })
  expect(snap.success).toBe(true)
  expect(snap.subscription?.tier.tierId).toBe('free')
})

it('extracts subscription JSON directly from escaped Next.js RSC flight HTML when actions fail', async () => {
  const escaped = JSON.stringify({
    subscription: {
      tier: { tierId: 'hatch_free', name: 'Muse Free', tierCode: 'HATCH_FREE', isPaid: false, rank: 0 },
      usage: { state: 'METERED', percentUsed: 12, resetsAt: 1794231590, quotaStatus: 'SUFFICIENT' }
    }
  }).replace(/"/g, '\\"')
  const html = `<script>self.__next_f.push([1,"5:${escaped}"])</script>`
  const extracted = extractSubscriptionFromHtml(html)
  expect(extracted?.tier.name).toBe('Muse Free')
  expect(extracted?.usage.percentUsed).toBe(12)

  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response('', { status: 404 })
    if (url === 'https://muse.ai/') return new Response(html)
    return new Response('', { status: 404 })
  })
  const snap = await fetchSubscription(fetch, { accountId: 'inline-rsc' })
  expect(snap.success).toBe(true)
  expect(snap.subscription?.usage.percentUsed).toBe(12)
})

it('2026-11-28 deploy: tries the new known id first and parses its RSC reply', async () => {
  const reply = '0:{"a":"$@1","f":"","b":"x"}\n1:{"success":true,"subscription":{"subscriptionType":"FREE","tier":{"tierId":"hatch_free","name":"Muse 免费版","tierCode":"HATCH_FREE","isPaid":false,"rank":0},"usage":{"state":"METERED","percentUsed":0,"resetsAt":1796459438,"quotaStatus":"SUFFICIENT"},"statusSubtitle":"周限额重置时间：12月5日"}}\n'
  const seen: string[] = []
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const action = new Headers(init?.headers).get('Next-Action') ?? ''
    seen.push(action)
    return action === '406cd44441421b58cea8309747129141947de9f499'
      ? new Response(reply, { headers: { 'Content-Type': 'text/x-component' } })
      : new Response('', { status: 404 })
  })
  const snap = await fetchSubscription(fetch, { accountId: 'deploy-2026-11-28', rediscover: false })
  expect(seen[0]).toBe('406cd44441421b58cea8309747129141947de9f499')
  expect(snap.subscription).toMatchObject({ tier: { tierId: 'hatch_free' }, usage: { percentUsed: 0, resetsAt: 1796459438 } })
})

it('follows chunks a loader names by file only', async () => {
  const liveId = 'f'.repeat(42)
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Headers(init.headers).get('Next-Action') === liveId ? new Response(subscription) : new Response('', { status: 409 })
    }
    if (url === 'https://muse.ai/') return new Response('<script src="/_next/static/immutable/chunks/main0001.js"></script>')
    if (url.endsWith('/main0001.js')) return new Response('e.l(["3c93p469092sl.js"])')
    if (url.endsWith('/3c93p469092sl.js')) {
      return new Response(`(0,a.createServerReference)("${liveId}",a.callServer,void 0,a.findSourceMapURL,"fetchSubscriptionAction")`)
    }
    return new Response('', { status: 404 })
  })
  const snap = await fetchSubscription(fetch, { accountId: 'bare-chunk' })
  expect(snap.success).toBe(true)
})
