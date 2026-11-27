/**
 * GOXF fork (v20): proxy-pool subscriptions on a user-installed Mihomo kernel.
 * Kernel card, the 订阅 import tab and the per-source node pickers of
 * Settings → 代理池. Main never sends subscription URLs or node secrets here.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Activity, Cpu, Download, FileUp, Loader2, RefreshCw } from 'lucide-react'
import type {
  MihomoKernelStatus,
  ProxySubDelay,
  ProxySubListView,
  ProxySubSourceView
} from '@shared/goxfProxySubs'
import { INSECURE_APPROVAL_NEEDED } from '@shared/goxfProxySubs'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { TextInput } from '@/components/ui/Field'
import { SwitchPill } from '@/components/ui/Controls'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'

const subs = () => getBridge()?.goxfProxySubs

export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron prefixes IPC errors with "Error invoking remote method '…': Error: ".
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

/** Latency badge colors (shared with the pool list). */
export function latencyClass(ms: number | undefined): string {
  if (typeof ms !== 'number' || ms < 300) return 'bg-status-online/10 text-status-online-ink'
  if (ms < 800) return 'bg-status-attention/15 text-status-attention-ink'
  return 'bg-status-error/10 text-status-error-ink'
}

export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium', className)}>
      {children}
    </span>
  )
}

export function ProtoTag({ p }: { p: string }) {
  return <span className="shrink-0 rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] uppercase text-ink-secondary">{p}</span>
}

const card = 'rounded-2xl border border-line bg-surface p-4 shadow-soft'

// ---------------------------------------------------------------- kernel

export function useMihomoKernel() {
  const [status, setStatus] = useState<MihomoKernelStatus | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const api = subs()
    if (!api) return
    void api.kernelStatus().then(setStatus, () => undefined)
    // Newest official release, so an installed kernel can offer 「更新到 vX」.
    void api.kernelCheck?.().then(setStatus, () => undefined)
    return api.onKernelEvent((e) => {
      if (e.type === 'progress') setProgress(e.percent)
      else if (e.type === 'done') {
        setStatus(e.status)
        setProgress(null)
      } else setProgress(null)
    })
  }, [])
  const run = useCallback(async (how: 'download' | 'import'): Promise<boolean> => {
    const api = subs()
    if (!api) return false
    setError(undefined)
    if (how === 'download') setProgress(0)
    try {
      const next = how === 'download' ? await api.kernelDownload() : await api.kernelImport()
      if (next) setStatus(next)
      return Boolean(next?.installed)
    } catch (err) {
      setError(errorText(err))
      return false
    } finally {
      setProgress(null)
    }
  }, [])
  return { status, progress, error, install: run }
}

export function MihomoKernelCard({ kernel }: { kernel: ReturnType<typeof useMihomoKernel> }) {
  const { status, progress, error, install } = kernel
  if (!status) return null
  const installed = status.installed
  const busy = progress !== null || status.installing
  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sunken text-ink-secondary">
            <Cpu className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-ink">Mihomo 内核</span>
              {installed ? (
                <Badge className="bg-status-online/10 text-status-online-ink">已安装 v{status.version}</Badge>
              ) : (
                <Badge className="bg-sunken text-ink-muted">未安装</Badge>
              )}
            </div>
            <p className="mt-1 text-[12px] text-ink-secondary">
              {installed
                ? '订阅节点由它在本机跑；只监听 127.0.0.1，带随机密码。'
                : '用订阅里的 SS / VMess / Trojan 等节点需要它。不内置，装在数据目录里，不改系统代理。'}
            </p>
            {installed && status.updateAvailable && (
              <p className="mt-1 text-[12px] text-ink-secondary">官方已发布 v{status.latestVersion}，更新后正在用的节点会自动重启。</p>
            )}
            {!installed && status.asset && (
              <p className="mt-1 font-mono text-[11px] text-ink-muted">
                {status.asset.file} · 约 {Math.round(status.asset.size / 1048576)} MB · 校验 SHA-256
              </p>
            )}
            {!status.asset && <p className="mt-1 text-[12px] text-status-error-ink">Mihomo 没有这个系统的官方构建</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {busy ? (
            <Badge className="bg-sunken text-ink-muted">
              <Loader2 className="size-3 animate-spin" />
              {progress !== null ? `下载中 ${progress}%` : '安装中…'}
            </Badge>
          ) : installed && status.updateAvailable ? (
            <Button size="sm" variant="primary" onClick={() => void install('download')}>
              <Download className="size-3.5" /> 更新到 v{status.latestVersion}
            </Button>
          ) : installed ? (
            <Button size="sm" variant="ghost" disabled={!status.asset} onClick={() => void install('download')}>
              重新安装
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" disabled={!status.asset} onClick={() => void install('import')}>
                <FileUp className="size-3.5" /> 本地导入
              </Button>
              <Button size="sm" variant="primary" disabled={!status.asset} onClick={() => void install('download')}>
                <Download className="size-3.5" /> 下载并安装
              </Button>
            </>
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-[12px] text-status-error-ink">{error}</p>}
      {!installed && (
        <p className="mt-3 text-[11px] text-ink-muted">
          下载走代理池（有可用代理时），否则走系统网络。下不动就去 GitHub 下官方压缩包，点「本地导入」。
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- sources

export function useProxySubs() {
  const [list, setList] = useState<ProxySubListView>({ sources: [], autoRefresh: false })
  const reload = useCallback(async () => {
    const api = subs()
    if (api) setList(await api.list())
  }, [])
  useEffect(() => {
    void reload().catch(() => undefined)
  }, [reload])
  return { list, setList, reload }
}

/** Multi-line pastes arrive in a single-line input as space-separated links. */
const toInput = (value: string): string => {
  const parts = value.trim().split(/\s+/)
  return parts.length > 1 && parts.every((p) => p.includes('://')) ? parts.join('\n') : value.trim()
}

export function SubscriptionImport({
  kernel,
  subsState,
  busy,
  setBusy,
  onError,
  onHint
}: {
  kernel: ReturnType<typeof useMihomoKernel>
  subsState: ReturnType<typeof useProxySubs>
  busy: boolean
  setBusy: (b: boolean) => void
  onError: (msg?: string) => void
  onHint: (msg?: string) => void
}) {
  const [value, setValue] = useState('')
  const [needKernel, setNeedKernel] = useState(false)
  const { list, setList } = subsState

  const doImport = async () => {
    const api = subs()
    if (!api || !value.trim()) return
    if (!kernel.status?.installed) {
      setNeedKernel(true)
      return
    }
    setBusy(true)
    onError(undefined)
    onHint(undefined)
    try {
      const next = await api.importSource(toInput(value))
      setList(next)
      setValue('')
      onHint('订阅已导入，在下面选节点加入代理池')
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const installThenImport = async (how: 'download' | 'import') => {
    setNeedKernel(false)
    if (await kernel.install(how)) await doImport()
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <TextInput
          className="min-w-0 flex-1 font-mono"
          placeholder="粘贴订阅地址或节点链接"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text')
            if (/\r?\n/.test(text.trim())) {
              e.preventDefault()
              setValue(text.trim().split(/\s+/).join(' '))
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doImport()
          }}
        />
        <Button size="sm" variant="primary" disabled={busy || !value.trim()} onClick={() => void doImport()}>
          导入订阅
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-secondary">
        <SwitchPill
          size="sm"
          checked={list.autoRefresh}
          aria-label="每 6 小时自动刷新"
          onCheckedChange={(on) => void subs()?.setAutoRefresh(on).then(setList, (err) => onError(errorText(err)))}
        />
        <span>每 6 小时自动刷新</span>
        <span className="text-ink-muted">· 刷新不会改动已分配给账号的节点</span>
      </div>
      <Dialog
        open={needKernel}
        onOpenChange={setNeedKernel}
        title="先安装 Mihomo 内核"
        description="订阅里的节点由 Mihomo 内核在本机运行。装好后会接着导入这个订阅。"
        showDescription
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setNeedKernel(false)}>
              取消
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void installThenImport('import')}>
              <FileUp className="size-3.5" /> 本地导入
            </Button>
            <Button size="sm" variant="primary" onClick={() => void installThenImport('download')}>
              <Download className="size-3.5" /> 下载并安装
            </Button>
          </>
        }
      >
        {kernel.status?.asset && (
          <p className="font-mono text-[11px] text-ink-muted">
            {kernel.status.asset.file} · 约 {Math.round(kernel.status.asset.size / 1048576)} MB · 校验 SHA-256
          </p>
        )}
      </Dialog>
    </>
  )
}

const ALL = '__all__'

function hhmm(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === today.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

function SourceCard({
  source,
  busy,
  onChanged,
  onAdded,
  onError
}: {
  source: ProxySubSourceView
  busy: boolean
  onChanged: (next: ProxySubListView) => void
  onAdded: (added: number, skipped: number) => Promise<void>
  onError: (msg?: string) => void
}) {
  const firstGroup = source.groups.find((g) => g.usable)?.id ?? ALL
  const [group, setGroup] = useState(firstGroup)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [delays, setDelays] = useState<Record<string, ProxySubDelay | 'testing'>>({})
  const [working, setWorking] = useState(false)
  const [confirm, setConfirm] = useState<null | { nodeIds?: string[]; groupId?: string }>(null)

  const selectedGroup = source.groups.find((g) => g.id === group)
  useEffect(() => {
    if (group !== ALL && !selectedGroup) setGroup(firstGroup)
  }, [group, selectedGroup, firstGroup])
  const inPool = useMemo(() => new Set(source.inPool), [source.inPool])
  const visible = useMemo(() => {
    if (!selectedGroup) return source.nodes
    const ids = new Set(selectedGroup.nodeIds)
    return source.nodes.filter((n) => ids.has(n.id))
  }, [source.nodes, selectedGroup])

  const testGroup = async () => {
    const api = subs()
    if (!api) return
    const ids = visible.filter((n) => n.usable).map((n) => n.id)
    setDelays((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, 'testing' as const])) }))
    let next = 0
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]!
        const res = await api.testDelays(source.id, [id]).catch((err) => ({ [id]: { ok: false, error: errorText(err) } }))
        setDelays((prev) => ({ ...prev, [id]: res[id] ?? { ok: false, error: '不可用' } }))
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  const add = async (req: { nodeIds?: string[]; groupId?: string }, allowInsecure = false) => {
    const api = subs()
    if (!api) return
    const insecure = req.groupId
      ? Boolean(source.groups.find((g) => g.id === req.groupId)?.insecure)
      : source.nodes.some((n) => req.nodeIds?.includes(n.id) && n.insecure)
    if (insecure && !allowInsecure) {
      setConfirm(req)
      return
    }
    setWorking(true)
    onError(undefined)
    try {
      const { added, skipped } = await api.addToPool({ sourceId: source.id, ...req, allowInsecure })
      setPicked(new Set())
      onChanged(await api.list())
      await onAdded(added, skipped)
    } catch (err) {
      const msg = errorText(err)
      if (msg.includes(INSECURE_APPROVAL_NEEDED)) setConfirm(req)
      else onError(msg)
    } finally {
      setWorking(false)
    }
  }

  const run = async (fn: () => Promise<ProxySubListView>) => {
    setWorking(true)
    onError(undefined)
    try {
      onChanged(await fn())
    } catch (err) {
      onError(errorText(err))
    } finally {
      setWorking(false)
    }
  }

  const disabled = busy || working
  const usableGroups = source.groups.length > 0
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-sunken/40 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <span className="truncate font-medium text-ink">{source.name}</span>
          <span className="shrink-0 text-ink-muted">
            {source.kind === 'url' ? '订阅' : '节点链接'} · {source.nodes.length} 个节点
            {usableGroups ? ` · ${source.groups.length} 个分组` : ''} · {hhmm(source.updatedAt)} 更新
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {source.kind === 'url' && (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void run(() => subs()!.refreshSource(source.id))}>
              <RefreshCw className={cn('size-3.5', working && 'animate-spin')} /> 刷新
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void run(() => subs()!.removeSource(source.id))}>
            删除来源
          </Button>
        </div>
      </div>
      {source.lastError && <p className="px-4 pt-2 text-[12px] text-status-error-ink">上次刷新失败：{source.lastError}</p>}
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-ink-secondary">
          {usableGroups && (
            <>
              <span>分组</span>
              <Select
                size="xs"
                variant="pill"
                value={group}
                onValueChange={(v) => setGroup(v)}
                className="w-56"
                options={[
                  ...source.groups.map((g) => ({
                    value: g.id,
                    label: `${g.name}（${g.kind}）${g.usable ? '' : ' · 不可用'}`
                  })),
                  { value: ALL, label: '全部节点' }
                ]}
              />
            </>
          )}
        </div>
        <Button size="sm" variant="secondary" disabled={disabled || !kernelReady(visible)} onClick={() => void testGroup()}>
          <Activity className="size-3.5" /> 测这一组
        </Button>
      </div>
      <ul className="mt-2 max-h-96 divide-y divide-line overflow-y-auto">
        {visible.map((n) => {
          const on = picked.has(n.id)
          const already = inPool.has(n.id)
          const d = delays[n.id]
          return (
            <li key={n.id} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
              <div className="flex min-w-0 items-center gap-2.5">
                <SwitchPill
                  size="sm"
                  checked={on || already}
                  disabled={!n.usable || already || disabled}
                  aria-label={`选择 ${n.name}`}
                  onCheckedChange={() => {
                    const next = new Set(picked)
                    if (on) next.delete(n.id)
                    else next.add(n.id)
                    setPicked(next)
                  }}
                />
                <ProtoTag p={n.protocol} />
                <span className={cn('truncate', n.usable ? 'text-ink' : 'text-ink-muted')}>{n.name}</span>
                {already && <span className="shrink-0 text-[11px] text-ink-muted">已在池中</span>}
                {!n.usable && n.reason && <span className="shrink-0 text-[11px] text-ink-muted">{n.reason}</span>}
                {n.usable && n.insecure && <span className="shrink-0 text-[11px] text-status-attention-ink">跳过证书校验</span>}
              </div>
              {d === 'testing' ? (
                <Badge className="bg-sunken text-ink-muted">
                  <Loader2 className="size-3 animate-spin" /> 检测中…
                </Badge>
              ) : d ? (
                d.ok ? (
                  <Badge className={latencyClass(d.ms)}>{d.ms} ms</Badge>
                ) : (
                  <Badge className="bg-status-error/10 text-status-error-ink" title={d.error}>
                    {d.error === '超时' ? '超时' : '不可用'}
                  </Badge>
                )
              ) : null}
            </li>
          )
        })}
        {visible.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-ink-muted">这个分组里没有节点</li>}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <span className="text-[12px] text-ink-muted">
          已选 {picked.size} 个节点{usableGroups ? ' · 也可以把整组加进去（按组策略自动切换）' : ''}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {usableGroups && (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || !selectedGroup?.usable || inPool.has(selectedGroup.id)}
              title={selectedGroup && !selectedGroup.usable ? selectedGroup.reason : undefined}
              onClick={() => selectedGroup && void add({ groupId: selectedGroup.id })}
            >
              {selectedGroup && inPool.has(selectedGroup.id) ? '整组已在池中' : '整组加入'}
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={disabled || picked.size === 0} onClick={() => void add({ nodeIds: [...picked] })}>
            加入代理池
          </Button>
        </div>
      </div>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="这些节点跳过了证书校验"
        description="订阅把它们标成 skip-cert-verify：连接节点时不校验服务器证书，中间人可能看到或篡改流量。确定要加入代理池吗？"
        showDescription
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const req = confirm
                setConfirm(null)
                if (req) void add(req, true)
              }}
            >
              仍要加入
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </div>
  )
}

const kernelReady = (nodes: ProxySubSourceView['nodes']) => nodes.some((n) => n.usable)

export function ProxySubSources({
  subsState,
  busy,
  onAdded,
  onError
}: {
  subsState: ReturnType<typeof useProxySubs>
  busy: boolean
  onAdded: (added: number, skipped: number) => Promise<void>
  onError: (msg?: string) => void
}) {
  const { list, setList } = subsState
  if (list.sources.length === 0) return null
  return (
    <>
      {list.sources.map((s) => (
        <SourceCard key={s.id} source={s} busy={busy} onChanged={setList} onAdded={onAdded} onError={onError} />
      ))}
    </>
  )
}
