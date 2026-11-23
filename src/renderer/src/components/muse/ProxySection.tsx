import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { MuseProxyMode, MuseProxyView } from '@shared/ipc'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { Select } from '@/components/ui/Select'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'

const MODES: Array<{ value: MuseProxyMode; label: () => string }> = [
  { value: 'direct', label: () => t('Direct (no proxy)') },
  { value: 'http', label: () => t('HTTP proxy') },
  { value: 'https', label: () => t('HTTPS proxy') },
  { value: 'socks5', label: () => t('SOCKS5') },
  { value: 'socks5h', label: () => t('SOCKS5H (remote DNS)') }
]

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Smart parser when a user pastes a complete proxy URL (`https://user:pass@host:port`,
 * `socks5://host:port`, or `host:port:user:pass`) into the Host input box.
 */
export function parseInlineProxyInput(
  raw: string,
  fallbackMode: Exclude<MuseProxyMode, 'direct'> = 'http'
): {
  mode: Exclude<MuseProxyMode, 'direct'>
  host: string
  port?: string
  username?: string
  password?: string
} | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const schemeMatch = /^(https?|socks5h?|socks):\/\/(.+)$/i.exec(trimmed)
  if (schemeMatch) {
    const rawScheme = schemeMatch[1]!.toLowerCase()
    const mode: Exclude<MuseProxyMode, 'direct'> =
      rawScheme === 'https'
        ? 'https'
        : rawScheme === 'http'
          ? 'http'
          : rawScheme === 'socks5h'
            ? 'socks5h'
            : 'socks5'
    const rest = schemeMatch[2]!.replace(/[/?#].*$/, '')
    const atIdx = rest.lastIndexOf('@')
    const hostPort = atIdx >= 0 ? rest.slice(atIdx + 1) : rest
    const authPart = atIdx >= 0 ? rest.slice(0, atIdx) : ''
    if (!hostPort) return null

    let host = hostPort
    let port: string | undefined
    let extraUser: string | undefined
    let extraPass: string | undefined

    if (hostPort.startsWith('[')) {
      const closeIdx = hostPort.indexOf(']')
      if (closeIdx <= 1) return null
      host = hostPort.slice(0, closeIdx + 1)
      const tail = hostPort.slice(closeIdx + 1)
      if (tail.startsWith(':')) {
        const parts = tail.slice(1).split(':')
        if (/^\d+$/.test(parts[0] ?? '')) port = parts[0]
        if (parts.length > 1) extraUser = parts[1]
        if (parts.length > 2) extraPass = parts.slice(2).join(':')
      }
    } else {
      const parts = hostPort.split(':')
      host = parts[0]!.trim()
      if (parts.length >= 2 && /^\d+$/.test(parts[1] ?? '')) {
        port = parts[1]
        if (parts.length > 2) extraUser = parts[2]
        if (parts.length > 3) extraPass = parts.slice(3).join(':')
      }
    }

    if (!port && mode === 'https') port = '443'
    if (!port && mode === 'http') port = '80'

    let username: string | undefined
    let password: string | undefined
    if (authPart) {
      const cIdx = authPart.indexOf(':')
      username = cIdx >= 0 ? safeDecode(authPart.slice(0, cIdx)) : safeDecode(authPart)
      password = cIdx >= 0 ? safeDecode(authPart.slice(cIdx + 1)) : undefined
    } else if (extraUser) {
      username = safeDecode(extraUser)
      password = extraPass ? safeDecode(extraPass) : undefined
    }

    if (!host) return null
    return { mode, host, port, username, password }
  }

  // `host:port:user:pass` or `user:pass@host:port` pasted into Host field
  if (trimmed.includes('@')) {
    const atIdx = trimmed.lastIndexOf('@')
    const authPart = trimmed.slice(0, atIdx)
    const hostPort = trimmed.slice(atIdx + 1)
    const colonIdx = hostPort.lastIndexOf(':')
    if (colonIdx <= 0) return null
    const h = hostPort.slice(0, colonIdx).trim()
    const p = hostPort.slice(colonIdx + 1).trim()
    if (!h || !/^\d+$/.test(p)) return null
    const cIdx = authPart.indexOf(':')
    return {
      mode: fallbackMode,
      host: h,
      port: p,
      username: cIdx >= 0 ? safeDecode(authPart.slice(0, cIdx)) : safeDecode(authPart),
      password: cIdx >= 0 ? safeDecode(authPart.slice(cIdx + 1)) : undefined
    }
  }

  if (!trimmed.startsWith('[')) {
    const parts = trimmed.split(':')
    if (parts.length >= 2 && /^\d+$/.test(parts[1] ?? '')) {
      return {
        mode: fallbackMode,
        host: parts[0]!.trim(),
        port: parts[1]!.trim(),
        username: parts[2]?.trim() || undefined,
        password: parts.length > 3 ? parts.slice(3).join(':') : undefined
      }
    }
  }

  return null
}

/**
 * Per-account isolated egress proxy across all 6 platforms (partition + WSS/RPC transport).
 * Password stored via OS Keychain (`safeStorage`) with fail-closed leak protection.
 */
export function ProxySection({ accountId }: { accountId: string }) {
  const platformId = useBotStore((s) => s.accounts[accountId]?.platformId)
  const [view, setView] = useState<MuseProxyView | null>(null)
  const [mode, setMode] = useState<MuseProxyMode>('direct')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()

  const refresh = useCallback(async () => {
    const muse = getBridge()?.muse
    if (!muse?.getProxy) {
      setView(null)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const next = await muse.getProxy(accountId)
      setView(next)
      setMode(next.mode)
      setHost(next.host || '')
      setPort(next.port != null ? String(next.port) : '')
      setUsername(next.username || '')
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleHostChange = (rawValue: string) => {
    const fallback: Exclude<MuseProxyMode, 'direct'> = mode === 'direct' ? 'http' : mode
    if (rawValue.includes('://') || rawValue.includes('@') || (rawValue.split(':').length >= 2 && /:\d+/.test(rawValue))) {
      const parsed = parseInlineProxyInput(rawValue, fallback)
      if (parsed) {
        setMode(parsed.mode)
        setHost(parsed.host)
        if (parsed.port) setPort(parsed.port)
        if (parsed.username !== undefined) setUsername(parsed.username)
        if (parsed.password !== undefined) setPassword(parsed.password)
        return
      }
    }
    setHost(rawValue)
  }

  const save = async () => {
    const muse = getBridge()?.muse
    if (!muse?.setProxy) return
    setSaving(true)
    setError(undefined)
    setHint(undefined)
    try {
      const next = await muse.setProxy(accountId, {
        mode,
        host: host.trim() || undefined,
        port: port.trim() ? Number(port) : mode === 'https' ? 443 : undefined,
        username: username.trim() || undefined,
        password: password || undefined
      })
      setView(next)
      setMode(next.mode)
      setHost(next.host || '')
      setPort(next.port != null ? String(next.port) : '')
      setUsername(next.username || '')
      setPassword('')
      setHint(
        platformId === 'meta-muse'
          ? t('Proxy saved — reconnect Muse to apply WSS fully')
          : '独立代理已加密生效（钥匙串锁定异常时自动阻断直连防泄漏）'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!getBridge()?.muse?.getProxy) {
    return (
      <Section title={t('Account proxy')}>
        <EmptyLine>{t('Proxy settings require the Electron app')}</EmptyLine>
      </Section>
    )
  }

  return (
    <Section
      title={t('Account proxy')}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {error && <p className="pb-1 text-[12px] text-status-error">{error}</p>}
      {hint && <p className="pb-1 text-[12px] text-ink-secondary">{hint}</p>}
      <p className="mb-2 flex items-center gap-1 text-[11px] text-ink-muted">
        <ShieldCheck className="size-3 shrink-0 text-status-online-ink" aria-hidden />
        <span>钥匙串加密存储 · 不可读时自动阻断直连</span>
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 text-[12px]">
          <span className="font-medium text-ink">{t('Mode')}</span>
          <Select
            size="sm"
            value={mode}
            onValueChange={(next) => {
              setMode(next)
              if (next === 'https' && !port.trim()) setPort('443')
            }}
            options={MODES.map((m) => ({ value: m.value, label: m.label() }))}
          />
        </div>
        {mode !== 'direct' && (
          <>
            <div className="grid grid-cols-[1fr_84px] gap-1.5">
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="font-medium text-ink">{t('Host')}</span>
                <TextInput
                  value={host}
                  onChange={(e) => handleHostChange(e.target.value)}
                  placeholder={mode === 'https' ? 'proxy.example.com 或粘贴完整代理链接' : '127.0.0.1 或粘贴完整代理链接'}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="font-medium text-ink">{t('Port')}</span>
                <TextInput
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder={mode === 'https' ? '443' : '7890'}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium text-ink">{t('Username (optional)')}</span>
              <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium text-ink">
                {t('Password')}
                {view?.hasPassword ? ` · ${t('stored')}` : ''}
              </span>
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={view?.hasPassword ? t('Leave blank to keep') : ''}
                autoComplete="new-password"
              />
            </label>
          </>
        )}
        <Button size="sm" variant="secondary" disabled={saving} onClick={() => void save()}>
          {t('Save proxy')}
        </Button>
      </div>
    </Section>
  )
}
