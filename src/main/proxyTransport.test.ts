import { createServer, type Server } from 'node:http'
import { createSecureServer, type Http2SecureServer } from 'node:http2'
import { once } from 'node:events'
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeProxyDispatchers, proxyFetch, proxyWsAgent } from './proxyTransport'

const TEST_LOCALHOST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCwPxaVFxlSGOPe
YrM9dNzdTnlciOTXm4OoyjQ4wKO8//T9vW3ghlCYLq2A+6T9VJq9r/SH94YwtYST
VwakbwH2fijd3qAt1n0M+4eUCMgCtbLJUI07y2aGOvGxcrf+LfTftvjwXx2bPAn6
UaF3dZCAAylGw/xtfLkurfS9UcOJ9TBXwKZARMYEbtvbSoV5PhO3NIQiqLeFjrK9
M04o8CRY0CFicG74rVOJOpowLGY/hvovdVrwrvDhDinRx+PVfKUx63dHW0X9/S7D
LyptE4qw/ybUVRv15APDM1TrcZOQLhfUVnmmEiUZaG6RvASfHx8GwY2JJMG8KVw6
0Wa14sdvAgMBAAECggEAL5D/T8KZr1oPWcwqktoQ59uPjoVVucj7ehkEihKXvmEY
JkkzN+cYJlJmukpwR3zHfI1aAj4wJcI/oyJYJRXeoj9/WQ4GDgj23AOgnjfWf0C5
nXKTg4FMTMrowxryhHOzxJMV0Y3iKCzGhpv0Z5C/rITt5W7smEISmoIRbOz9yKQE
m/Ny70/MDuL7GF6DCd8lhBhXOr7rV+XwbdWmi4EtNZLjuYQqz36gpYhwnHYWF1BI
Ojg8nLAz4/CA7UxNqIA+o0KIJWZP4HfcwapBag70M8Zr6QUfUMyDDR62ryOziAmZ
Bk9Pp+SYsaI7xWJiyJPlem3IMRLt9ITnIsw1e24HWQKBgQDe1jlJvEJGmUzJcaOX
M6S0+GIk2w59ApEfvOEAEJZ9z9FYMpXdfDOmMcIPf254jgtMNUndslsiZOHtPEpk
CoeGOd0j7GKYplm2Tp1lnpJs36qYAQ5KDWmUz7fhClw26Ca6e8/RmL2cGtOXwFJ5
roUf8nkMak6lcPT4YkxeWZhJOQKBgQDKedXS6Y9IiEZhA2F7Iwp7a8+jpN4WFaOf
ugtWBGF8He7wuP+9Hxm1YvneHB4w41E03sWmHiI9rtEttx221p4ILFMVVIYopwll
mmy3KSztdzWTH/E531VgTVC+g5Jjhx8UHHpTVfKE8/kvbihyHHBtfirlp8wdvBBV
lElebNdd5wKBgDSvg7X6S9UzU6NhOeN681tSSqoaHM/TtopBdxUz1tECPKXUt/g4
8GE/7HkLkQvx0ZwAEWnYTJHSNlSH57LFhotmzPE8Z4dd9WIULkSjfE0/iK8NuNor
V6Y2gmwzrd/Rfa6jrVwJ9/KbqSF8+EMKzzDhfFtCGzwke9bqLtIz7ryJAoGAC1UO
VqOj1VdrOPrLdezcJVQ/ZtVPaMUFR2dOQx4zppK2UNrJ1XfsJG7JtVi1h97xKJhf
T5DYMcObCYf6LcWNSr/QVp1IdPYEXJ9r/kRbs168rONYyPhq+tzY7BDJHLDvWFzP
q+JflHljNPhhYyGcWUR6eigOEIv6DhAimxpUY3kCgYEArjP4eANtpfRblWPJxo+R
YYaex512z3+oRbytKba1tlsl90eUNyN+LV8KHRiOZLeMlXGf6Fvu0XoHwEBUJ4Rg
XFy/APqAVeyRZEUy9SAjUEvXlgU6IZtAIsh2NM5tuZy2isXZZcKHoJloJoXcH16x
0COEOPvZ2HmMgDdIfaO8ZO0=
-----END PRIVATE KEY-----`

const TEST_LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIC9TCCAd2gAwIBAgIUfgOWUZnLHSN4beL/tbwIENnPwW8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyMjE0MTExM1oYDzIwNTYx
MTE0MTQxMTEzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCwPxaVFxlSGOPeYrM9dNzdTnlciOTXm4OoyjQ4wKO8
//T9vW3ghlCYLq2A+6T9VJq9r/SH94YwtYSTVwakbwH2fijd3qAt1n0M+4eUCMgC
tbLJUI07y2aGOvGxcrf+LfTftvjwXx2bPAn6UaF3dZCAAylGw/xtfLkurfS9UcOJ
9TBXwKZARMYEbtvbSoV5PhO3NIQiqLeFjrK9M04o8CRY0CFicG74rVOJOpowLGY/
hvovdVrwrvDhDinRx+PVfKUx63dHW0X9/S7DLyptE4qw/ybUVRv15APDM1TrcZOQ
LhfUVnmmEiUZaG6RvASfHx8GwY2JJMG8KVw60Wa14sdvAgMBAAGjPTA7MBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATAdBgNVHQ4EFgQULbbsrEPwtdBc/9jDNxAV
4ATS6/wwDQYJKoZIhvcNAQELBQADggEBAFGeNYSgQC7yelBtrrKc5USPwbKsE6Dx
9Rh9+tkyWHKoo4XL1TGUd45m9+doAEwPhunDbJG4IQDtfGVbvBkLAZlcPYpAJ5TW
DUCb2GHNZCy3+9KU1If89HFcR9p9dcVvSfAKRFwBxsOZxY5HwfAvlK1oIOXYGqie
emQ0jdR3fZi13ei9bi3xQm0qtkVb/hKjDStFdgeNpxICjWTy/fBtdDVTjhxQUYAL
MIahOc562HtlyfLK1ZxVKSZKa/IYb8SPR+djp78HmUenH/rEgfqEMmqS2/Xun1A6
8YiR6kaM0E/xlJNPBBS2USDLk2qkfEIeBvUaxQmSkV9So/wkTLurHro=
-----END CERTIFICATE-----`

let target: Server
let tlsTarget: Http2SecureServer
let proxy: Server
let httpsProxy: Http2SecureServer
const tunnels: string[] = []
const httpsProxyAuthSeen: string[] = []
const port = (s: Server | Http2SecureServer) => (s.address() as AddressInfo).port

beforeAll(async () => {
  target = createServer((_req, res) => res.end('hello'))
  tlsTarget = createSecureServer({ key: TEST_LOCALHOST_KEY, cert: TEST_LOCALHOST_CERT, allowHTTP1: true }, (_req, res) => {
    res.end('hello-over-tls-target')
  })
  // Plain HTTP targets may be sent as absolute-URL requests instead of CONNECT.
  proxy = createServer((req, res) => {
    const url = new URL(String(req.url))
    tunnels.push(url.host)
    fetch(url).then(
      async (r) => res.end(await r.text()),
      () => res.destroy()
    )
  })
  proxy.on('connect', (req, client, head) => {
    tunnels.push(String(req.url))
    const [host, p] = String(req.url).split(':')
    const upstream = connect(Number(p), host === 'localhost' ? '127.0.0.1' : host!, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
  })

  // HTTPS forward proxy advertising ALPN h2 + http/1.1 with Basic auth
  httpsProxy = createSecureServer({ key: TEST_LOCALHOST_KEY, cert: TEST_LOCALHOST_CERT, allowHTTP1: true })
  httpsProxy.on('connect', (req, client, head) => {
    httpsProxyAuthSeen.push(String(req.headers['proxy-authorization'] ?? ''))
    const [host, p] = String(req.url).split(':')
    const upstream = connect(Number(p), host === 'localhost' ? '127.0.0.1' : host!, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
  })

  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => tlsTarget.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => httpsProxy.listen(0, '127.0.0.1', r))
})

afterAll(async () => {
  await closeProxyDispatchers()
  target.close()
  tlsTarget.close()
  proxy.close()
  httpsProxy.close()
})

describe('proxyFetch & proxyWsAgent', () => {
  it('goes through the configured HTTP proxy', async () => {
    const res = await proxyFetch(`127.0.0.1:${port(proxy)}`, `http://127.0.0.1:${port(target)}/x`)
    expect(await res.text()).toBe('hello')
    expect(tunnels).toContain(`127.0.0.1:${port(target)}`)
  })

  it('tunnels HTTPS traffic through an ALPN h2+http/1.1 HTTPS proxy with Basic auth without hanging', async () => {
    const res = await proxyFetch(
      `https://alice:s3cr3t@localhost:${port(httpsProxy)}`,
      `https://localhost:${port(tlsTarget)}/secure`,
      undefined,
      {
        proxyTls: { ca: TEST_LOCALHOST_CERT },
        requestTls: { ca: TEST_LOCALHOST_CERT }
      }
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello-over-tls-target')
    expect(httpsProxyAuthSeen).toContain(`Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`)
  })

  it('creates TLS-enabled HttpsProxyAgent for https:// ws proxy URLs', () => {
    const agent = proxyWsAgent(`https://alice:s3cr3t@localhost:${port(httpsProxy)}`, {
      ca: TEST_LOCALHOST_CERT
    }) as unknown as { proxy?: URL }
    expect(agent?.proxy?.protocol).toBe('https:')
    expect(agent?.proxy?.port).toBe(String(port(httpsProxy)))
  })

  it('connects to an IPv6 SOCKS proxy with a bare socket hostname', async ({ skip }) => {
    const socks = createNetServer((socket) => {
      socket.once('data', () => {
        socket.once('data', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          socket.once('data', () => {
            socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nover-v6')
          })
        })
        socket.write(Buffer.from([5, 0]))
      })
    })
    try {
      socks.listen(0, '::1')
      await once(socks, 'listening')
    } catch (error) {
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) return skip()
      throw error
    }
    try {
      const proxyUrl = `socks5h://[::1]:${(socks.address() as AddressInfo).port}`
      const res = await proxyFetch(proxyUrl, 'http://origin.example/')
      expect(await res.text()).toBe('over-v6')
      const ws = proxyWsAgent(proxyUrl) as unknown as { proxy: { host: string }; shouldLookup: boolean }
      expect(ws.proxy.host).toBe('::1')
      expect(ws.shouldLookup).toBe(false)
    } finally {
      await closeProxyDispatchers()
      await new Promise<void>((resolve) => socks.close(() => resolve()))
    }
  })

  it('drains an evicted dispatcher and cancels retired requests on shutdown', async () => {
    const slowProxy = createServer((_req, res) => res.write('initial'))
    const sockets = new Set<Socket>()
    slowProxy.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    slowProxy.listen(0, '127.0.0.1')
    await once(slowProxy, 'listening')
    try {
      const slowUrl = `http://127.0.0.1:${port(slowProxy)}`
      const first = await proxyFetch(slowUrl, 'http://origin.example/first')
      const firstBody = first.text().catch((error: unknown) => error)
      const second = await proxyFetch(`http://other@127.0.0.1:${port(slowProxy)}`, 'http://origin.example/second')
      const secondBody = second.text().catch((error: unknown) => error)
      const peersClosed = [...sockets].map((socket) => once(socket, 'close'))

      // Distinct credentials cause the oldest dispatchers to age out.
      for (let index = 0; index < 32; index++) {
        const result = await proxyFetch(`http://user${index}@127.0.0.1:${port(proxy)}`, `http://127.0.0.1:${port(target)}/`)
        await result.text()
      }
      expect(sockets.size).toBe(2)
      await closeProxyDispatchers()
      await Promise.all(peersClosed)
      expect(await firstBody).toBeInstanceOf(Error)
      expect(await secondBody).toBeInstanceOf(Error)
    } finally {
      await closeProxyDispatchers()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => slowProxy.close(() => resolve()))
    }
  })

  it('refuses an unusable proxy instead of going direct', () => {
    expect(() => proxyFetch('nonsense proxy', 'http://127.0.0.1:1/')).toThrow()
    expect(() => proxyWsAgent('ftp://h.test:21')).toThrow()
  })

  it('goes direct only when no proxy is set', async () => {
    const res = await proxyFetch(undefined, `http://127.0.0.1:${port(target)}/`)
    expect(await res.text()).toBe('hello')
  })
})
