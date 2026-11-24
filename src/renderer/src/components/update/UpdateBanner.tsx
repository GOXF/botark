import { useEffect, useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import type { UpdateStatusEvent } from '@shared/ipc'
import { Button } from '@/components/ui/Button'
import { getBridge } from '@/lib/bridge'
import { t } from '@/lib/i18n'
import { Notice } from './Notice'

type BannerState =
  | { kind: 'hidden' }
  | { kind: 'available'; version: string; manualInstall?: boolean }
  | { kind: 'downloading'; version?: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'message'; text: string; error?: boolean }

export function UpdateBanner() {
  const [state, setState] = useState<BannerState>({ kind: 'hidden' })
  const [, setChecking] = useState(false)

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge?.updates) return

    return bridge.updates.onEvent((event: UpdateStatusEvent) => {
      switch (event.type) {
        case 'checking':
          setChecking(true)
          break
        case 'available':
          setChecking(false)
          setState({
            kind: 'available',
            version: event.version,
            manualInstall: event.manualInstall
          })
          break
        case 'downloading':
          setChecking(false)
          setState({ kind: 'downloading', percent: event.percent })
          break
        case 'downloaded':
          setChecking(false)
          setState({ kind: 'ready', version: event.version })
          break
        case 'not-available':
          setChecking(false)
          setState({ kind: 'message', text: `当前已是最新版本 (v${event.version})` })
          break
        case 'error':
          setChecking(false)
          if (event.message === 'dev-skip') break
          if (event.message.startsWith('found:')) {
            const v = event.message.slice(6)
            setState({ kind: 'message', text: v ? `发现新版本 ${v.replace(/^0\.\d+\.\d+-goxf\.dev\./, '测试版 ')}，见右下角更新卡` : '发现新版本，见右下角更新卡' })
            break
          }
          setState({ kind: 'message', text: event.message, error: true })
          break
      }
    })
  }, [])

  // Auto-hide transient messages.
  useEffect(() => {
    if (state.kind !== 'message') return
    const t = window.setTimeout(() => setState({ kind: 'hidden' }), 4500)
    return () => window.clearTimeout(t)
  }, [state])

  // Keep the last state on screen while the toast fades out.
  const [shown, setShown] = useState<BannerState>(state)
  const leaving = state.kind === 'hidden' && shown.kind !== 'hidden'
  useEffect(() => {
    if (state.kind !== 'hidden') {
      setShown(state)
      return
    }
    const t = window.setTimeout(() => setShown({ kind: 'hidden' }), 160)
    return () => window.clearTimeout(t)
  }, [state])

  const view = state.kind === 'hidden' ? shown : state
  if (view.kind === 'hidden') return null

  // GOXF: same card as the portable notices; rendered inside GoxfUpdateBanner's bottom-right stack.
  const dismiss = (): void => setState({ kind: 'hidden' })
  if (view.kind === 'available' && view.manualInstall)
    return (
      <Notice
        leaving={leaving}
        icon={<Download className="size-4" aria-hidden />}
        title={`新版本 ${view.version} 已发布`}
        desc="请手动下载安装"
        action={
          <Button size="sm" variant="primary" onClick={() => void getBridge()?.updates.install()}>
            下载
          </Button>
        }
        onDismiss={dismiss}
      />
    )
  if (view.kind === 'available')
    return (
      <Notice
        leaving={leaving}
        icon={<Download className="size-4" aria-hidden />}
        title={`Update ${view.version} available`}
        desc="Downloading…"
      />
    )
  if (view.kind === 'downloading')
    return (
      <Notice
        leaving={leaving}
        icon={<RefreshCw className="size-4 animate-spin" aria-hidden />}
        title={`Downloading update… ${Math.round(view.percent)}%`}
      />
    )
  if (view.kind === 'ready')
    return (
      <Notice
        leaving={leaving}
        icon={<Download className="size-4" aria-hidden />}
        title={`Version ${view.version} ready`}
        desc="Restart to update"
        action={
          <Button size="sm" variant="primary" onClick={() => void getBridge()?.updates.install()}>
            {t('Restart')}
          </Button>
        }
      />
    )
  return (
    <Notice
      leaving={leaving}
      icon={view.error ? <X className="size-4" aria-hidden /> : undefined}
      error={view.error}
      title={view.error ? '更新失败' : view.text}
      desc={view.error ? view.text : undefined}
      onDismiss={dismiss}
    />
  )
}

export function useCheckForUpdates(): { check: () => void; checking: boolean } {
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge?.updates) return
    return bridge.updates.onEvent((event) => {
      if (event.type === 'checking') setChecking(true)
      else setChecking(false)
    })
  }, [])

  return {
    checking,
    check: () => {
      setChecking(true)
      void getBridge()?.updates.check()
    }
  }
}
