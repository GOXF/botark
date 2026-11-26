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
