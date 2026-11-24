import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type RequestListener } from 'node:http'
import { createSecureServer, type Http2SecureServer } from 'node:http2'
import { createServer as createNetServer, connect, type AddressInfo, type Server as NetServer } from 'node:net'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeAllLocalProxyBridges, ensureLocalProxyBridge } from './localProxyBridge'
import { proxyFetch } from './proxyTransport'

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
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

const TEST_CERT = `-----BEGIN CERTIFICATE-----
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

let tlsTarget: Http2SecureServer
let httpsProxy: Http2SecureServer
let socksAuthServer: NetServer
const portOf = (s: Http2SecureServer | NetServer) => (s.address() as AddressInfo).port

async function readBody(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function withHttpProxy<T>(
  handler: RequestListener,
  run: (bridge: string) => Promise<T>
): Promise<T> {
  const upstream = createServer(handler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  try {
    const bridge = await ensureLocalProxyBridge({ mode: 'http', host: '127.0.0.1', port: portOf(upstream) })
    return await run(bridge)
  } finally {
    await closeAllLocalProxyBridges()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
}

beforeAll(async () => {
  tlsTarget = createSecureServer({ key: TEST_KEY, cert: TEST_CERT, allowHTTP1: true }, (_req, res) => {
    res.end('bridged-ok')
  })

  httpsProxy = createSecureServer({ key: TEST_KEY, cert: TEST_CERT, allowHTTP1: true })
  httpsProxy.on('connect', (req, client, head) => {
    const expected = `Basic ${Buffer.from('proxyuser:proxypass').toString('base64')}`
    if (req.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    const [h, p] = String(req.url).split(':')
    const up = connect(Number(p), h === 'localhost' ? '127.0.0.1' : h!, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(client)
      client.pipe(up)
    })
    up.on('error', () => client.destroy())
  })

  // Minimal RFC 1928 + RFC 1929 SOCKS5 server requiring username/password auth
  socksAuthServer = createNetServer((sock) => {
    let stage: 'greeting' | 'auth' | 'request' | 'tunnel' = 'greeting'
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      if (stage === 'tunnel') return
      buf = Buffer.concat([buf, chunk])
      if (stage === 'greeting') {
        if (buf.length < 2) return
        const nMethods = buf[1]!
        if (buf.length < 2 + nMethods) return
        const methods = buf.subarray(2, 2 + nMethods)
        buf = buf.subarray(2 + nMethods)
        if (!methods.includes(0x02)) {
          sock.end(Buffer.from([0x05, 0xff]))
          return
        }
        stage = 'auth'
        sock.write(Buffer.from([0x05, 0x02]))
      }
      if (stage === 'auth') {
        if (buf.length < 2) return
        const uLen = buf[1]!
        if (buf.length < 3 + uLen) return
        const pLen = buf[2 + uLen]!
        if (buf.length < 3 + uLen + pLen) return
        const u = buf.subarray(2, 2 + uLen).toString('utf8')
        const p = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8')
        buf = buf.subarray(3 + uLen + pLen)
        if (u !== 's5user' || p !== 's5pass') {
          sock.end(Buffer.from([0x01, 0x01]))
          return
        }
        stage = 'request'
        sock.write(Buffer.from([0x01, 0x00]))
      }
      if (stage === 'request') {
        if (buf.length < 5) return
        const atyp = buf[3]!
        let host = ''
        let targetPort = 0
        let offset = 4
        if (atyp === 0x01) {
          if (buf.length < 10) return
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const dLen = buf[4]!
          if (buf.length < 7 + dLen) return
          host = buf.subarray(5, 5 + dLen).toString('utf8')
          offset = 5 + dLen
        } else {
          sock.destroy()
          return
        }
        targetPort = buf.readUInt16BE(offset)
        const leftover = buf.subarray(offset + 2)
        stage = 'tunnel'
        const up = connect(targetPort, host === 'localhost' ? '127.0.0.1' : host, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          if (leftover.length) up.write(leftover)
          up.pipe(sock)
          sock.pipe(up)
        })
        up.on('error', () => sock.destroy())
      }
    })
  })

  await new Promise<void>((r) => tlsTarget.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => httpsProxy.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => socksAuthServer.listen(0, '127.0.0.1', r))
})

afterAll(async () => {
  await closeAllLocalProxyBridges()
  tlsTarget.close()
  httpsProxy.close()
  socksAuthServer.close()
})

describe('localProxyBridge', () => {
  it('bridges unauthenticated local HTTP proxy rules into an authenticated HTTPS TLS upstream proxy', async () => {
    const localUrl = await ensureLocalProxyBridge(
      {
        mode: 'https',
        host: 'localhost',
        port: portOf(httpsProxy),
        username: 'proxyuser',
        password: 'proxypass'
      },
      { ca: TEST_CERT }
    )
    expect(localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const res = await proxyFetch(localUrl, `https://localhost:${portOf(tlsTarget)}/api`, undefined, {
      requestTls: { ca: TEST_CERT }
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('bridged-ok')
  })

  it('bridges unauthenticated local HTTP proxy rules into an RFC 1929 authenticated SOCKS5 proxy', async () => {
    const localUrl = await ensureLocalProxyBridge({
      mode: 'socks5',
      host: '127.0.0.1',
      port: portOf(socksAuthServer),
      username: 's5user',
      password: 's5pass'
    })
    expect(localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const res = await proxyFetch(localUrl, `https://localhost:${portOf(tlsTarget)}/api`, undefined, {
      requestTls: { ca: TEST_CERT }
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('bridged-ok')
  })

  it('starts forwarding the upload before the client finishes sending it', async () => {
    let sawFirstChunk!: (chunk: string) => void
    const firstChunk = new Promise<string>((resolve) => { sawFirstChunk = resolve })
    await withHttpProxy((req, res) => {
      req.once('data', (chunk: Buffer) => sawFirstChunk(chunk.toString()))
      void readBody(req).then((body) => res.end(body), () => res.destroy())
    }, async (bridge) => {
      const client = request(bridge, { path: 'http://origin.example/upload', method: 'POST', headers: { 'content-length': 11 } })
      const response = once(client, 'response').then(([res]) => readBody(res as IncomingMessage))
      try {
        client.write('hello')
        await expect(firstChunk).resolves.toBe('hello')
        client.end(' world')
        expect((await response).toString()).toBe('hello world')
      } finally {
        client.destroy()
        await response.catch(() => undefined)
      }
    })
  }, 3_000)

  it('preserves repeated response headers, compressed bytes and their length', async () => {
    const compressed = gzipSync('gzip should travel unchanged')
    const cookies = ['first=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT', 'second=2; HttpOnly']
    await withHttpProxy((_req, res) => {
      res.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': compressed.length,
        'set-cookie': cookies,
        'x-repeated': ['one', 'two'],
        'connection': 'x-upstream-only',
        'x-upstream-only': 'private'
      })
      res.end(compressed)
    }, async (bridge) => {
      const client = request(bridge, { path: 'http://origin.example/gzip', headers: { 'accept-encoding': 'gzip' } })
      const promise = once(client, 'response')
      client.end()
      const [response] = await promise as [IncomingMessage]
      expect(response.headers['set-cookie']).toEqual(cookies)
      expect(response.headersDistinct['x-repeated']).toEqual(['one', 'two'])
      expect(response.headers['x-upstream-only']).toBeUndefined()
      expect(response.headers['content-encoding']).toBe('gzip')
      expect(response.headers['content-length']).toBe(String(compressed.length))
      const body = await readBody(response)
      expect(body.equals(compressed)).toBe(true)
      expect(gunzipSync(body).toString()).toBe('gzip should travel unchanged')
    })
  })

  it('aborts an upstream upload when the downstream client disconnects', async () => {
    let readChunk!: () => void
    const started = new Promise<void>((resolve) => { readChunk = resolve })
    let closeRequest!: (complete: boolean) => void
    const closed = new Promise<boolean>((resolve) => { closeRequest = resolve })
    await withHttpProxy((req) => {
      req.once('data', readChunk)
      req.once('close', () => closeRequest(req.complete))
      req.on('error', () => undefined)
    }, async (bridge) => {
      const client = request(bridge, { path: 'http://origin.example/aborted-upload', method: 'POST' })
      client.on('error', () => undefined)
      client.write('first chunk')
      try {
        await started
      } finally {
        client.destroy()
      }
      await expect(closed).resolves.toBe(false)
    })
  })

  it('aborts an upstream response when the downstream leaves mid-download', async () => {
    let closeResponse!: () => void
    const closed = new Promise<void>((resolve) => { closeResponse = resolve })
    await withHttpProxy((_req, res) => {
      res.once('close', closeResponse)
      res.write('first chunk')
    }, async (bridge) => {
      const client = request(bridge, { path: 'http://origin.example/aborted-download' })
      const promise = once(client, 'response')
      client.end()
      const [response] = await promise as [IncomingMessage]
      await once(response, 'data')
      response.on('error', () => undefined)
      response.destroy()
      await closed
    })
  })

  it('uses the effective verification policy and CA fingerprint in the cache key', async () => {
    const cfg = { mode: 'https' as const, host: 'localhost', port: portOf(httpsProxy), username: 'proxyuser', password: 'proxypass' }
    const withCa = await ensureLocalProxyBridge(cfg, { ca: TEST_CERT })
    const withoutVerification = await ensureLocalProxyBridge(cfg, { ca: TEST_CERT, rejectUnauthorized: false })
    const otherCa = await ensureLocalProxyBridge(cfg, { ca: 'different CA' })
    const strict = await ensureLocalProxyBridge(cfg)

    expect(new Set([withCa, withoutVerification, otherCa, strict]).size).toBe(4)
    await expect(ensureLocalProxyBridge(cfg, { ca: Buffer.from(TEST_CERT), rejectUnauthorized: true })).resolves.toBe(withCa)
    const target = `https://localhost:${portOf(tlsTarget)}/api`
    await expect(proxyFetch(strict, target, undefined, { requestTls: { ca: TEST_CERT } })).rejects.toThrow()
    const response = await proxyFetch(withoutVerification, target, undefined, { requestTls: { ca: TEST_CERT } })
    expect(await response.text()).toBe('bridged-ok')
  })

  it('closes both tunnel sockets when either peer goes away', async () => {
    const upstream = createNetServer((socket) => socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.resume()
    }))
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    try {
      const bridge = new URL(await ensureLocalProxyBridge({ mode: 'http', host: '127.0.0.1', port: portOf(upstream) }))
      for (const closeClient of [true, false]) {
        const connection = once(upstream, 'connection')
        const client = connect(Number(bridge.port), bridge.hostname)
        const clientClosed = once(client, 'close')
        client.write('CONNECT origin.example:443 HTTP/1.1\r\nHost: origin.example:443\r\n\r\n')
        const [peer] = await connection as [ReturnType<typeof connect>]
        const upstreamClosed = once(peer, 'close')
        expect(String((await once(client, 'data'))[0])).toContain('200 Connection Established')
        if (closeClient) client.end()
        else peer.end()
        await Promise.all([clientClosed, upstreamClosed])
      }
    } finally {
      await closeAllLocalProxyBridges()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('closes pending HTTP and SOCKS CONNECT negotiations when shutting down', async () => {
    const upstream = createNetServer((socket) => socket.resume())
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    try {
      for (const mode of ['http', 'socks5'] as const) {
        const bridge = new URL(await ensureLocalProxyBridge({ mode, host: '127.0.0.1', port: portOf(upstream) }))
        const connection = once(upstream, 'connection')
        const client = connect(Number(bridge.port), bridge.hostname)
        client.resume()
        const clientClosed = once(client, 'close')
        client.write('CONNECT origin.example:443 HTTP/1.1\r\nHost: origin.example:443\r\n\r\n')
        const [peer] = await connection as [ReturnType<typeof connect>]
        const upstreamClosed = once(peer, 'close')
        await once(peer, 'data')
        await closeAllLocalProxyBridges()
        await Promise.all([clientClosed, upstreamClosed])
      }
    } finally {
      await closeAllLocalProxyBridges()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('refuses to create a bridge with password-only credentials', async () => {
    await expect(ensureLocalProxyBridge({ mode: 'socks5', host: '127.0.0.1', port: 1080, password: 'secret' }))
      .rejects.toThrow('Proxy password requires a username')
  })
})
