import { expect, it, vi } from 'vitest'
import { fetchSubscription } from './quota'

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
