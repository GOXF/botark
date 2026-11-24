import { parseComputerContext } from './computerContext'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Monitor, Play, RefreshCw, Square } from 'lucide-react'
import { Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { cleanSidebarError, isOnlineAccountStatus } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/**
 * Muse Computer & Remote Browser Tab (`computer.*` + `browser_task.*` + `browser.*`).
 *
 * Connects to Muse's real `computer.context`, `computer.preview`, `browser.debug_access.get`,
 * and `browser_task.*` (get / lease_info / stop / release / refresh_environment).
 */
export function ComputerSection({ accountId }: { accountId: string }) {
  return <AccountComputerSection key={accountId} accountId={accountId} />
}

function AccountComputerSection({ accountId }: { accountId: string }) {
  const connected = useBotStore((s) => isOnlineAccountStatus(s.accounts[accountId]?.status))
  const toggleWebSession = useBotStore((s) => s.toggleWebSession)
  const webSessionOpen = useBotStore((s) => s.webSessionOpen)
  const [loading, setLoading] = useState(false)
  const [contextError, setContextError] = useState<string>()
  const [ctx, setCtx] = useState<ReturnType<typeof parseComputerContext> | null>(null)
  const [manualTaskId, setManualTaskId] = useState('')
  const [debouncedTaskId, setDebouncedTaskId] = useState('')
  const [vmHealth, setVmHealth] = useState('RUNNING')
  const contextRequest = useRef(0)

  const refresh = useCallback(async () => {
    const muse = getBridge()?.muse
    if (!muse?.rpc) return
    const version = ++contextRequest.current
    setLoading(true)
    setContextError(undefined)
    try {
      const [ctxRaw, healthRaw] = await Promise.all([
        muse.rpc({ accountId, method: 'computer.context', params: {} }),
        muse.rpc({ accountId, method: 'vm.health', params: {} }).catch(() => null)
      ])
      if (version !== contextRequest.current) return
      const health = asObj(healthRaw)
      setVmHealth(str(health?.['status'] ?? health?.['state']) || 'RUNNING')
      setCtx(ctxRaw ? parseComputerContext(ctxRaw) : null)
    } catch (error) {
      if (version !== contextRequest.current) return
      setCtx(null)
      setContextError(cleanSidebarError(error))
    } finally {
      if (version === contextRequest.current) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
    else {
      setCtx(null)
      setVmHealth('RUNNING')
    }
    return () => { contextRequest.current++ }
  }, [connected, refresh])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTaskId(manualTaskId.trim()), 300)
    return () => clearTimeout(timer)
  }, [manualTaskId])

  const editing = manualTaskId.trim() !== debouncedTaskId
  const taskId = editing ? '' : debouncedTaskId || ctx?.taskId || ''
  const hash = taskId && taskId === ctx?.taskId ? ctx?.sha256 ?? '' : ''
  return (
    <ComputerTask
      accountId={accountId} taskId={taskId} hash={hash} connected={connected} editing={editing}
      ctx={taskId && taskId === ctx?.taskId ? ctx : null} contextTaskId={ctx?.taskId}
      vmHealth={vmHealth} loading={loading} contextError={contextError} refresh={refresh}
      manualTaskId={manualTaskId} setManualTaskId={setManualTaskId}
      webSessionOpen={webSessionOpen} toggleWebSession={toggleWebSession}
    />
  )
}

function ComputerTask({
  accountId, taskId, hash, connected, editing, ctx, contextTaskId, vmHealth, loading, contextError,
  refresh, manualTaskId, setManualTaskId, webSessionOpen, toggleWebSession
}: {
  accountId: string
  taskId: string
  hash: string
  connected: boolean
  editing: boolean
  ctx: ReturnType<typeof parseComputerContext> | null
  contextTaskId?: string
  vmHealth: string
  loading: boolean
  contextError?: string
  refresh: () => Promise<void>
  manualTaskId: string
  setManualTaskId: (value: string) => void
  webSessionOpen: boolean
  toggleWebSession: () => void
}) {
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null)
  const [taskDetail, setTaskDetail] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()
  const request = useRef(0)

  useLayoutEffect(() => {
    setPreviewDataUrl(null)
    setTaskDetail(null)
    setBusy(false)
    setError(undefined)
    setHint(undefined)
    return () => { request.current++ }
  }, [accountId, taskId, hash, connected])

  useEffect(() => {
    const muse = getBridge()?.muse
    if (!connected || !muse?.rpc || !taskId) return
    const version = ++request.current
    const current = () => request.current === version
    void muse.rpc({ accountId, method: 'browser_task.get', params: { task_id: taskId } }).then((raw) => {
      if (current()) setTaskDetail(asObj(raw))
    }).catch(() => undefined)
    if (hash) {
      void muse.rpc({ accountId, method: 'computer.preview', params: { task_id: taskId, sha256: hash } }).then((raw) => {
        const image = asObj(raw)
        if (current() && typeof image?.['dataBase64'] === 'string' && image['dataBase64']) {
          const mime = typeof image['contentType'] === 'string' ? image['contentType'] : 'image/png'
          setPreviewDataUrl(`data:${mime};base64,${image['dataBase64']}`)
        }
      }).catch(() => undefined)
    }
    return () => { request.current++ }
  }, [accountId, taskId, hash, connected])

  const runTaskOp = async (
    method: 'browser_task.get' | 'browser_task.stop' | 'browser_task.release' | 'browser_task.refresh_environment' | 'browser.lease',
    label: string
  ) => {
    const muse = getBridge()?.muse
    if (!muse?.rpc || !connected || editing || (!taskId && method !== 'browser.lease')) return
    const version = request.current
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const raw = await muse.rpc({ accountId, method, params: taskId ? { task_id: taskId } : {} })
      if (version !== request.current) return
      if (method === 'browser_task.get') setTaskDetail(asObj(raw))
      setHint(label)
      if (method !== 'browser_task.get') {
        setTaskDetail(null)
        await refresh()
        if (version === request.current && taskId) {
          const detail = await muse.rpc({ accountId, method: 'browser_task.get', params: { task_id: taskId } }).catch(() => null)
          if (version === request.current) setTaskDetail(asObj(detail))
        }
      }
    } catch (err) {
      if (version === request.current) setError(cleanSidebarError(err))
    } finally {
      if (version === request.current) setBusy(false)
    }
  }

  return (
    <Section
      title={t('Computer')}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2.5">
        {/* Grok Bot-style Computer Screen Stage */}
        <div className="relative overflow-hidden rounded-xl border border-line bg-ink/[0.04] p-3">
          {previewDataUrl ? (
            <div className="flex flex-col gap-2">
              <img
                src={previewDataUrl}
                alt="Muse computer preview"
                className="max-h-48 w-full rounded-lg border border-line object-contain bg-black"
              />
              {ctx?.url && (
                <p className="truncate font-mono text-[11px] text-ink-secondary" title={ctx.url}>
                  {ctx.url}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-4 text-center">
              <span className="grid size-9 place-items-center rounded-xl bg-surface text-ink-secondary shadow-soft">
                <Monitor className="size-4.5" aria-hidden />
              </span>
              <div>
                <p className="text-[13px] font-medium text-ink">
                  Muse Cloud VM · <span className="font-mono text-[12px] text-status-online-ink">{vmHealth}</span>
                </p>
                {ctx?.status && (
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    {ctx.status}{ctx.title ? ` · ${ctx.title}` : ''}
                  </p>
                )}
              </div>
              <Button size="sm" variant="secondary" onClick={toggleWebSession}>
                {webSessionOpen ? t('Back to conversation') : t('Show web session')}
              </Button>
            </div>
          )}
        </div>

        {(error || contextError) && <p className="text-[12px] text-status-error">{error || contextError}</p>}
        {hint && <p className="text-[12px] text-ink-secondary">{hint}</p>}

        {/* Browser / Computer Task Controls */}
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <TextInput
              value={manualTaskId}
              onChange={(e) => setManualTaskId(e.target.value)}
              placeholder={contextTaskId || 'Task ID (可选)'}
              aria-label="Browser task ID"
              className="h-7 flex-1 font-mono text-[11.5px]"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !connected || editing}
              onClick={() => void runTaskOp('browser.lease', '已请求浏览器租约')}
            >
              <Play className="size-3" /> 租用
            </Button>
          </div>
          {taskId && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !connected || editing}
                onClick={() => void runTaskOp('browser_task.get', '已刷新任务状态')}
              >
                查询状态
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !connected || editing}
                onClick={() =>
                  void runTaskOp('browser_task.refresh_environment', '已刷新浏览器环境')
                }
              >
                <RefreshCw className="size-3" /> 重置环境
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !connected || editing}
                onClick={() => void runTaskOp('browser_task.stop', '已停止浏览器任务')}
              >
                <Square className="size-3" /> 停止
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !connected || editing}
                onClick={() => void runTaskOp('browser_task.release', '已释放浏览器租约')}
              >
                释放
              </Button>
            </div>
          )}
        </div>

        {/* Context / Task JSON snapshot */}
        {(taskDetail || (ctx && Object.keys(ctx.raw).length > 0)) && (
          <pre className="max-h-40 overflow-auto rounded-lg bg-hover/60 p-2 font-mono text-[11px] text-ink-secondary">
            {JSON.stringify(taskDetail ?? ctx?.raw, null, 2)}
          </pre>
        )}
      </div>
    </Section>
  )
}
