import { desktopCopy, desktopNotice, useDesktopLocale } from '@/lib/desktopCopy'
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { MobileSyncStateView } from '@shared/mobileSync'
import { Check, Copy, Power, RefreshCw, Trash2 } from 'lucide-react'
import {
  ArkExportDocSvg,
  ArkMobileLinkSvg,
  ArkQrPairingSvg,
  ArkShieldVaultSvg
} from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function MobileSyncSettingsPanel() {
  useDesktopLocale()
  const [state, setState] = useState<MobileSyncStateView | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [copiedKey, setCopiedKey] = useState<'uri' | 'bundle' | null>(null)
  const [exportedBundle, setExportedBundle] = useState<{
    filePath: string
    transferKey: string
    fingerprint: string
  } | null>(null)
  const [error, setError] = useState<string>()

  const loadState = useCallback(async () => {
    const sync = getBridge()?.mobileSync
    if (!sync) return
    try {
      const next = await sync.getState()
      setState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    const sync = getBridge()?.mobileSync
    if (!sync) return
    void loadState()
    return sync.onStateChanged((next) => setState(next))
  }, [loadState])

  useEffect(() => {
    let cancelled = false
    if (!state?.pairUri) {
      setQrDataUrl('')
      return
    }
    void QRCode.toDataURL(state.pairUri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 260,
      color: { dark: '#0f172a', light: '#ffffff' }
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('')
      })
    return () => {
      cancelled = true
    }
  }, [state?.pairUri])

  const handleStartOrStop = async () => {
    const sync = getBridge()?.mobileSync
    if (!sync) return
    setBusy(true)
    setError(undefined)
    try {
      const next = state?.running ? await sync.stop() : await sync.start()
      setState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRotate = async () => {
    const sync = getBridge()?.mobileSync
    if (!sync) return
    setBusy(true)
    try {
      setState(await sync.rotatePairing())
    } finally {
      setBusy(false)
    }
  }

  const handleToggleDirectCreds = async (enabled: boolean) => {
    const sync = getBridge()?.mobileSync
    if (!sync) return
    setState(await sync.setIncludeDirectCredentials(enabled))
  }

  const handleRevoke = async (deviceId: string) => {
    const sync = getBridge()?.mobileSync
    if (!sync) return
    setState(await sync.revokeDevice(deviceId))
  }

  const handleExportOfflineBundle = async () => {
    const sync = getBridge()?.mobileSync
    if (!sync) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await sync.exportOfflineBundle()
      if (!res.canceled) {
        setExportedBundle({
          filePath: res.filePath,
          transferKey: res.transferKey,
          fingerprint: res.fingerprint
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copyText = (text: string, kind: 'uri' | 'bundle') => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(kind)
      setTimeout(() => setCopiedKey((cur) => (cur === kind ? null : cur)), 1800)
    })
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-ink">{desktopCopy("移动端局域网同步", "Mobile sync over the local network")}</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">{desktopCopy("iOS / Android 同网扫码即端到端加密同步全部 6 大平台会话，支持离线包导入", "Pair an iOS or Android device on the same network, or import an offline sync package.")}</p>
        </div>
        {state?.running && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void handleStartOrStop()}
          >
            <Power className="size-3.5" />{desktopCopy("停止同步桥", "Stop sync bridge")}</Button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-status-error/30 bg-status-error/8 px-3.5 py-2.5 text-[12.5px] text-status-error">
          {desktopNotice(error)}
        </div>
      )}

      {/* Sculpted QR Pairing Stage */}
      <div className="grid gap-5 rounded-2xl border border-line/70 bg-surface p-5 shadow-soft md:grid-cols-[248px_1fr]">
        <div className="flex flex-col items-center justify-center rounded-2xl bg-main p-4 ring-1 ring-line/60">
          {state?.running && qrDataUrl ? (
            <>
              <img
                src={qrDataUrl}
                alt={desktopCopy("BotArk 移动端配对二维码", "BotArk mobile pairing QR code")}
                className="size-[208px] rounded-xl bg-white p-1.5 shadow-sm"
              />
              <div className="mt-2.5 flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 font-mono text-[11px] text-ink">
                <ArkShieldVaultSvg className="size-3.5 text-status-online" />
                <span>{state.fingerprint}</span>
              </div>
            </>
          ) : (
            <div className="flex h-[216px] flex-col items-center justify-center gap-3 text-center">
              <div className="grid size-13 place-items-center rounded-2xl bg-hover text-ink-secondary">
                <ArkQrPairingSvg className="size-6" />
              </div>
              <p className="max-w-[176px] text-[12.5px] leading-[18px] text-ink-secondary">{desktopCopy("生成局域网一次性加密配对码", "Generate a one-time LAN pairing code")}</p>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void handleStartOrStop()}>{desktopCopy("开启扫码配对", "Start QR code pairing")}</Button>
            </div>
          )}
        </div>

        <div className="flex flex-col justify-between gap-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium',
                  state?.running
                    ? 'bg-status-online/12 text-status-online-ink'
                    : 'bg-hover text-ink-muted'
                )}
              >
                <ArkMobileLinkSvg className="size-3.5" />
                {state?.running ? desktopCopy("运行中 · :{0}", "Running · Port {0}", [(state.port)]) : desktopCopy("未启动", "Not started")}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-hover px-2.5 py-1 text-[11.5px] text-ink-secondary">
                <ArkShieldVaultSvg className="size-3.5" />{desktopCopy("AES-256-GCM 零云端中转", "Local network sync")}</span>
            </div>

            {/* Concise 3-step capsule strip */}
            <div className="grid grid-cols-3 gap-2">
              {[
                ['01', desktopCopy("打开 iOS / Android 端", "Open BotArk on iOS or Android")],
                ['02', desktopCopy("扫描一次性配对码", "Scan the one-time pairing code")],
                ['03', desktopCopy("实时同步会话与审批", "Sync conversations and approvals in real time")]
              ].map(([step, label]) => (
                <div key={step} className="rounded-xl bg-main px-3 py-2.5 ring-1 ring-line/50">
                  <span className="font-mono text-[10.5px] text-ink-muted">{step}</span>
                  <p className="mt-0.5 text-[12px] font-medium text-ink">{label}</p>
                </div>
              ))}
            </div>

            {state?.running && state.hosts.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-main px-3 py-2 ring-1 ring-line/50">
                <span className="mr-1 text-[11px] text-ink-muted">{desktopCopy("局域网地址", "Local network address")}</span>
                {state.hosts.map((ip) => (
                  <span
                    key={ip}
                    className="rounded-md bg-surface px-2 py-0.5 font-mono text-[11px] text-ink ring-1 ring-line/70"
                  >
                    {ip}:{state.port}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 rounded-xl bg-main px-3.5 py-2.5 ring-1 ring-line/50">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-ink">{desktopCopy("同步 Hermes 脱机直连凭据", "Include credentials for direct Hermes access")}</p>
                <p className="truncate text-[11.5px] text-ink-muted">{desktopCopy("电脑休眠时手机仍可直连远程 Hermes Gateway", "Connect directly to a remote Hermes gateway while your computer is asleep.")}</p>
              </div>
              <SwitchPill
                checked={state?.includeDirectCredentials ?? true}
                onCheckedChange={(checked) => void handleToggleDirectCreds(checked)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {state?.running && (
              <>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleRotate()}>
                  <RefreshCw className="size-3.5" />{desktopCopy("轮换二维码", "Refresh QR code")}</Button>
                {state.pairUri && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => copyText(state.pairUri!, 'uri')}
                  >
                    {copiedKey === 'uri' ? <Check className="size-3.5 text-status-online" /> : <Copy className="size-3.5" />}
                    {copiedKey === 'uri' ? desktopCopy("已复制链接", "Link copied") : desktopCopy("复制配对链接", "Copy pairing link")}
                  </Button>
                )}
              </>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void handleExportOfflineBundle()}
            >
              <ArkExportDocSvg className="size-3.5" />{desktopCopy("导出离线同步包 (.botark-sync)", "Export offline sync package (.botark-sync)")}</Button>
          </div>
        </div>
      </div>

      {/* Offline Export Result */}
      {exportedBundle && (
        <div className="rounded-2xl border border-status-online/30 bg-status-online/8 p-4 text-[12.5px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-status-online-ink">{desktopCopy("同步包已生成 · 指纹 ", "Sync package created · Fingerprint: ")}{exportedBundle.fingerprint}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copyText(exportedBundle.transferKey, 'bundle')}
            >
              {copiedKey === 'bundle' ? <Check className="size-3.5 text-status-online" /> : <Copy className="size-3.5" />}
              {copiedKey === 'bundle' ? desktopCopy("已复制密钥", "Key copied") : desktopCopy("复制一次性密钥", "Copy one-time key")}
            </Button>
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-ink-secondary">{exportedBundle.filePath}</p>
        </div>
      )}

      {/* Paired Mobile Devices */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[13.5px] font-semibold text-ink">{desktopCopy("已授权设备 (", "Authorized devices (")}{state?.devices.length ?? 0})
          </h3>
          {(state?.devices.length ?? 0) > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void handleRevoke('*')}>{desktopCopy("全部移除", "Remove all devices")}</Button>
          )}
        </div>

        {!state || state.devices.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line/70 bg-surface/40 px-6 py-7 text-center text-[12.5px] text-ink-muted">{desktopCopy("暂无已配对移动设备", "No paired mobile devices")}</div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-soft">
            <ul className="divide-y divide-line/60">
              {state.devices.map((dev) => (
                <li key={dev.deviceId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        'grid size-8 shrink-0 place-items-center rounded-xl',
                        dev.connected ? 'bg-status-online/15 text-status-online' : 'bg-hover text-ink-muted'
                      )}
                    >
                      <ArkMobileLinkSvg className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-[13.5px] font-medium text-ink">
                        <span className="truncate">{dev.deviceName}</span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                            dev.connected
                              ? 'bg-status-online/15 text-status-online-ink'
                              : 'bg-hover text-ink-muted'
                          )}
                        >
                          {dev.connected ? desktopCopy("在线", "Online") : desktopCopy("离线", "Offline")}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                        {dev.deviceModel || 'Mobile'} · {formatTime(dev.lastSeenAtMs)}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRevoke(dev.deviceId)}
                    title={desktopCopy("移除授权", "Revoke access")}
                  >
                    <Trash2 className="size-3.5 text-status-error" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
