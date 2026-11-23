import { describe, expect, it } from 'vitest'
import { accountPartitionName, sessionOnly, toSetDetails } from './goxfSessionCookieLogic'

describe('accountPartitionName', () => {
  it('accepts account partitions by storage path or bare name', () => {
    expect(accountPartitionName('C:\\BotArk-Data\\Partitions\\bothub-account-acc_1'.replace(/\\/g, '/'))).toBe('bothub-account-acc_1')
    expect(accountPartitionName('bothub-account-x-2')).toBe('bothub-account-x-2')
  })
  it('skips other partitions and the default session', () => {
    expect(accountPartitionName('/data/Partitions/doc-preview')).toBeNull()
    expect(accountPartitionName('')).toBeNull()
    expect(accountPartitionName(null)).toBeNull()
  })
})

describe('sessionOnly', () => {
  it('keeps only cookies without an expiry', () => {
    const out = sessionOnly([
      { name: 'a', value: '1', domain: '.hark.com', session: true },
      { name: 'b', value: '2', domain: '.hark.com', session: false }
    ])
    expect(out.map((c) => c.name)).toEqual(['a'])
  })
})

describe('toSetDetails', () => {
  it('rebuilds a domain cookie as a session cookie', () => {
    expect(
      toSetDetails({ name: 'sid', value: 'v', domain: '.hark.com', path: '/app', secure: true, httpOnly: true, sameSite: 'lax' })
    ).toEqual({ url: 'https://hark.com/app', name: 'sid', value: 'v', domain: '.hark.com', path: '/app', secure: true, httpOnly: true, sameSite: 'lax' })
  })
  it('keeps host-only cookies host-only', () => {
    const d = toSetDetails({ name: 'sid', value: 'v', domain: 'www.hark.com', hostOnly: true })
    expect(d).not.toHaveProperty('domain')
    expect(d.url).toBe('http://www.hark.com/')
    expect(d).not.toHaveProperty('expirationDate')
  })
})
