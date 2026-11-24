/**
 * Zero-Server Local / Tailscale Companion Sync Bridge for BotArk iOS.
 *
 * Runs strictly inside BotArk Desktop (opt-in, no cloud relay server):
 * - Discovers LAN Wi-Fi & Tailscale IPv4 addresses automatically
 * - Issues short-lived 256-bit QR pairing tokens (`botark://pair?...`)
 * - Authenticates paired iOS devices with SHA-256 hashed Bearer tokens stored in `mobile-sync-devices.json` (`0600`)
 * - Streams live workspace snapshots, message deltas, tool calls, typing, status & approvals over WebSocket
 * - Relays iOS user sends / stop / new-session / approval decisions into BotArk Desktop's native adapters
 * - Optionally exports AES-256-GCM encrypted Hermes direct-connect credentials (or standalone `.botark-sync` AirDrop bundle)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  buildPairingUri,
  type DirectHermesCredential,
  type MobileBridgeLiveEvent,
  type MobileRelayCommand,
  type MobileSendCommand,
  type MobileSendResult,
  type MobileSyncStateView,
  type MobileWorkspaceSnapshot,
  type PairedMobileDeviceView
} from '@shared/mobileSync'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'
import {
  encryptAesGcmCombined,
  fingerprintFromKey,
  generateAes256KeyBase64Url,
  generateRandomToken,
  safeEqualText,
  sha256Hex
} from './mobileSyncCrypto'

const DEFAULT_PORT = 19472
const PAIR_TTL_MS = 10 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024 * 1024
const DEVICE_SEEN_UPDATE_MS = 60_000
export const SEND_RETRY_TTL_MS = 2 * 60 * 1000
const SEND_ACK_TIMEOUT_MS = 5_000
const MAX_SEND_RECORDS = 512
const MAX_WS_BUFFERED_BYTES = 16 * 1024 * 1024
const HEARTBEAT_INTERVAL_MS = 15_000
const WS_HEARTBEAT_PAYLOAD = 'botark'

interface ClientSocket {
  deviceId: string
  awaitingPong: boolean
  ready: boolean
}

interface PendingSend {
  fingerprint: string
  result?: MobileSendResult
  waiters: Set<(result: MobileSendResult) => void>
  expiresAt: number
}

interface StoredDeviceRecord {
  deviceId: string
  deviceName: string
  deviceModel?: string
  tokenHash: string
  pairedAtMs: number
  lastSeenAtMs: number
}

interface StoredDeviceFile {
  devices: StoredDeviceRecord[]
}

export interface MobileSyncServerOptions {
  storePath?: string
  defaultPort?: number
  hostName?: string
  appVersion?: string
  getDirectCredentials?: () => DirectHermesCredential[]
  onCommand?: (command: MobileRelayCommand) => void
  onSendMessage?: (command: MobileSendCommand) => Promise<MobileSendResult>
  sendAckTimeoutMs?: number
  heartbeatIntervalMs?: number
  refreshSnapshot?: () => Promise<void>
  onStateChange?: (state: MobileSyncStateView) => void
}

export const MOBILE_SEND_UNCONFIRMED = {
  ok: false,
  status: 503,
  message: 'Desktop did not confirm that it queued the message'
} as const

/**
 * Rank local IPv4 addresses for iPhone reachability:
 * 1. Primary LAN Wi-Fi (`en0` / `192.168.*` / `10.*` / `172.16-31.*`)
 * 2. Tailscale / CGNAT overlay (`100.64.0.0/10`)
 * Excludes loopback (`127.*`) and link-local (`169.254.*`).
 */
export function discoverReachableLanHosts(): string[] {
  const ifaces = networkInterfaces()
  const scored: Array<{ ip: string; score: number }> = []
  const seen = new Set<string>()

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const ip = entry.address
      if (!ip || seen.has(ip) || ip.startsWith('127.') || ip.startsWith('169.254.')) continue
      seen.add(ip)

      let score = 50
      if (name === 'en0' || name === 'Wi-Fi' || name === 'wlan0') score = 10
      else if (ip.startsWith('192.168.')) score = 20
      else if (ip.startsWith('10.')) score = 25
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score = 30
      else if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip)) score = 35 // Tailscale CGNAT
      scored.push({ ip, score })
    }
  }

  scored.sort((a, b) => a.score - b.score || a.ip.localeCompare(b.ip))
  return scored.length > 0 ? scored.map((s) => s.ip) : ['127.0.0.1']
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('Payload too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON object expected')
  }
  return parsed as Record<string, unknown>
}

export class MobileSyncServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private lifecycle = Promise.resolve<unknown>(undefined)
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private port: number | null = null
  private hosts: string[] = []
  private pairToken: string | null = null
  private pairKey: string | null = null
  private pairExpiresAtMs: number | null = null
  private includeDirectCredentials = true
  private latestSnapshot: MobileWorkspaceSnapshot
  private readonly devices = new Map<string, StoredDeviceRecord>()
  private readonly sockets = new Map<WebSocket, ClientSocket>()
  private readonly sends = new Map<string, PendingSend>()
  private readonly options: MobileSyncServerOptions
  private readonly hostLabel: string
  private readonly appVersion: string

  constructor(options: MobileSyncServerOptions = {}) {
    this.options = options
    this.hostLabel = (options.hostName || hostname() || 'BotArk Desktop').replace(/\.local$/i, '')
    this.appVersion = options.appVersion || '0.8.0'
    this.latestSnapshot = {
      version: 1,
      updatedAtMs: Date.now(),
      hostName: this.hostLabel,
      selectedBotId: null,
      groups: [],
      bots: [],
      accounts: {},
      messages: {},
      approvals: {}
    }
    this.loadDevicesFromDisk()
  }

  private loadDevicesFromDisk(): void {
    if (!this.options.storePath) return
    const file = readJsonFile<StoredDeviceFile>(
      this.options.storePath,
      { devices: [] },
      (raw) => Boolean(raw) && typeof raw === 'object' && Array.isArray((raw as StoredDeviceFile).devices)
    )
    this.devices.clear()
    for (const rec of file.devices) {
      if (rec?.deviceId && rec?.tokenHash) {
        this.devices.set(rec.deviceId, rec)
      }
    }
  }

  private persistDevicesToDisk(): void {
    if (!this.options.storePath) return
    writeJsonAtomic(this.options.storePath, { devices: [...this.devices.values()] }, 0o600)
  }

  private emitState(): void {
    this.options.onStateChange?.(this.getState())
  }

  private authenticateToken(rawToken: string | null | undefined): StoredDeviceRecord | null {
    const clean = (rawToken ?? '').trim()
    if (!clean) return null
    const hash = sha256Hex(clean)
    for (const rec of this.devices.values()) {
      if (safeEqualText(rec.tokenHash, hash)) {
        const now = Date.now()
        if (now - rec.lastSeenAtMs >= DEVICE_SEEN_UPDATE_MS) {
          rec.lastSeenAtMs = now
          this.persistDevicesToDisk()
        }
        return rec
      }
    }
    return null
  }

  private authenticateRequest(req: IncomingMessage): StoredDeviceRecord | null {
    const auth = req.headers['authorization'] || ''
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return this.authenticateToken(auth.slice(7))
    }
    return null
  }

  private rotatePairingSecretsInternal(): void {
    this.pairToken = generateRandomToken(24)
    this.pairKey = generateAes256KeyBase64Url()
    this.pairExpiresAtMs = Date.now() + PAIR_TTL_MS
  }

  getState(): MobileSyncStateView {
    const connectedIds = new Set([...this.sockets.values()].map((client) => client.deviceId))
    const devices: PairedMobileDeviceView[] = [...this.devices.values()]
      .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
      .map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        deviceModel: d.deviceModel,
        pairedAtMs: d.pairedAtMs,
        lastSeenAtMs: d.lastSeenAtMs,
        connected: connectedIds.has(d.deviceId)
      }))

    const running = Boolean(this.server && this.port)
    const fp = this.pairKey ? fingerprintFromKey(this.pairKey) : '--------'
    const pairUri =
      running && this.port && this.pairToken && this.pairKey && this.hosts.length > 0
        ? buildPairingUri({
            version: 1,
            hosts: this.hosts,
            port: this.port,
            token: this.pairToken,
            key: this.pairKey,
            name: this.hostLabel,
            fp
          })
        : null

    return {
      running,
      port: this.port,
      hosts: [...this.hosts],
      primaryHost: this.hosts[0] ?? null,
      hostName: this.hostLabel,
      fingerprint: fp,
      pairUri,
      pairExpiresAtMs: this.pairExpiresAtMs,
      includeDirectCredentials: this.includeDirectCredentials,
      devices
    }
  }

  start(): Promise<MobileSyncStateView> {
    return this.queueLifecycle(() => this.startListening())
  }

  stop(): Promise<MobileSyncStateView> {
    return this.queueLifecycle(() => this.stopListening())
  }

  private queueLifecycle(operation: () => Promise<MobileSyncStateView>): Promise<MobileSyncStateView> {
    const pending = this.lifecycle.then(operation)
    this.lifecycle = pending.catch(() => undefined)
    return pending
  }

  private async startListening(): Promise<MobileSyncStateView> {
    if (this.server && this.port) {
      this.hosts = discoverReachableLanHosts()
      if (!this.pairToken || !this.pairExpiresAtMs || Date.now() > this.pairExpiresAtMs) {
        this.rotatePairingSecretsInternal()
      }
      this.emitState()
      return this.getState()
    }

    this.hosts = discoverReachableLanHosts()
    this.rotatePairingSecretsInternal()

    const preferredPort = this.options.defaultPort ?? DEFAULT_PORT
    const srv = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })

    srv.on('upgrade', (req, socket, head) => {
      if (this.server !== srv) {
        socket.destroy()
        return
      }
      try {
        const u = new URL(req.url || '/', 'http://localhost')
        if (u.pathname !== '/api/mobile/v1/ws') {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        const tokenFromQuery = u.searchParams.get('token')
        const device = this.authenticateRequest(req) ?? this.authenticateToken(tokenFromQuery)
        if (!device) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          void this.connectSocket(ws, device.deviceId)
        })
      } catch {
        socket.destroy()
      }
    })

    const listenOn = (p: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => {
          srv.off('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          srv.off('error', onError)
          const addr = srv.address()
          resolve(typeof addr === 'object' && addr ? addr.port : p)
        }
        srv.once('error', onError)
        srv.once('listening', onListening)
        srv.listen(p, '0.0.0.0')
      })

    try {
      this.port = await listenOn(preferredPort)
    } catch {
      try {
        this.port = await listenOn(0)
      } catch (error) {
        wss.close()
        throw error
      }
    }

    this.server = srv
    this.wss = wss
    this.heartbeat = setInterval(() => {
      for (const [ws, client] of this.sockets) {
        if (client.awaitingPong || ws.bufferedAmount >= MAX_WS_BUFFERED_BYTES) {
          this.dropSocket(ws)
        } else if (ws.readyState === WebSocket.OPEN) {
          client.awaitingPong = true
          ws.ping(WS_HEARTBEAT_PAYLOAD, undefined, (error) => { if (error) this.dropSocket(ws) })
        }
      }
    }, this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
    this.emitState()
    return this.getState()
  }

  private async stopListening(): Promise<MobileSyncStateView> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.sockets.clear()
    if (this.wss) {
      for (const ws of this.wss.clients) ws.terminate()
      this.wss.close()
      this.wss = null
    }
    const server = this.server
    this.server = null
    this.port = null
    this.pairToken = null
    this.pairKey = null
    this.pairExpiresAtMs = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
    this.emitState()
    return this.getState()
  }

  rotatePairing(): MobileSyncStateView {
    this.hosts = discoverReachableLanHosts()
    this.rotatePairingSecretsInternal()
    this.emitState()
    return this.getState()
  }

  setIncludeDirectCredentials(enabled: boolean): MobileSyncStateView {
    this.includeDirectCredentials = Boolean(enabled)
    this.emitState()
    return this.getState()
  }

  revokeDevice(deviceId: string): MobileSyncStateView {
    const cleanId = (deviceId ?? '').trim()
    if (cleanId === '*') {
      this.devices.clear()
    } else if (cleanId) {
      this.devices.delete(cleanId)
    }
    for (const [ws, client] of this.sockets) {
      if (cleanId !== '*' && client.deviceId !== cleanId) continue
      this.sockets.delete(ws)
      ws.close(4001, 'Revoked')
    }
    this.persistDevicesToDisk()
    this.emitState()
    return this.getState()
  }

  updateSnapshot(snapshot: MobileWorkspaceSnapshot, publish = true): void {
    this.latestSnapshot = {
      ...snapshot,
      hostName: this.hostLabel,
      updatedAtMs: Date.now()
    }
    if (publish) this.broadcastLiveEvent({ type: 'snapshot', snapshot: this.latestSnapshot })
  }

  broadcastLiveEvent(event: MobileBridgeLiveEvent): void {
    let encoded: string | undefined
    for (const [ws, client] of this.sockets) {
      if (client.ready) this.sendWs(ws, encoded ??= JSON.stringify(event))
    }
  }

  private async connectSocket(ws: WebSocket, deviceId: string): Promise<void> {
    const client = { deviceId, ready: false, awaitingPong: false }
    ws.on('error', () => this.dropSocket(ws))
    ws.on('close', () => {
      if (this.sockets.delete(ws)) this.emitState()
    })
    ws.on('pong', (payload) => {
      if (payload.toString() === WS_HEARTBEAT_PAYLOAD) client.awaitingPong = false
    })
    ws.on('message', (raw) => {
      if (!this.sockets.has(ws)) return
      try {
        if (JSON.parse(String(raw))?.type === 'ping') {
          this.sendWs(ws, JSON.stringify({ type: 'pong', ts: Date.now() }))
        }
      } catch {
        /* ignore malformed client ping */
      }
    })
    this.sockets.set(ws, client)
    try {
      const device = this.devices.get(deviceId)
      if (device) {
        device.lastSeenAtMs = Date.now()
        this.persistDevicesToDisk()
      }
      this.emitState()
      await this.options.refreshSnapshot?.()
      if (this.sockets.get(ws) !== client) return
      client.ready = true
      this.sendWs(ws, JSON.stringify({ type: 'snapshot', snapshot: this.latestSnapshot }))
    } catch {
      this.dropSocket(ws)
    }
  }

  private dropSocket(ws: WebSocket): void {
    const removed = this.sockets.delete(ws)
    ws.terminate()
    if (removed) this.emitState()
  }

  private sendWs(ws: WebSocket, encoded: string): void {
    if (ws.readyState !== WebSocket.OPEN) return
    // A snapshot can include large inline files. Allow one large frame while
    // the write queue is empty and enforce the cap on subsequent queued data.
    const queued = ws.bufferedAmount
    if (queued > 0 && queued + Buffer.byteLength(encoded) >= MAX_WS_BUFFERED_BYTES) {
      this.dropSocket(ws)
      return
    }
    try {
      ws.send(encoded, (error) => { if (error) this.dropSocket(ws) })
    } catch {
      this.dropSocket(ws)
    }
  }

  /**
   * Build an AES-256-GCM encrypted offline transfer bundle (`.botark-sync`)
   * so users can AirDrop it directly to BotArk iOS without even needing the same Wi-Fi LAN.
   */
  createOfflineEncryptedBundle(): { bundleJson: string; transferKey: string; fingerprint: string } {
    const transferKey = generateAes256KeyBase64Url()
    const fp = fingerprintFromKey(transferKey)
    const directCredentials = this.includeDirectCredentials
      ? (this.options.getDirectCredentials?.() ?? [])
      : []
    const innerPayload = JSON.stringify({
      version: 1,
      exportedAtMs: Date.now(),
      hostName: this.hostLabel,
      snapshot: this.latestSnapshot,
      directCredentials
    })
    const ciphertext = encryptAesGcmCombined(innerPayload, transferKey)
    const outer = {
      format: 'botark-sync-v1',
      cipher: 'AES-256-GCM',
      hostName: this.hostLabel,
      fingerprint: fp,
      exportedAtMs: Date.now(),
      payload: ciphertext
    }
    return {
      bundleJson: JSON.stringify(outer, null, 2),
      transferKey,
      fingerprint: fp
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase()
    let pathname = '/'
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, message: 'Bad URL' })
      return
    }

    try {
      if (method === 'GET' && (pathname === '/' || pathname === '/pair')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        res.end(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BotArk Mobile Sync</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#f8fafc;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.card{max-width:360px;background:#161b22;border:1px solid #30363d;border-radius:20px;padding:28px}</style></head><body><div class="card">
<h2>BotArk Mobile Sync is running</h2>
<p>To pair a phone, open Mobile Sync in BotArk Desktop settings. Scan the pairing QR code from the BotArk mobile app.</p>
</div></body></html>`)
        return
      }

      if (method === 'GET' && pathname === '/api/mobile/v1/ping') {
        sendJson(res, 200, {
          ok: true,
          app: 'botark',
          version: this.appVersion,
          hostName: this.hostLabel,
          fp: this.pairKey ? fingerprintFromKey(this.pairKey) : ''
        })
        return
      }

      if (method === 'POST' && pathname === '/api/mobile/v1/pair') {
        const body = await readJsonBody(req)
        const token = typeof body['pairToken'] === 'string' ? body['pairToken'].trim() : ''
        if (
          !this.pairToken ||
          !this.pairKey ||
          !this.pairExpiresAtMs ||
          Date.now() > this.pairExpiresAtMs ||
          !safeEqualText(token, this.pairToken)
        ) {
          sendJson(res, 401, { ok: false, message: '配对码无效或已过期，请在电脑端刷新二维码重试' })
          return
        }

        const prefix = String(body.deviceModel || '').toLowerCase().includes('android') ? 'and' : 'ios'
        const deviceId = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
        const deviceToken = generateRandomToken(32)
        const deviceName =
          typeof body['deviceName'] === 'string' && body['deviceName'].trim()
            ? body['deviceName'].trim().slice(0, 64)
            : 'iPhone'
        const deviceModel =
          typeof body['deviceModel'] === 'string' && body['deviceModel'].trim()
            ? body['deviceModel'].trim().slice(0, 64)
            : 'iOS'

        const now = Date.now()
        this.devices.set(deviceId, {
          deviceId,
          deviceName,
          deviceModel,
          tokenHash: sha256Hex(deviceToken),
          pairedAtMs: now,
          lastSeenAtMs: now
        })
        this.persistDevicesToDisk()

        // Encrypt direct-connect Hermes credentials with the ephemeral QR AES-256-GCM key when allowed
        let directCredentialsEnc: string | undefined
        if (this.includeDirectCredentials) {
          const creds = this.options.getDirectCredentials?.() ?? []
          if (creds.length > 0) {
            directCredentialsEnc = encryptAesGcmCombined(JSON.stringify(creds), this.pairKey)
          }
        }

        const fp = fingerprintFromKey(this.pairKey)
        // Rotate pairing token immediately after successful single-use pairing!
        this.rotatePairingSecretsInternal()
        this.emitState()

        await this.options.refreshSnapshot?.()
        if (!this.devices.has(deviceId)) {
          sendJson(res, 401, { ok: false, message: '设备未授权或已被电脑端移除' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          deviceId,
          deviceToken,
          hostName: this.hostLabel,
          fp,
          snapshot: this.latestSnapshot,
          ...(directCredentialsEnc ? { directCredentialsEnc } : {})
        })
        return
      }

      // All endpoints below require an authenticated paired device Bearer token
      const device = this.authenticateRequest(req)
      if (!device) {
        sendJson(res, 401, { ok: false, message: '设备未授权或已被电脑端移除' })
        return
      }
      if (method === 'GET' && pathname === '/api/mobile/v1/snapshot') {
        await this.options.refreshSnapshot?.()
        if (this.devices.has(device.deviceId)) {
          sendJson(res, 200, { ok: true, snapshot: this.latestSnapshot })
        } else {
          sendJson(res, 401, { ok: false, message: '设备未授权或已被电脑端移除' })
        }
        return
      }

      const sendMatch = /^\/api\/mobile\/v1\/bots\/([^/]+)\/send$/.exec(pathname)
      if (method === 'POST' && sendMatch) {
        const botId = decodeURIComponent(sendMatch[1]!)
        const body = await readJsonBody(req)
        if (!this.devices.has(device.deviceId) || !this.server) {
          sendJson(res, 401, { ok: false, message: '设备未授权或已被电脑端移除' })
          return
        }
        const text = typeof body['text'] === 'string' ? body['text'].trim() : ''
        const rawAttachments = Array.isArray(body['attachments']) ? body['attachments'] : []
        const attachments: NonNullable<MobileSendCommand['attachments']> = []
        for (const item of rawAttachments.slice(0, 6)) {
          if (!item || typeof item !== 'object') continue
          const rec = item as Record<string, unknown>
          const name = typeof rec['name'] === 'string' && rec['name'].trim() ? rec['name'].trim() : 'attachment'
          const mimeType =
            typeof rec['mimeType'] === 'string' && rec['mimeType'].trim()
              ? rec['mimeType'].trim()
              : 'application/octet-stream'
          const dataUrl = typeof rec['dataUrl'] === 'string' ? rec['dataUrl'].trim() : ''
          if (!dataUrl.startsWith('data:')) continue
          const size = typeof rec['size'] === 'number' && Number.isFinite(rec['size']) ? rec['size'] : undefined
          attachments.push({ name, mimeType, dataUrl, size })
        }
        if (!text && attachments.length === 0) {
          sendJson(res, 400, { ok: false, message: 'Message text or attachment is required' })
          return
        }
        const id = body['clientMessageId']
        if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
          sendJson(res, 400, { ok: false, message: 'Invalid client message ID' })
          return
        }
        const result = await this.queueSend(device.deviceId, {
          botId,
          text,
          clientMessageId: id ?? `mobile_${randomUUID()}`,
          ...(attachments.length > 0 ? { attachments } : {})
        })
        if (!result.ok) {
          sendJson(res, result.status, { ok: false, message: result.message })
        } else {
          sendJson(res, 200, { ok: true, messageId: result.messageId, acceptedAt: Date.now() })
        }
        return
      }

      const stopMatch = /^\/api\/mobile\/v1\/bots\/([^/]+)\/stop$/.exec(pathname)
      if (method === 'POST' && stopMatch) {
        const botId = decodeURIComponent(stopMatch[1]!)
        this.options.onCommand?.({ kind: 'stopGeneration', botId })
        sendJson(res, 200, { ok: true })
        return
      }

      const newSessionMatch = /^\/api\/mobile\/v1\/bots\/([^/]+)\/new-session$/.exec(pathname)
      if (method === 'POST' && newSessionMatch) {
        const botId = decodeURIComponent(newSessionMatch[1]!)
        this.options.onCommand?.({ kind: 'newSession', botId })
        sendJson(res, 200, { ok: true })
        return
      }

      const approvalMatch = /^\/api\/mobile\/v1\/approvals\/([^/]+)\/([^/]+)$/.exec(pathname)
      if (method === 'POST' && approvalMatch) {
        const accountId = decodeURIComponent(approvalMatch[1]!)
        const approvalId = decodeURIComponent(approvalMatch[2]!)
        const body = await readJsonBody(req)
        if (!this.devices.has(device.deviceId) || !this.server) {
          sendJson(res, 401, { ok: false, message: '设备未授权或已被电脑端移除' })
          return
        }
        const platformId = String(body['platformId'] ?? 'meta-muse') as MobileRelayCommand & {
          kind: 'decideApproval'
        } extends { platformId: infer P }
          ? P
          : never
        const decision = String(body['decision'] ?? 'deny') as
          | 'allow_once'
          | 'allow_session'
          | 'allow_always'
          | 'deny'
          | 'deny_always'
        this.options.onCommand?.({
          kind: 'decideApproval',
          accountId,
          platformId,
          approvalId,
          decision
        })
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { ok: false, message: 'Not found' })
    } catch (error) {
      if (res.destroyed || res.headersSent) return
      sendJson(res, 500, {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async queueSend(deviceId: string, command: MobileSendCommand): Promise<MobileSendResult> {
    const now = Date.now()
    for (const [id, entry] of this.sends) {
      if (entry.expiresAt <= now) this.sends.delete(id)
    }
    const key = JSON.stringify([deviceId, command.clientMessageId])
    const attSig = (command.attachments ?? []).map((a) => [a.name, a.mimeType, sha256Hex(a.dataUrl)])
    const fingerprint = sha256Hex(JSON.stringify([command.botId, command.text, attSig]))
    const previous = this.sends.get(key)
    if (previous) {
      return previous.fingerprint === fingerprint
        ? this.waitForSendAcknowledgment(previous)
        : { ok: false, status: 409, message: 'Message ID is already in use' }
    }
    if (!this.options.onSendMessage || this.sends.size >= MAX_SEND_RECORDS) {
      return { ok: false, status: 503, message: 'Desktop is unavailable' }
    }

    const dispatch = this.options.onSendMessage
    const entry: PendingSend = { fingerprint, waiters: new Set(), expiresAt: Infinity }
    this.sends.set(key, entry)
    void Promise.resolve().then(() => dispatch(command)).catch(() => MOBILE_SEND_UNCONFIRMED).then((result) => {
      entry.result = result
      if (result.ok || result === MOBILE_SEND_UNCONFIRMED) entry.expiresAt = Date.now() + SEND_RETRY_TTL_MS
      else this.sends.delete(key)
      for (const waiter of entry.waiters) waiter(result)
    })
    return this.waitForSendAcknowledgment(entry)
  }

  private waitForSendAcknowledgment(entry: PendingSend): Promise<MobileSendResult> {
    if (entry.result) return Promise.resolve(entry.result)
    return new Promise((resolve) => {
      const finish = (result: MobileSendResult) => {
        clearTimeout(timer)
        entry.waiters.delete(finish)
        resolve(result)
      }
      const timer = setTimeout(
        () => finish(MOBILE_SEND_UNCONFIRMED), this.options.sendAckTimeoutMs ?? SEND_ACK_TIMEOUT_MS
      )
      entry.waiters.add(finish)
    })
  }
}

export function defaultMobileSyncDevicesPath(userDataDir: string): string {
  return join(userDataDir, 'mobile-sync-devices.json')
}
