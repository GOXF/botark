import { useCallback, useEffect, useRef, useState } from 'react'
import { createId } from '@shared/id'
import type { HermesAuthStatus } from '@shared/ipc'
import { CheckCircle2, LogOut, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { getPlatform } from '@adapters/platforms'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { PlatformGlyph } from '@/components/ui/PlatformGlyph'
import { StatusDot } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'

function originFor(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  const url = value.trim()
  try {
    return new URL(url.includes('://') ? url : `http://${url}`).origin
  } catch {
    return undefined
  }
}

export function HermesAccountsSettingsPanel() {
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)

  const hermesAccounts = Object.values(accounts).filter((a) => a.platformId === 'hermes')
  const hermesBots = bots.filter((b) => b.platformId === 'hermes')

  const [metaMap, setMetaMap] = useState<Record<string, HermesAuthStatus>>({})
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('http://127.0.0.1:8642')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [useLocalKey, setUseLocalKey] = useState(false)
  const [localKeyOrigin, setLocalKeyOrigin] = useState<string>()
  const urlRevision = useRef(0)
  const [localVersion, setLocalVersion] = useState<string>()
  const [localReachable, setLocalReachable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const currentOrigin = originFor(baseUrlInput)
  const savedAccount = editingAccountId ? metaMap[editingAccountId] : undefined
  const canReuseSavedKey = Boolean(savedAccount?.hasApiKey && currentOrigin && currentOrigin === originFor(savedAccount.baseUrl))
  const canUseLocalKey = Boolean(currentOrigin && currentOrigin === localKeyOrigin)

  const refreshMeta = useCallback(async () => {
    const hermes = getBridge()?.hermes
    if (!hermes?.listAccounts) return
    try {
      const list = await hermes.listAccounts()
      const next: Record<string, HermesAuthStatus> = {}
      for (const item of list) next[item.accountId] = item
      setMetaMap(next)
    } catch {
      /* ignore */
    }
  }, [])

  const detectLocal = useCallback(async (fillUrl: boolean) => {
    const hermes = getBridge()?.hermes
    if (!hermes?.detectLocal) return
    const revision = urlRevision.current
    setDetecting(true)
    try {
      const info = await hermes.detectLocal()
      setLocalReachable(info.reachable)
      setLocalVersion(info.version)
      setLocalKeyOrigin(info.hasLocalEnvKey ? originFor(info.baseUrl) : undefined)
      if (fillUrl && info.baseUrl && revision === urlRevision.current) {
        setBaseUrlInput(info.baseUrl)
        setUseLocalKey(false)
      }
    } catch {
      /* ignore */
    } finally {
      setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void refreshMeta()
    void detectLocal(true)
  }, [refreshMeta, detectLocal])

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault()
    const hermes = getBridge()?.hermes
    if (!hermes?.configure) {
      setError('需要在 Electron 桌面端中配置 Hermes')
      return
    }
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isEdit = Boolean(editingAccountId)
      const accountId = editingAccountId || createId('acc')
      const displayName = nameInput.trim() || (isEdit ? accounts[accountId]?.displayName || 'Hermes' : 'Hermes')
      const st = await hermes.configure({
        accountId,
        baseUrl: baseUrlInput.trim(),
        apiKey: apiKeyInput.trim() || undefined,
        keepExistingKey: canReuseSavedKey && !apiKeyInput.trim() && !useLocalKey,
        useLocalKey: canUseLocalKey && !apiKeyInput.trim() && useLocalKey,
        model: modelInput.trim() || undefined,
        displayName
      })
      if (!st.signedIn) {
        setError(st.error || '无法连接 Hermes API Server，请检查服务地址和 API_SERVER_KEY')
        return
      }
      if (!isEdit) {
        addBot({
          id: createId('bot'),
          platformId: 'hermes',
          name: displayName,
          accounts: [
            {
              key: accountId,
              accountId,
              displayName: st.displayName || displayName,
              handle: st.handle || st.baseUrl || ''
            }
          ]
        })
        setHint(`已接入 Hermes 实例「${displayName}」（${st.baseUrl}）`)
      } else {
        await connectAccount(accountId)
        setHint(`已更新 Hermes 实例配置（${st.baseUrl}）`)
      }
      setEditingAccountId(null)
      setNameInput('')
      setApiKeyInput('')
      setModelInput('')
      setUseLocalKey(false)
      await refreshMeta()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (accountId: string) => {
    const meta = metaMap[accountId]
    const acc = accounts[accountId]
    urlRevision.current += 1
    setEditingAccountId(accountId)
    setNameInput(acc?.displayName || meta?.displayName || 'Hermes')
    setBaseUrlInput(meta?.baseUrl || 'http://127.0.0.1:8642')
    setApiKeyInput('')
    setModelInput(meta?.model || '')
    setUseLocalKey(false)
    setError(undefined)
    setHint(undefined)
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-ink">Hermes 实例管理</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            接入本机或远程 Hermes Gateway，支持多实例、流式工具与审批
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={detecting} onClick={() => void detectLocal(!editingAccountId)}>
          <RefreshCw className={cn('size-3.5', detecting && 'animate-spin')} />
          检测本机服务
        </Button>
      </div>

      {hint && (
        <div className="flex items-center gap-2 rounded-xl border border-status-online/30 bg-status-online/8 px-3.5 py-2.5 text-[12.5px] text-status-online-ink">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{hint}</span>
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-status-error/30 bg-status-error/8 px-3.5 py-2.5 text-[12.5px] text-status-error">
          {error}
        </div>
      )}

      {/* Add / Edit Hermes Instance Form */}
      <form
        onSubmit={(e) => void handleSave(e)}
        className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-soft"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PlatformGlyph platform={getPlatform('hermes')} size="sm" className="size-4" />
            <h3 className="text-[14px] font-semibold text-ink">
              {editingAccountId ? '编辑 Hermes 连接' : '添加 Hermes 实例'}
            </h3>
          </div>
          {localReachable && (
            <span className="rounded-full bg-status-online/12 px-2.5 py-0.5 text-[11px] font-medium text-status-online-ink">
              本机服务在线{localVersion ? ` · v${localVersion}` : ''}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">实例名称</span>
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="例如：Hermes Local / VPS Agent"
              className="h-9 rounded-lg border border-line bg-main px-3 text-[13px] text-ink outline-none focus:border-accent-600"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">模型别名（可选）</span>
            <input
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              placeholder="hermes-agent"
              spellCheck={false}
              className="h-9 rounded-lg border border-line bg-main px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent-600"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">API Server 地址</span>
            <input
              value={baseUrlInput}
              onChange={(e) => {
                urlRevision.current += 1
                setBaseUrlInput(e.target.value)
                setUseLocalKey(false)
              }}
              placeholder="http://127.0.0.1:8642"
              spellCheck={false}
              required
              className="h-9 rounded-lg border border-line bg-main px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent-600"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">API Key (API_SERVER_KEY)</span>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => {
                setApiKeyInput(e.target.value)
                if (e.target.value.trim()) setUseLocalKey(false)
              }}
              placeholder={
                useLocalKey && canUseLocalKey
                  ? '自动读取 ~/.hermes/.env'
                  : canReuseSavedKey
                  ? '留空保留当前已加密密钥'
                  : '无鉴权服务可留空'
              }
              spellCheck={false}
              className="h-9 rounded-lg border border-line bg-main px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent-600"
            />
          </label>
        </div>

        {canUseLocalKey && !apiKeyInput.trim() && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-main px-3 py-2 ring-1 ring-line/50">
            <span className="text-[12px] text-ink-secondary">
              自动读取本机 <code className="font-mono text-[11px] text-ink">~/.hermes/.env</code> 密钥
            </span>
            <SwitchPill checked={useLocalKey} onCheckedChange={setUseLocalKey} />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="rounded-md bg-main px-2 py-1 font-mono text-[11px] text-ink-muted ring-1 ring-line/50">
            hermes gateway
          </span>
          <div className="flex items-center gap-2">
            {editingAccountId && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingAccountId(null)
                  setNameInput('')
                  setApiKeyInput('')
                  setModelInput('')
                  setUseLocalKey(false)
                }}
              >
                取消编辑
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={busy || !baseUrlInput.trim()}>
              <Plus className="size-3.5" />
              {busy ? '验证连接中…' : editingAccountId ? '保存并重连' : '验证并接入'}
            </Button>
          </div>
        </div>
      </form>

      {/* Connected Hermes Accounts List */}
      {hermesAccounts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-10 text-center text-[13px] text-ink-muted">
          尚未接入任何 Hermes 实例。上方填入本机或远程 Hermes API Server 地址即可一键接入。
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {hermesAccounts.map((acc) => {
              const ownerBot = hermesBots.find(
                (b) => b.activeAccountId === acc.id || b.accountIds.includes(acc.id)
              )
              const meta = metaMap[acc.id]
              return (
                <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <StatusDot status={acc.status} className="size-2.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-semibold text-ink">
                          {ownerBot?.name || acc.displayName}
                        </span>
                        {meta?.model && (
                          <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10.5px] text-ink-secondary">
                            {meta.model}
                          </span>
                        )}
                        {meta?.hasApiKey && (
                          <span className="rounded bg-status-online/10 px-1.5 py-0.5 text-[10.5px] text-status-online-ink">
                            Keychain 已加密
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                        {meta?.baseUrl || acc.handle || acc.id}
                      </p>
                      {acc.status === 'error' && acc.statusDetail && (
                        <p className="mt-0.5 truncate text-[11.5px] text-status-error">{acc.statusDetail}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {ownerBot && (
                      <Button size="sm" variant="secondary" onClick={() => selectBot(ownerBot.id)}>
                        进入对话
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => startEdit(acc.id)} title="编辑配置">
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void connectAccount(acc.id)}
                    >
                      重连
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void signOutAccount(acc.id).then(() => refreshMeta())}
                      title="断开并清除密钥"
                    >
                      <LogOut className="size-3.5" />
                    </Button>
                    {ownerBot && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeBot(ownerBot.id).then(() => refreshMeta())}
                        title="删除"
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
