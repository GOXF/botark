import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { collectDependencies, parseNodeLink, parseSubscription, sourceNameFromHeaders, SubParseError } from './goxfSubParse'
import { buildCatalogConfig, buildEntryConfig, type MihomoTargetSnapshot } from './goxfMihomoConfig'
import { parse as parseYaml } from 'yaml'

const ID = '11111111-2222-3333-4444-555555555555'
const b64 = (s: string) => Buffer.from(s).toString('base64')

const CLASH = `
mixed-port: 7890
proxies:
  - { name: "香港 01", type: vmess, server: hk.example.com, port: 443, uuid: ${ID}, alterId: 0, cipher: auto, tls: true, sni: hk.example.com, network: ws, ws-opts: { path: /ray } }
  - { name: "日本 01", type: trojan, server: jp.example.com, port: 443, password: secret, servername: jp.example.com }
  - { name: "新加坡 01", type: ss, server: sg.example.com, port: 8388, cipher: aes-256-gcm, password: pw }
  - { name: "不安全", type: trojan, server: x.example.com, port: 443, password: pw, skip-cert-verify: true }
  - { name: "本地文件", type: trojan, server: y.example.com, port: 443, password: pw, certificate: /etc/passwd }
  - { name: "直连", type: direct }
proxy-groups:
  - { name: "♻️ 自动选择", type: url-test, proxies: ["香港 01", "日本 01"], url: "https://www.gstatic.com/generate_204", interval: 300 }
  - { name: "🚀 节点选择", type: select, proxies: ["♻️ 自动选择", DIRECT, "新加坡 01"] }
  - { name: "坏组", type: url-test, proxies: ["香港 01", DIRECT] }
  - { name: "全部", type: select, include-all: true, filter: "香港|日本" }
rules:
  - MATCH,🚀 节点选择
`

describe('goxf subscription parser', () => {
  it('reads Clash/Mihomo YAML nodes and groups', () => {
    const c = parseSubscription(CLASH)
    expect(c.nodes.map((n) => n.name)).toEqual(['香港 01', '日本 01', '新加坡 01', '不安全', '本地文件', '直连'])
    const by = Object.fromEntries(c.nodes.map((n) => [n.name, n]))
    expect(by['香港 01']!.proxy?.servername).toBe('hk.example.com')
    expect(by['日本 01']!.proxy?.sni).toBe('jp.example.com')
    expect(by['不安全']!.insecure).toBe(true)
    expect(by['本地文件']!.proxy).toBeUndefined()
    expect(by['本地文件']!.error).toBe('PROXY_UNSUPPORTED_OPTION')
    expect(by['直连']!.protocol).toBe('unsupported')
    const g = Object.fromEntries(c.groups.map((x) => [x.name, x]))
    expect(g['♻️ 自动选择']!.error).toBeUndefined()
    expect(g['♻️ 自动选择']!.options).toMatchObject({ url: 'https://www.gstatic.com/generate_204', interval: 300 })
    expect(g['🚀 节点选择']!.error).toBeUndefined()
    expect(g['坏组']!.error).toBe('GROUP_EMPTY')
    expect(g['全部']!.members).toEqual(['日本 01', '香港 01'])
  })

  it('reads base64 and plain share-link lists', () => {
    const vmess = `vmess://${b64(JSON.stringify({ v: '2', ps: 'VM 1', add: 'a.example.com', port: '443', id: ID, aid: '0', net: 'ws', path: '/p', host: 'h.example.com', tls: 'tls', sni: 'a.example.com' }))}`
    const links = [
      `ss://${b64('aes-256-gcm:pa:ss')}@ss.example.com:8388#SS%201`,
      vmess,
      'trojan://p%40ss+word@t.example.com:443?sni=t.example.com&allowInsecure=1#Trojan',
      `vless://${ID}@[::1]:443?security=reality&pbk=abc&sid=01&type=grpc&serviceName=svc&flow=xtls-rprx-vision#VL`,
      'hysteria2://user:pass@h.example.com?obfs=salamander&obfs-password=x#HY2',
      'hy2://pw@h2.example.com:8443#HY2',
      'wireguard://whatever@w.example.com:51820#WG'
    ].join('\n')
    for (const input of [links, b64(links)]) {
      const c = parseSubscription(input)
      const by = Object.fromEntries(c.nodes.map((n) => [n.name, n]))
      expect(Object.keys(by)).toEqual(['SS 1', 'VM 1', 'Trojan', 'VL', 'HY2', 'HY2 (2)', 'WG'])
      expect(by['SS 1']!.proxy).toMatchObject({ type: 'ss', cipher: 'aes-256-gcm', password: 'pa:ss', port: 8388 })
      expect(by['VM 1']!.proxy).toMatchObject({ type: 'vmess', network: 'ws', tls: true, servername: 'a.example.com', 'ws-opts': { path: '/p', headers: { Host: 'h.example.com' } } })
      expect(by['Trojan']!.proxy).toMatchObject({ type: 'trojan', password: 'p@ss+word', 'skip-cert-verify': true })
      expect(by['Trojan']!.insecure).toBe(true)
      expect(by['VL']!.proxy).toMatchObject({ type: 'vless', server: '::1', network: 'grpc', 'reality-opts': { 'public-key': 'abc', 'short-id': '01' } })
      expect(by['HY2']!.proxy).toMatchObject({ type: 'hysteria2', password: 'user:pass', port: 443, obfs: 'salamander' })
      expect(by['WG']!.protocol).toBe('wireguard')
      expect(by['WG']!.proxy).toBeUndefined()
    }
  })

  it('never leaks secrets in errors', () => {
    expect(() => parseNodeLink('trojan://TOPSECRET@example.com:443?type=quic')).toThrow(/^PROXY_UNSUPPORTED_OPTION$/)
    try {
      parseSubscription('proxies: [')
    } catch (e) {
      expect(e).toBeInstanceOf(SubParseError)
      expect(String(e)).not.toContain('proxies')
    }
    expect(() => parseSubscription('x'.repeat(2 * 1024 * 1024 + 1))).toThrow(SubParseError)
  })

  it('names a source from headers', () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null })
    expect(sourceNameFromHeaders(h({ 'profile-title': `base64:${b64('某某云')}` }), 'https://a.b/c')).toBe('某某云')
    expect(sourceNameFromHeaders(h({ 'content-disposition': "attachment; filename*=UTF-8''%E6%9F%90%E4%BA%91.yaml" }), 'https://a.b/c')).toBe('某云')
    expect(sourceNameFromHeaders(h({}), 'https://sub.example.com/api?token=x')).toBe('sub.example.com')
  })
})

function snapshotFor(name: string): MihomoTargetSnapshot {
  const c = parseSubscription(CLASH)
  const dep = collectDependencies(c, name)
  const isGroup = c.groups.some((g) => g.name === name)
  return {
    kind: isGroup ? 'group' : 'node',
    target: name,
    nodes: dep.nodes.map((n) => ({ name: n.name, protocol: n.protocol, proxy: n.proxy! })),
    groups: dep.groups.map(({ name, kind, members, options }) => ({ name, kind, members, options }))
  }
}

describe('goxf Mihomo config', () => {
  const opts = { mixedPort: 23456, username: 'u1', password: 'p1', controllerPort: 23457, secret: 's1' }

  it('builds a loopback, authenticated, MATCH-only config with renamed proxies', () => {
    const built = buildEntryConfig(snapshotFor('🚀 节点选择'), opts)
    const doc = parseYaml(built.yaml) as Record<string, any>
    expect(doc['bind-address']).toBe('127.0.0.1')
    expect(doc['allow-lan']).toBe(false)
    expect(doc.authentication).toEqual(['u1:p1'])
    expect(doc['external-controller']).toBe('127.0.0.1:23457')
    expect(doc.rules).toEqual([`MATCH,${built.target}`])
    expect(doc.proxies.map((p: any) => p.name)).toEqual(['n0', 'n1', 'n2'])
    const select = doc['proxy-groups'].find((g: any) => g.type === 'select')
    // DIRECT never survives
    expect(select.proxies).not.toContain('DIRECT')
    expect(built.yaml).not.toContain('DIRECT')
  })

  it('builds a single-node entry and a controller-only catalog', () => {
    const built = buildEntryConfig(snapshotFor('日本 01'), opts)
    expect(parseYaml(built.yaml).rules).toEqual(['MATCH,n0'])
    const cat = buildCatalogConfig(snapshotFor('♻️ 自动选择').nodes, { controllerPort: 1, secret: 's' })
    const doc = parseYaml(cat.yaml) as Record<string, any>
    expect(doc['mixed-port']).toBeUndefined()
    expect(doc.proxies).toHaveLength(2)
  })

  // Set MIHOMO_BIN to a real mihomo binary to check the generated YAML with `mihomo -t`.
  const bin = process.env.MIHOMO_BIN
  it.runIf(bin && existsSync(bin))('passes `mihomo -t`', () => {
    for (const name of ['🚀 节点选择', '♻️ 自动选择', '日本 01', '新加坡 01']) {
      const { yaml } = buildEntryConfig(snapshotFor(name), opts)
      const out = execFileSync(bin!, ['-t', '-d', '/tmp/mihomo-t', '-config', Buffer.from(yaml).toString('base64')], { encoding: 'utf8' })
      expect(out).toMatch(/test is successful/)
    }
  })
})
