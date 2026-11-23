import { describe, expect, it } from 'vitest'
import { parseInlineProxyInput } from './ProxySection'

describe('parseInlineProxyInput', () => {
  it('recognizes https:// proxy URLs as mode https instead of http', () => {
    expect(parseInlineProxyInput('https://user:pass@proxy.example.com:8443', 'http')).toEqual({
      mode: 'https',
      host: 'proxy.example.com',
      port: '8443',
      username: 'user',
      password: 'pass'
    })
    expect(parseInlineProxyInput('https://proxy.example.com', 'http')).toEqual({
      mode: 'https',
      host: 'proxy.example.com',
      port: '443',
      username: undefined,
      password: undefined
    })
  })

  it('parses socks5, socks5h, http, and vendor host:port:user:pass inputs', () => {
    expect(parseInlineProxyInput('socks5h://u:p@127.0.0.1:1080', 'http')).toEqual({
      mode: 'socks5h',
      host: '127.0.0.1',
      port: '1080',
      username: 'u',
      password: 'p'
    })
    expect(parseInlineProxyInput('192.168.1.5:7890:alice:sec:ret', 'socks5')).toEqual({
      mode: 'socks5',
      host: '192.168.1.5',
      port: '7890',
      username: 'alice',
      password: 'sec:ret'
    })
  })
})
