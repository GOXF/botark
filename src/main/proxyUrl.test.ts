import { describe, expect, it } from 'vitest'
import { normalizeProxyUrl, proxyKind, remoteDnsProxyUrl, requireValidProxyUrl, undiciProxyUrl } from './proxyUrl'

describe('proxy URLs', () => {
  it('normalizes user input and stays strictly idempotent', () => {
    expect(normalizeProxyUrl(' 1.2.3.4:8080 ')).toBe('http://1.2.3.4:8080')
    expect(normalizeProxyUrl('socks5h://u:p@h.test:1080')).toBe('socks5h://u:p@h.test:1080')
    expect(normalizeProxyUrl('')).toBeNull()
    expect(normalizeProxyUrl('ftp://h.test:21')).toBeNull()
    expect(normalizeProxyUrl('http://h.test')).toBeNull()
    expect(normalizeProxyUrl('http://user:12345@h.test')).toBeNull()
    expect(normalizeProxyUrl('http://h.test:80')).toBe('http://h.test:80')
    expect(normalizeProxyUrl(normalizeProxyUrl('http://h.test:80'))).toBe('http://h.test:80')
    expect(normalizeProxyUrl('https://u:p@h.test:443')).toBe('https://u:p@h.test:443')
    expect(normalizeProxyUrl(normalizeProxyUrl('https://u:p@h.test:443'))).toBe('https://u:p@h.test:443')
    expect(normalizeProxyUrl('https://u:p@h.test')).toBe('https://u:p@h.test:443')
    expect(normalizeProxyUrl('socks5://h.test')).toBeNull()
  })

  it('classifies http, https, and socks distinctly and maps for undici / ws', () => {
    expect(proxyKind('http://h.test:1')).toBe('http')
    expect(proxyKind('https://h.test:443')).toBe('https')
    expect(proxyKind('socks5h://h.test:1')).toBe('socks')
    expect(undiciProxyUrl('socks5h://u:p@h.test:1080')).toBe('socks5://u:p@h.test:1080')
    expect(remoteDnsProxyUrl('socks5://h.test:1080')).toBe('socks5h://h.test:1080')
    expect(remoteDnsProxyUrl('https://h.test:443')).toBe('https://h.test:443')
    expect(remoteDnsProxyUrl('http://h.test:1')).toBe('http://h.test:1')
  })

  it('refuses to save an unusable proxy', () => {
    expect(requireValidProxyUrl('  ')).toBeUndefined()
    expect(() => requireValidProxyUrl('not a proxy')).toThrow()
  })

  it('rejects password-only credentials and preserves valid credentials on IPv6', () => {
    expect(normalizeProxyUrl('http://:secret@host.test:8080')).toBeNull()
    expect(() => requireValidProxyUrl('socks5://:secret@[::1]:1080')).toThrow()
    expect(normalizeProxyUrl('socks5://alice:p%40ss@[::1]:1080')).toBe('socks5://alice:p%40ss@[::1]:1080')
  })
})
