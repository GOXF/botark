/**
 * GOXF fork: Mihomo configuration for one proxy-pool entry (or a throwaway
 * latency-test catalog). Pure; the YAML it returns contains secrets and must only
 * reach the Mihomo child process (environment), never a log.
 *
 * Every proxy and group is renamed (`n0`, `g0`, …) so subscription names never
 * reach rule syntax, and the only rule is `MATCH,<target>`: no DIRECT exit, no
 * GEO data, no DNS hijack, no TUN, no LAN listener.
 */
import { stringify } from 'yaml'
import { isBuiltinName, type MihomoProxy, type SubGroup, type SubNode } from './goxfSubParse'

/** What a pool entry snapshots from a subscription at add time. */
export interface MihomoTargetSnapshot {
  /** `node` = one node; `group` = a subscription group with its members. */
  kind: 'node' | 'group'
  /** Name of the node or group the entry exits through. */
  target: string
  nodes: Array<Pick<SubNode, 'name' | 'protocol'> & { proxy: MihomoProxy }>
  groups: Array<Pick<SubGroup, 'name' | 'kind' | 'members' | 'options'>>
}

export interface MihomoRuntimeOptions {
  /** Loopback mixed (HTTP + SOCKS5) port; 0 = no inbound (catalog latency tests). */
  mixedPort: number
  username?: string
  password?: string
  controllerPort: number
  secret: string
}

export interface BuiltConfig {
  yaml: string
  /** original name → runtime name */
  names: Map<string, string>
  /** runtime name of the exit */
  target?: string
}

function base(opts: MihomoRuntimeOptions): Record<string, unknown> {
  return {
    ...(opts.mixedPort ? { 'mixed-port': opts.mixedPort } : {}),
    'bind-address': '127.0.0.1',
    'allow-lan': false,
    ...(opts.mixedPort && opts.username && opts.password
      ? { authentication: [`${opts.username}:${opts.password}`], 'skip-auth-prefixes': [] }
      : {}),
    mode: 'rule',
    'log-level': 'warning',
    ipv6: true,
    'unified-delay': true,
    'find-process-mode': 'off',
    'geo-auto-update': false,
    'external-controller': `127.0.0.1:${opts.controllerPort}`,
    secret: opts.secret,
    'external-controller-cors': { 'allow-origins': [], 'allow-private-network': false },
    profile: { 'store-selected': false, 'store-fake-ip': false },
    tun: { enable: false },
    dns: { enable: false }
  }
}

function renameAll(nodes: MihomoTargetSnapshot['nodes'], groups: MihomoTargetSnapshot['groups']) {
  const names = new Map<string, string>()
  nodes.forEach((n, i) => names.set(n.name, `n${i}`))
  groups.forEach((g, i) => names.set(g.name, `g${i}`))
  const proxies = nodes.map((n) => {
    const p: Record<string, unknown> = { ...n.proxy, name: names.get(n.name)! }
    const dialer = n.proxy['dialer-proxy']
    if (typeof dialer === 'string' && dialer) {
      if (!names.has(dialer)) throw new Error('节点依赖的前置代理不在快照里')
      p['dialer-proxy'] = names.get(dialer)
    }
    return p
  })
  const proxyGroups = groups.map((g) => {
    // DIRECT and anything missing are dropped; REJECT stays (it never leaks).
    const members = g.members
      .filter((m) => names.has(m) || (isBuiltinName(m) && m.toUpperCase().startsWith('REJECT')))
      .map((m) => names.get(m) ?? m.toUpperCase())
    if (!members.some((m) => /^[ng]\d+$/.test(m))) throw new Error(`分组「${g.name}」里没有可用节点`)
    return { ...g.options, name: names.get(g.name)!, type: g.kind, proxies: members }
  })
  return { names, proxies, proxyGroups }
}

/** Config for one pool entry: everything goes out through `snapshot.target`. */
export function buildEntryConfig(snapshot: MihomoTargetSnapshot, opts: MihomoRuntimeOptions): BuiltConfig {
  if (!opts.mixedPort || !opts.username || !opts.password) throw new Error('pool entry needs an authenticated mixed port')
  const { names, proxies, proxyGroups } = renameAll(snapshot.nodes, snapshot.groups)
  const target = names.get(snapshot.target)
  if (!target) throw new Error('快照里找不到出口节点')
  const doc = { ...base(opts), proxies, 'proxy-groups': proxyGroups, rules: [`MATCH,${target}`] }
  return { yaml: stringify(doc, { lineWidth: 0 }), names, target }
}

/** Config for latency tests of subscription nodes: no inbound, controller only. */
export function buildCatalogConfig(nodes: MihomoTargetSnapshot['nodes'], opts: Omit<MihomoRuntimeOptions, 'mixedPort'>): BuiltConfig {
  // Dialer dependencies outside this set can't be resolved: those nodes are left out.
  const inSet = new Set(nodes.map((n) => n.name))
  const usable = nodes.filter((n) => {
    const d = n.proxy['dialer-proxy']
    return !(typeof d === 'string' && d && !inSet.has(d))
  })
  const { names, proxies } = renameAll(usable, [])
  const doc = { ...base({ ...opts, mixedPort: 0 }), proxies, rules: ['MATCH,REJECT'] }
  return { yaml: stringify(doc, { lineWidth: 0 }), names }
}
