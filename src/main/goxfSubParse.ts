/**
 * GOXF fork: subscription → node/group catalog for the Mihomo-backed proxy pool.
 * Ported from jlcodes99/cockpit-tools (codex_proxy_subscription_parser.rs,
 * codex_proxy_node_parser.rs, codex_proxy_catalog_binding.rs), translated to TS
 * and emitting native Mihomo proxy objects directly.
 *
 * Pure: no Electron, no I/O. Never put input text, node parameters or parser
 * details into errors or logs — only the stable codes below.
 */
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'

export const SUB_MAX_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 4096

export type SubErrorCode =
  | 'SUBSCRIPTION_INVALID'
  | 'SUBSCRIPTION_TOO_LARGE'
  | 'SUBSCRIPTION_EMPTY'
  | 'SUBSCRIPTION_PROVIDER_UNSUPPORTED'

export class SubParseError extends Error {
  constructor(readonly code: SubErrorCode) {
    super(SUB_ERROR_TEXT[code])
    this.name = 'SubParseError'
  }
}

const SUB_ERROR_TEXT: Record<SubErrorCode, string> = {
  SUBSCRIPTION_INVALID: '订阅内容无法识别（支持 Clash / Mihomo YAML、Base64 节点列表、ss:// vmess:// trojan:// vless:// hysteria2:// 链接）',
  SUBSCRIPTION_TOO_LARGE: '订阅内容超过 2 MB',
  SUBSCRIPTION_EMPTY: '订阅里没有节点',
  SUBSCRIPTION_PROVIDER_UNSUPPORTED: '订阅只引用了外部 proxy-providers，暂不支持'
}

/** Node-level reasons (shown as a short hint; never contain node values). */
export const NODE_ERROR_TEXT: Record<string, string> = {
  PROXY_INVALID: '节点参数无效',
  PROXY_UNSUPPORTED: '暂不支持这种节点',
  PROXY_UNSUPPORTED_OPTION: '节点用了暂不支持的参数',
  PROXY_DUPLICATE_NAME: '节点重名',
  GROUP_STRATEGY: '分组类型不支持',
  GROUP_PROVIDER: '分组引用了外部 provider',
  GROUP_EMPTY: '分组里没有可用节点',
  GROUP_FILTER: '分组过滤规则无效',
  GROUP_CYCLE: '分组循环引用'
}

export type MihomoProxy = Record<string, unknown> & { name: string; type: string }

export interface SubNode {
  id: string
  name: string
  /** Mihomo type (`ss`, `vmess`, …) or `unsupported`. */
  protocol: string
  /** Native Mihomo proxy object (contains secrets). Absent when unsupported. */
  proxy?: MihomoProxy
  error?: string
  /** skip-cert-verify / insecure set somewhere in the node. */
  insecure: boolean
}

export interface SubGroup {
  id: string
  name: string
  kind: string
  /** Member names (nodes, groups or built-ins like DIRECT/REJECT). */
  members: string[]
  /** Runtime options kept for Mihomo (url, interval, tolerance, strategy, …). */
  options: Record<string, unknown>
  error?: string
}

export interface SubCatalog {
  nodes: SubNode[]
  groups: SubGroup[]
}

const stableId = (kind: string, value: string): string =>
  createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 24)

// ---------------------------------------------------------------- helpers

function hasControl(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(s)
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const s = String(raw).trim()
  if (!s || s.length > 256 || hasControl(s) || s.includes('://') || /token=|password=/i.test(s)) return null
  return s
}

function pct(s: string): string {
  const out = decodeURIComponent(s.replace(/\+/g, '%2B'))
  if (hasControl(out)) throw new Error('PROXY_INVALID')
  return out
}

function safePct(s: string): string | null {
  try {
    return pct(s)
  } catch {
    return null
  }
}

/** Standard or URL-safe base64, with or without padding → bytes. Null if not base64. */
export function decodeBase64(s: string): Buffer | null {
  const compact = s.replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/_-]+=*$/.test(compact)) return null
  const std = compact.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (std.length % 4 === 1) return null
  return Buffer.from(std, 'base64')
}

function b64Text(s: string): string | null {
  const buf = decodeBase64(s)
  if (!buf) return null
  const text = buf.toString('utf8')
  if (text.includes('\uFFFD')) return null
  return text
}

const BUILTIN = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'])
export const isBuiltinName = (name: string): boolean => BUILTIN.has(name.toUpperCase())

/** Mihomo outbound types a pool entry may use (control and mesh adapters are excluded). */
export function nativeProtocol(kind: string): boolean {
  return (
    /^[a-z][a-z0-9-]{0,63}$/.test(kind) &&
    !['direct', 'reject', 'dns', 'rematch', 'pass', 'pass-rule', 'compatible', 'tailscale', 'zerotier', 'easytier'].includes(kind)
  )
}

export function isInsecure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isInsecure)
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => (['skip-cert-verify', 'insecure'].includes(k.toLowerCase().replace(/_/g, '-')) && v === true) || isInsecure(v)
    )
  }
  return false
}

/** Host safety boundary for native parameters (no local files, no interface binding). */
function checkParameters(value: unknown, depth = 0): void {
  if (depth > 24) throw new Error('PROXY_INVALID')
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error('PROXY_INVALID')
    for (const item of value) checkParameters(item, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>
    for (const [rawKey, v] of Object.entries(map)) {
      const key = rawKey.toLowerCase().replace(/_/g, '-')
      if (['detour', 'bind-interface', 'interface-name', 'routing-mark', 'config-path', 'client-cert', 'client-key', 'unix-socket'].includes(key)) {
        throw new Error('PROXY_UNSUPPORTED_OPTION')
      }
      if (['skip-cert-verify', 'insecure'].includes(key) && typeof v !== 'boolean') throw new Error('PROXY_INVALID')
      if (['certificate', 'private-key', 'ca', 'ca-str'].includes(key)) {
        if (typeof v !== 'string') throw new Error('PROXY_INVALID')
        const encodedKey = key === 'private-key' && ['wireguard', 'masque'].includes(String(map.type))
        if (v && !v.startsWith('-----BEGIN ') && !encodedKey) throw new Error('PROXY_UNSUPPORTED_OPTION')
      }
      checkParameters(v, depth + 1)
    }
    return
  }
  if (typeof value === 'string' && (value.length > 65536 || value.includes('\0'))) throw new Error('PROXY_INVALID')
}

/** Validate a native Mihomo proxy object (from YAML or our URI converter). Throws a code. */
export function validateNativeProxy(proxy: Record<string, unknown>): void {
  const kind = proxy.type
  if (typeof kind !== 'string' || !nativeProtocol(kind)) throw new Error('PROXY_UNSUPPORTED')
  if (typeof proxy.server !== 'string' || !proxy.server.trim() || /[\s/@?#]/.test(proxy.server.replace(/^\[|\]$/g, ''))) {
    // wireguard may use `peers`; everything else needs a server
    if (kind !== 'wireguard') throw new Error('PROXY_INVALID')
  }
  checkParameters(proxy)
  if (kind === 'ssh' && !(Array.isArray(proxy['host-key']) && proxy['host-key'].length > 0)) {
    // Upstream ignores the host key otherwise.
    throw new Error('PROXY_UNSUPPORTED_OPTION')
  }
  if (proxy['dialer-proxy'] !== undefined && typeof proxy['dialer-proxy'] !== 'string') throw new Error('PROXY_INVALID')
}

function codeOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : ''
  return msg in NODE_ERROR_TEXT ? msg : 'PROXY_INVALID'
}

// ---------------------------------------------------------------- share links → Mihomo

type Q = Map<string, string>

function query(u: URL): Q {
  const q: Q = new Map()
  const raw = u.search.replace(/^\?/, '')
  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = safePct(eq >= 0 ? part.slice(0, eq) : part)
    const v = safePct(eq >= 0 ? part.slice(eq + 1) : '')
    if (k === null || v === null) throw new Error('PROXY_INVALID')
    q.set(k, v)
  }
  return q
}

const truthy = (v: string | undefined): boolean => v === '1' || v === 'true'

function hostPort(u: URL, defaultPort?: number): { server: string; port: number } {
  const server = u.hostname.replace(/^\[|\]$/g, '')
  if (!server || /\s/.test(server)) throw new Error('PROXY_INVALID')
  const port = u.port ? Number(u.port) : defaultPort
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROXY_INVALID')
  return { server, port }
}

/** Shared TLS + transport fields used by vless/trojan/vmess links. */
function applyTransport(out: Record<string, unknown>, q: Q): void {
  const net = q.get('type') || q.get('net') || 'tcp'
  const host = q.get('host')
  const path = q.get('path')
  switch (net) {
    case 'tcp':
    case 'raw':
      if ((q.get('headerType') ?? 'none') === 'http') {
        out.network = 'http'
        out['http-opts'] = { path: [path || '/'], ...(host ? { headers: { Host: [host] } } : {}) }
      }
      break
    case 'ws':
      out.network = 'ws'
      out['ws-opts'] = { path: path || '/', ...(host ? { headers: { Host: host } } : {}) }
      break
    case 'httpupgrade':
      out.network = 'ws'
      out['ws-opts'] = { path: path || '/', 'v2ray-http-upgrade': true, ...(host ? { headers: { Host: host } } : {}) }
      break
    case 'grpc':
      out.network = 'grpc'
      out['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || path || '' }
      break
    case 'h2':
    case 'http':
      out.network = 'h2'
      out['h2-opts'] = { path: path || '/', ...(host ? { host: host.split(',') } : {}) }
      break
    case 'xhttp':
      out.network = 'xhttp'
      out['xhttp-opts'] = { path: path || '/', ...(host ? { host } : {}), ...(q.get('mode') ? { mode: q.get('mode') } : {}) }
      break
    default:
      throw new Error('PROXY_UNSUPPORTED_OPTION')
  }
}

function applyTls(out: Record<string, unknown>, q: Q, sniKey: 'servername' | 'sni', defaultSecurity = 'none'): void {
  const security = q.get('security') || defaultSecurity
  if (!['none', 'tls', 'reality', ''].includes(security)) throw new Error('PROXY_UNSUPPORTED_OPTION')
  const sni = q.get('sni') || q.get('peer')
  if (security === 'tls' || security === 'reality') {
    out.tls = true
    if (sni) out[sniKey] = sni
    const alpn = q.get('alpn')
    if (alpn) out.alpn = alpn.split(',').filter(Boolean)
    const fp = q.get('fp')
    if (fp) out['client-fingerprint'] = fp
    if (truthy(q.get('allowInsecure')) || truthy(q.get('insecure'))) out['skip-cert-verify'] = true
  }
  if (security === 'reality') {
    const pbk = q.get('pbk')
    if (!pbk) throw new Error('PROXY_INVALID')
    out['reality-opts'] = { 'public-key': pbk, ...(q.get('sid') ? { 'short-id': q.get('sid') } : {}) }
    if (!out['client-fingerprint']) out['client-fingerprint'] = 'chrome'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseSs(link: string): Record<string, unknown> {
  const body = link.slice('ss://'.length)
  const hashIdx = body.indexOf('#')
  const main = hashIdx >= 0 ? body.slice(0, hashIdx) : body
  let userinfo: string
  let rest: string
  const at = main.lastIndexOf('@')
  if (at < 0) {
    // Legacy: ss://base64(method:password@host:port)
    const qIdx = main.search(/[/?]/)
    const decoded = b64Text(qIdx >= 0 ? main.slice(0, qIdx) : main)
    if (!decoded) throw new Error('PROXY_INVALID')
    const at2 = decoded.lastIndexOf('@')
    if (at2 < 0) throw new Error('PROXY_INVALID')
    userinfo = decoded.slice(0, at2)
    rest = decoded.slice(at2 + 1) + (qIdx >= 0 ? main.slice(qIdx) : '')
  } else {
    const raw = safePct(main.slice(0, at))
    if (raw === null) throw new Error('PROXY_INVALID')
    userinfo = raw.includes(':') ? raw : (b64Text(raw) ?? '')
    rest = main.slice(at + 1)
  }
  const colon = userinfo.indexOf(':')
  if (colon <= 0) throw new Error('PROXY_INVALID')
  const cipher = userinfo.slice(0, colon).toLowerCase()
  const password = userinfo.slice(colon + 1)
  if (!password || hasControl(password)) throw new Error('PROXY_INVALID')
  const u = new URL(`http://${rest.replace(/^\/+/, '')}`)
  const { server, port } = hostPort(u)
  const out: Record<string, unknown> = { type: 'ss', server, port, cipher, password, udp: true }
  const q = query(u)
  const plugin = q.get('plugin')
  if (plugin) {
    const [name, ...opts] = plugin.split(';')
    const kv = new Map(opts.map((o) => {
      const i = o.indexOf('=')
      return i >= 0 ? [o.slice(0, i), o.slice(i + 1)] : [o, 'true']
    }))
    if (name === 'obfs-local' || name === 'simple-obfs') {
      out.plugin = 'obfs'
      out['plugin-opts'] = { mode: kv.get('obfs') || 'http', ...(kv.get('obfs-host') ? { host: kv.get('obfs-host') } : {}) }
    } else if (name === 'v2ray-plugin') {
      out.plugin = 'v2ray-plugin'
      out['plugin-opts'] = {
        mode: kv.get('mode') || 'websocket',
        tls: kv.has('tls'),
        ...(kv.get('host') ? { host: kv.get('host') } : {}),
        ...(kv.get('path') ? { path: kv.get('path') } : {})
      }
    } else {
      throw new Error('PROXY_UNSUPPORTED_OPTION')
    }
  }
  return out
}

function parseVmess(link: string): { proxy: Record<string, unknown>; name?: string } {
  const text = b64Text(link.slice('vmess://'.length).split('#')[0] ?? '')
  if (!text) throw new Error('PROXY_INVALID')
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('PROXY_INVALID')
  }
  if (!obj || typeof obj !== 'object') throw new Error('PROXY_INVALID')
  const f = (k: string): string => (obj[k] === undefined || obj[k] === null ? '' : String(obj[k]))
  const server = f('add').replace(/^\[|\]$/g, '')
  const port = Number(f('port'))
  if (!server || /[\s/@?#]/.test(server) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROXY_INVALID')
  if (!UUID_RE.test(f('id'))) throw new Error('PROXY_INVALID')
  const out: Record<string, unknown> = {
    type: 'vmess',
    server,
    port,
    uuid: f('id'),
    alterId: Number(f('aid') || 0) || 0,
    cipher: f('scy') || 'auto',
    udp: true
  }
  const q: Q = new Map()
  for (const [from, to] of [['net', 'type'], ['host', 'host'], ['path', 'path'], ['sni', 'sni'], ['alpn', 'alpn'], ['fp', 'fp']] as const) {
    if (f(from)) q.set(to, f(from))
  }
  if (f('type') === 'http') q.set('headerType', 'http')
  if (f('net') === 'grpc' && f('path')) q.set('serviceName', f('path'))
  if (f('tls') === 'tls') q.set('security', 'tls')
  if (truthy(f('allowInsecure')) || truthy(f('insecure')) || truthy(f('skip-cert-verify'))) q.set('allowInsecure', '1')
  applyTls(out, q, 'servername')
  applyTransport(out, q)
  return { proxy: out, name: cleanName(f('ps')) ?? undefined }
}

function parseUrlNode(link: string): Record<string, unknown> {
  let u: URL
  try {
    u = new URL(link)
  } catch {
    throw new Error('PROXY_INVALID')
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase()
  const q = query(u)
  const user = safePct(u.username)
  const pass = u.password ? safePct(u.password) : undefined
  if (user === null || pass === null) throw new Error('PROXY_INVALID')
  switch (scheme) {
    case 'vless': {
      const { server, port } = hostPort(u)
      if (!UUID_RE.test(user)) throw new Error('PROXY_INVALID')
      if ((q.get('encryption') ?? 'none') !== 'none' && q.get('encryption') !== '') throw new Error('PROXY_UNSUPPORTED_OPTION')
      const out: Record<string, unknown> = { type: 'vless', server, port, uuid: user, udp: true }
      if (q.get('flow')) out.flow = q.get('flow')
      applyTls(out, q, 'servername')
      applyTransport(out, q)
      return out
    }
    case 'trojan': {
      const { server, port } = hostPort(u, 443)
      if (!user) throw new Error('PROXY_INVALID')
      const out: Record<string, unknown> = { type: 'trojan', server, port, password: user, udp: true }
      applyTls(out, q, 'sni', 'tls')
      if (!out.sni && q.get('sni')) out.sni = q.get('sni')
      applyTransport(out, q)
      return out
    }
    case 'hysteria2':
    case 'hy2': {
      const { server, port } = hostPort(u, 443)
      const password = pass !== undefined ? `${user}:${pass}` : user
      if (!password) throw new Error('PROXY_INVALID')
      const out: Record<string, unknown> = { type: 'hysteria2', server, port, password, udp: true }
      const sni = q.get('sni') || q.get('peer')
      if (sni) out.sni = sni
      if (q.get('alpn')) out.alpn = q.get('alpn')!.split(',').filter(Boolean)
      if (truthy(q.get('insecure')) || truthy(q.get('allowInsecure'))) out['skip-cert-verify'] = true
      if (q.get('obfs')) {
        out.obfs = q.get('obfs')
        if (q.get('obfs-password')) out['obfs-password'] = q.get('obfs-password')
      }
      if (q.get('mport')) out.ports = q.get('mport')
      if (q.get('pinSHA256')) out.fingerprint = q.get('pinSHA256')
      return out
    }
    case 'tuic': {
      const { server, port } = hostPort(u, 443)
      if (!UUID_RE.test(user) || !pass) throw new Error('PROXY_INVALID')
      const out: Record<string, unknown> = { type: 'tuic', server, port, uuid: user, password: pass, udp: true }
      if (q.get('sni')) out.sni = q.get('sni')
      out.alpn = (q.get('alpn') || 'h3').split(',').filter(Boolean)
      if (q.get('congestion_control')) out['congestion-controller'] = q.get('congestion_control')
      if (q.get('udp_relay_mode')) out['udp-relay-mode'] = q.get('udp_relay_mode')
      if (truthy(q.get('insecure')) || truthy(q.get('allow_insecure'))) out['skip-cert-verify'] = true
      return out
    }
    case 'http':
    case 'https':
    case 'socks5':
    case 'socks5h':
    case 'socks': {
      const { server, port } = hostPort(u, scheme === 'https' ? 443 : scheme === 'http' ? 80 : undefined)
      const out: Record<string, unknown> = { type: scheme.startsWith('socks') ? 'socks5' : 'http', server, port }
      if (scheme === 'https') out.tls = true
      if (user) out.username = user
      if (pass) out.password = pass
      return out
    }
    default:
      throw new Error('PROXY_UNSUPPORTED')
  }
}

function linkName(link: string): string | null {
  const hash = link.indexOf('#')
  if (hash < 0) return null
  const s = safePct(link.slice(hash + 1))
  return s === null ? null : cleanName(s)
}

/** Parse one share link to a native Mihomo proxy (name not yet set). Throws a code. */
export function parseNodeLink(link: string): { proxy: Record<string, unknown>; name: string | null } {
  if (link.length > 8192 || hasControl(link)) throw new Error('PROXY_INVALID')
  const lower = link.slice(0, 12).toLowerCase()
  if (lower.startsWith('vmess://')) {
    const { proxy, name } = parseVmess(link)
    return { proxy, name: name ?? linkName(link) }
  }
  const proxy = lower.startsWith('ss://') ? parseSs(link) : parseUrlNode(link)
  return { proxy, name: linkName(link) }
}

function schemeLabel(link: string): string {
  const s = /^([a-z0-9+.-]+):\/\//i.exec(link)?.[1]?.toLowerCase() ?? ''
  return /^[a-z0-9-]{1,16}$/.test(s) ? s : 'unsupported'
}

function uniqueName(name: string, taken: Set<string>): string {
  let out = name
  for (let i = 2; taken.has(out) || isBuiltinName(out); i++) out = `${name} (${i})`
  taken.add(out)
  return out
}

function fromLinks(text: string): SubCatalog {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  if (lines.length === 0) throw new SubParseError('SUBSCRIPTION_EMPTY')
  if (lines.length > MAX_ITEMS) throw new SubParseError('SUBSCRIPTION_INVALID')
  const taken = new Set<string>()
  const nodes: SubNode[] = []
  lines.forEach((link, index) => {
    if (!link.includes('://')) return
    let proxy: Record<string, unknown> | undefined
    let name: string | null = null
    let error: string | undefined
    try {
      const parsed = parseNodeLink(link)
      validateNativeProxy(parsed.proxy)
      proxy = parsed.proxy
      name = parsed.name
    } catch (err) {
      error = codeOf(err)
      name = linkName(link)
    }
    const finalName = uniqueName(name ?? `节点 ${index + 1}`, taken)
    const protocol = proxy ? String(proxy.type) : schemeLabel(link) === 'unsupported' ? 'unsupported' : schemeLabel(link)
    nodes.push({
      // Stable across refreshes: the link itself when unnamed, else its name.
      id: stableId('node', name ?? link),
      name: finalName,
      protocol,
      ...(proxy ? { proxy: { ...proxy, name: finalName } as MihomoProxy } : {}),
      ...(error ? { error } : {}),
      insecure: proxy ? isInsecure(proxy) : false
    })
  })
  if (nodes.length === 0) throw new SubParseError('SUBSCRIPTION_EMPTY')
  return { nodes, groups: [] }
}

// ---------------------------------------------------------------- Clash / Mihomo YAML

const GROUP_KINDS = ['select', 'url-test', 'fallback', 'load-balance']
const GROUP_OPTION_KEYS = ['url', 'interval', 'tolerance', 'lazy', 'timeout', 'max-failed-times', 'strategy', 'expected-status']

function clashNode(raw: Record<string, unknown>): MihomoProxy {
  const proxy = { ...raw } as Record<string, unknown>
  const kind = String(proxy.type ?? '')
  // Subscription aliases; an explicit native field wins.
  if ((kind === 'vmess' || kind === 'vless') && proxy.sni !== undefined && proxy.servername === undefined) proxy.servername = proxy.sni
  if (kind === 'trojan' && proxy.servername !== undefined && proxy.sni === undefined) proxy.sni = proxy.servername
  if (proxy.mport !== undefined && proxy.ports === undefined) proxy.ports = proxy.mport
  if (typeof proxy.port === 'string' && /^\d+$/.test(proxy.port)) proxy.port = Number(proxy.port)
  validateNativeProxy(proxy)
  return proxy as MihomoProxy
}

function applyFilters(names: string[], m: Record<string, unknown>): string[] {
  let out = names
  const compile = (v: unknown): RegExp[] =>
    typeof v === 'string' && v ? v.split('`').filter(Boolean).map((p) => new RegExp(p.replace(/^\(\?i\)/, ''), /^\(\?i\)/.test(p) ? 'i' : '')) : []
  const include = compile(m.filter)
  const exclude = compile(m['exclude-filter'])
  if (include.length) out = out.filter((n) => include.some((r) => r.test(n)))
  if (exclude.length) out = out.filter((n) => !exclude.some((r) => r.test(n)))
  return out
}

function clashGroup(raw: unknown, nodeNames: string[], nodeTypes: Map<string, string>): SubGroup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  const name = cleanName(m.name)
  if (!name) return null
  const kind = String(m.type ?? '')
  const group: SubGroup = {
    id: stableId('group', name),
    name,
    kind: [...GROUP_KINDS, 'relay'].includes(kind) ? kind : 'unsupported',
    members: [],
    options: {}
  }
  try {
    if (Array.isArray(m.proxies)) {
      group.members = m.proxies.map((x) => cleanName(x)).filter((x): x is string => Boolean(x))
    }
    const all = m['include-all'] === true || m['include-all-proxies'] === true
    if (all) {
      let extra = applyFilters([...nodeNames].sort(), m)
      const excludeType = typeof m['exclude-type'] === 'string' ? m['exclude-type'].toLowerCase().split('|') : []
      if (excludeType.length) extra = extra.filter((n) => !excludeType.includes(nodeTypes.get(n) ?? ''))
      for (const n of extra) if (!group.members.includes(n)) group.members.push(n)
    }
    if (!GROUP_KINDS.includes(kind)) throw new Error('GROUP_STRATEGY')
    if ((m.use !== undefined && !all) || m['include-all-providers'] === true) {
      if (group.members.length === 0) throw new Error('GROUP_PROVIDER')
    }
    if (group.members.length === 0) throw new Error('GROUP_EMPTY')
    for (const key of GROUP_OPTION_KEYS) {
      if (m[key] !== undefined && (typeof m[key] === 'string' || typeof m[key] === 'number' || typeof m[key] === 'boolean')) {
        group.options[key] = m[key]
      }
    }
    if (typeof group.options.url === 'string') {
      const u = new URL(group.options.url)
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) delete group.options.url
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    group.error = msg in NODE_ERROR_TEXT ? msg : 'GROUP_FILTER'
  }
  return group
}

function parseClashYaml(text: string): SubCatalog {
  let doc: unknown
  try {
    doc = parseYaml(text, { maxAliasCount: 1000, uniqueKeys: false, prettyErrors: false, logLevel: 'silent' })
  } catch {
    throw new SubParseError('SUBSCRIPTION_INVALID')
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new SubParseError('SUBSCRIPTION_INVALID')
  const root = doc as Record<string, unknown>
  const proxies = Array.isArray(root.proxies) ? root.proxies : []
  const groups = Array.isArray(root['proxy-groups']) ? root['proxy-groups'] : []
  if (proxies.length === 0) {
    const providers = root['proxy-providers']
    if (providers && typeof providers === 'object' && Object.keys(providers).length) throw new SubParseError('SUBSCRIPTION_PROVIDER_UNSUPPORTED')
    throw new SubParseError(root.proxies === undefined && root['proxy-groups'] === undefined ? 'SUBSCRIPTION_INVALID' : 'SUBSCRIPTION_EMPTY')
  }
  if (proxies.length + groups.length > MAX_ITEMS) throw new SubParseError('SUBSCRIPTION_INVALID')

  const seen = new Set<string>()
  const nodes: SubNode[] = []
  for (const raw of proxies) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const m = raw as Record<string, unknown>
    const name = cleanName(m.name)
    if (!name) continue
    const type = typeof m.type === 'string' ? m.type.toLowerCase() : ''
    const protocol = nativeProtocol(type) ? type : 'unsupported'
    if (seen.has(name) || isBuiltinName(name)) {
      nodes.push({ id: stableId('node', `${name}#${nodes.length}`), name, protocol, error: 'PROXY_DUPLICATE_NAME', insecure: false })
      continue
    }
    seen.add(name)
    try {
      const proxy = clashNode({ ...m, type })
      nodes.push({ id: stableId('node', name), name, protocol, proxy, insecure: isInsecure(proxy) })
    } catch (err) {
      nodes.push({ id: stableId('node', name), name, protocol, error: codeOf(err), insecure: false })
    }
  }
  const usableNames = nodes.filter((n) => n.proxy).map((n) => n.name)
  const types = new Map(nodes.map((n) => [n.name, n.protocol]))
  const parsedGroups: SubGroup[] = []
  for (const raw of groups) {
    const g = clashGroup(raw, usableNames, types)
    if (!g) continue
    if (seen.has(g.name) || isBuiltinName(g.name)) continue
    seen.add(g.name)
    parsedGroups.push(g)
  }
  const catalog = { nodes, groups: parsedGroups }
  markGroupUsability(catalog)
  return catalog
}

/**
 * A group is usable when it can only exit through supported subscription nodes:
 * select → any usable member (unusable ones are dropped at runtime);
 * url-test / fallback / load-balance → every member usable (never silently lose
 * a candidate). DIRECT is never usable: a pool proxy must not go direct.
 */
export function markGroupUsability(catalog: SubCatalog): void {
  const nodeOk = new Map(catalog.nodes.map((n) => [n.name, Boolean(n.proxy)]))
  const index = new Map(catalog.groups.map((g, i) => [g.name, i]))
  let ok = catalog.groups.map(() => false)
  for (let round = 0; round < 32; round++) {
    const prev = ok
    ok = catalog.groups.map((g, i) => {
      if (prev[i]) return true
      if (g.error || g.members.length === 0) return false
      const member = (name: string): boolean => {
        if (isBuiltinName(name)) return name.toUpperCase().startsWith('REJECT')
        if (nodeOk.has(name)) return nodeOk.get(name)!
        const gi = index.get(name)
        return gi !== undefined && prev[gi]!
      }
      // REJECT alone is not an exit.
      const real = g.members.filter((m) => !isBuiltinName(m))
      return g.kind === 'select' ? real.some(member) : g.members.every(member) && real.length > 0
    })
    if (ok.every((v, i) => v === prev[i])) break
  }
  catalog.groups.forEach((g, i) => {
    if (!ok[i] && !g.error) g.error = 'GROUP_EMPTY'
  })
}

// ---------------------------------------------------------------- entry point

/** Parse a subscription body or pasted node links. Throws `SubParseError`. */
export function parseSubscription(input: string): SubCatalog {
  if (Buffer.byteLength(input, 'utf8') > SUB_MAX_BYTES) throw new SubParseError('SUBSCRIPTION_TOO_LARGE')
  const text = input.replace(/^\uFEFF/, '').trim()
  if (!text) throw new SubParseError('SUBSCRIPTION_EMPTY')
  const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(first) && !/^(proxies|proxy-groups)\s*:/m.test(text)) return fromLinks(text)
  if (/^[A-Za-z0-9+/=_\s-]+$/.test(text)) {
    const decoded = b64Text(text)
    if (decoded && decoded.includes('://')) return fromLinks(decoded)
    throw new SubParseError('SUBSCRIPTION_INVALID')
  }
  return parseClashYaml(text)
}

/** Names reachable from `rootName` (groups expanded, dialer-proxy dependencies included). */
export function collectDependencies(catalog: SubCatalog, rootName: string): { nodes: SubNode[]; groups: SubGroup[] } {
  const nodeByName = new Map(catalog.nodes.map((n) => [n.name, n]))
  const groupByName = new Map(catalog.groups.map((g) => [g.name, g]))
  const nodes = new Map<string, SubNode>()
  const groups = new Map<string, SubGroup>()
  const visit = (name: string, depth: number): void => {
    if (depth > 32) return
    const node = nodeByName.get(name)
    if (node) {
      if (!node.proxy || nodes.has(name)) return
      nodes.set(name, node)
      const dialer = node.proxy['dialer-proxy']
      if (typeof dialer === 'string' && dialer) visit(dialer, depth + 1)
      return
    }
    const group = groupByName.get(name)
    if (!group || group.error || groups.has(name)) return
    groups.set(name, group)
    for (const m of group.members) visit(m, depth + 1)
  }
  visit(rootName, 0)
  return { nodes: [...nodes.values()], groups: [...groups.values()] }
}

/** `profile-title` / Content-Disposition / host name → a display name for a source. */
export function sourceNameFromHeaders(headers: { get(name: string): string | null }, url: string): string {
  const title = headers.get('profile-title')
  if (title) {
    const t = title.startsWith('base64:') ? b64Text(title.slice(7)) : title
    const name = cleanName(t)
    if (name) return name.slice(0, 64)
  }
  const cd = headers.get('content-disposition')
  if (cd) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd)?.[1]
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd)?.[1]
    const raw = star ? safePct(star) : plain
    const name = cleanName(raw?.replace(/\.(ya?ml|txt|conf)$/i, ''))
    if (name) return name.slice(0, 64)
  }
  try {
    return new URL(url).hostname
  } catch {
    return '订阅'
  }
}
