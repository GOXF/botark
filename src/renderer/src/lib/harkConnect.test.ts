import { describe, expect, it } from 'vitest'
import { providerConnected } from './harkConnect'

describe('providerConnected', () => {
  it('reads the connected flag or accounts', () => {
    expect(providerConnected({ connectors: [{ id: 'github', connected: true }] }, 'github')).toBe(true)
    expect(providerConnected({ connectors: [{ provider: 'GitHub', accounts: [{ id: 'a' }] }] }, 'github')).toBe(true)
    expect(providerConnected({ connectors: [{ id: 'github', accounts: [] }] }, 'github')).toBe(false)
    expect(providerConnected(null, 'github')).toBe(false)
  })
})

describe('waitForHarkProvider', () => {
  it('stops when aborted', async () => {
    const { waitForHarkProvider } = await import('./harkConnect')
    const ac = new AbortController()
    ac.abort()
    await expect(waitForHarkProvider('a', 'github', { everyMs: 1, maxMs: 50, signal: ac.signal })).resolves.toBe(false)
  })
})
