import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MuseProxyConfigInput, MuseProxyPoolItemView, MuseProxyScheme, MuseProxyView, ProxyTestResult } from '@shared/ipc'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'

type Kind = 'direct' | 'system' | 'proxy'
const KIND_LABEL: Record<Kind, string> = { direct: '真直连', system: '跟随系统', proxy: '代理' }
const SCHEMES: Array<{ value: MuseProxyScheme; label: string }> = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks5h', label: 'SOCKS5H' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' }
]
const schemeLabel = (m: MuseProxyScheme) => SCHEMES.find((x) => x.value === m)?.label ?? m
const CUSTOM = '__custom__'

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
  fallbackMode: MuseProxyScheme = 'http'
): {
  mode: MuseProxyScheme
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
    const mode: MuseProxyScheme =
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
 * 网络代理 for one account on any platform: 真直连 / 跟随系统 / 代理 (pool entry or 自定义).
 * Applies to the account's session partition and its Node-side transport; passwords stay in the keychain.
 */
export function ProxySection({ accountId }: { accountId: string }) {
  const platformId = useBotStore((s) => s.accounts[accountId]?.platformId)
  const [view, setView] = useState<MuseProxyView | null>(null)
  const [pool, setPool] = useState<MuseProxyPoolItemView[]>([])
  const [systemProxy, setSystemProxy] = useState<string>()
  const [kind, setKind] = useState<Kind>('system')
  const [choice, setChoice] = useState<string>(CUSTOM)
  const [scheme, setScheme] = useState<MuseProxyScheme>('socks5')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [savedKey, setSavedKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<ProxyTestResult>()
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()

  const draft = useMemo((): MuseProxyConfigInput => {
    if (kind !== 'proxy') return { mode: kind }
    const item = pool.find((p) => p.id === choice)
    if (item) return { mode: item.mode, poolId: item.id }
    return {
      mode: scheme,
      host: host.trim() || undefined,
      port: port.trim() ? Number(port) : scheme === 'https' ? 443 : undefined,
      username: username.trim() || undefined,
      password: password || undefined
    }
  }, [kind, choice, pool, scheme, host, port, username, password])

  const load = useCallback(async () => {
    const muse = getBridge()?.muse
    if (!muse?.getProxy) return
    setError(undefined)
    try {
      const [next, items] = await Promise.all([muse.getProxy(accountId), muse.listProxyPool()])
      void muse.getSystemProxy?.().then(setSystemProxy, () => undefined)
      const bound = items.find((p) => p.assignedAccountIds.includes(accountId))
      const isProxy = next.mode !== 'direct' && next.mode !== 'system'
      setView(next)
      setPool(items)
      setKind(isProxy ? 'proxy' : (next.mode as Kind))
      setChoice(bound?.id ?? (isProxy || items.length === 0 ? CUSTOM : items[0]!.id))
      if (isProxy) setScheme(next.mode as MuseProxyScheme)
      setHost(next.host || '')
      setPort(next.port != null ? String(next.port) : '')
      setUsername(next.username || '')
      setPassword('')
      setSavedKey(
        JSON.stringify(
          !isProxy
            ? { mode: next.mode }
            : bound
              ? { mode: bound.mode, poolId: bound.id }
              : { mode: next.mode, host: next.host, port: next.port, username: next.username }
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [accountId])

  useEffect(() => {
    setTest(undefined)
    void load()
  }, [load])

  const handleHostChange = (rawValue: string) => {
    if (rawValue.includes('://') || rawValue.includes('@') || (rawValue.split(':').length >= 2 && /:\d+/.test(rawValue))) {
      const parsed = parseInlineProxyInput(rawValue, scheme)
      if (parsed) {
        setScheme(parsed.mode)
        setHost(parsed.host)
        if (parsed.port) setPort(parsed.port)
        if (parsed.username !== undefined) setUsername(parsed.username)
        if (parsed.password !== undefined) setPassword(parsed.password)
        return
      }
    }
    setHost(rawValue)
  }

  const dirty = JSON.stringify(draft) !== savedKey || Boolean(password)

  const runTest = async () => {
    const muse = getBridge()?.muse
    if (!muse?.testProxy) return
    setTesting(true)
    setTest(undefined)
    try {
      // Saved setting: test the account's own session; unsaved choice: test the draft.
      setTest(await muse.testProxy(dirty ? { accountId, draft } : { accountId }))
    } catch (err) {
      setTest({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    const muse = getBridge()?.muse
    if (!muse?.setProxy) return
    setSaving(true)
    setError(undefined)
    setHint(undefined)
    try {
      await muse.setProxy(accountId, draft)
      await load()
      setHint(platformId === 'meta-muse' ? t('Proxy saved — reconnect Muse to apply WSS fully') : '已保存并立即生效')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!getBridge()?.muse?.getProxy) {
    return (
      <Section title="网络代理">
        <EmptyLine>{t('Proxy settings require the Electron app')}</EmptyLine>
      </Section>
    )
  }

  const savedKind: Kind | undefined = !view ? undefined : view.mode === 'direct' || view.mode === 'system' ? view.mode : 'proxy'
  const sys = systemProxy?.split(';')[0]?.trim()
  const sysText =
    !sys || sys === 'DIRECT'
      ? '走系统代理；系统现在没开代理，等同直连。'
      : `走系统代理（现在是 ${sys.replace(/^\S+\s+/, '')}），系统没开代理时就是直连。`

  return (
    <Section title="网络代理" tag={savedKind && KIND_LABEL[savedKind]}>
      {error && <p className="pb-1 text-[12px] text-status-error">{error}</p>}
      {hint && <p className="pb-1 text-[12px] text-ink-secondary">{hint}</p>}
      <div className="flex flex-col gap-2.5">
        <SegmentedControl<Kind>
          fullWidth
          size="xs"
          aria-label="网络代理方式"
          value={kind}
          onValueChange={(next) => {
            setKind(next)
            setTest(undefined)
          }}
          options={(['direct', 'system', 'proxy'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        />
        {kind === 'direct' && <p className="text-[12px] text-ink-muted">完全不走任何代理，也不走系统代理。</p>}
        {kind === 'system' && <p className="text-[12px] text-ink-muted">{sysText}</p>}
        {kind === 'proxy' && (
          <>
            <Select
              size="sm"
              value={choice}
              onValueChange={(next) => {
                setChoice(next)
                setTest(undefined)
              }}
              options={[
                ...pool.map((p) => ({
                  value: p.id,
                  // GOXF v20: subscription entries show their node, not the local Mihomo port.
                  label: p.sub
                    ? `${p.sub.name} · ${p.sub.group ? '分组' : p.sub.protocol} · ${p.sub.source} · ${p.assignedAccountIds.length} 个账号`
                    : `${p.host}:${p.port} · ${schemeLabel(p.mode)} · ${p.assignedAccountIds.length} 个账号`
                })),
                { value: CUSTOM, label: '自定义…' }
              ]}
            />
            {choice === CUSTOM && (
              <>
                <div className="grid grid-cols-[96px_1fr_72px] gap-1.5">
                  <Select size="sm" value={scheme} onValueChange={setScheme} options={SCHEMES} aria-label="协议" />
                  <TextInput
                    value={host}
                    onChange={(e) => handleHostChange(e.target.value)}
                    placeholder="地址，或粘贴完整代理链接"
                    aria-label={t('Host')}
                  />
                  <TextInput
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder={scheme === 'https' ? '443' : '1080'}
                    aria-label={t('Port')}
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <TextInput
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('Username (optional)')}
                    autoComplete="off"
                  />
                  <TextInput
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={view?.hasPassword ? t('Leave blank to keep') : t('Password')}
                    autoComplete="new-password"
                  />
                </div>
              </>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
          <Button size="sm" variant="secondary" disabled={testing} onClick={() => void runTest()}>
            {testing ? '测试中…' : '测试连通'}
          </Button>
          {test && (
            <span className="flex items-center gap-1.5 text-ink-secondary">
              <span className={cn('size-2 rounded-full', test.ok ? 'bg-status-online' : 'bg-status-error')} />
              {test.ok ? `${test.ms} ms · 出口 ${test.ip ?? '未知'}` : test.error || '失败'}
            </span>
          )}
        </div>
        <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={() => void save()} className="self-start">
          {t('Save proxy')}
        </Button>
      </div>
    </Section>
  )
}
