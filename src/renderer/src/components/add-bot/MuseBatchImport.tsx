import { desktopCopy, useDesktopLocale } from '@/lib/desktopCopy'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createId } from '@shared/id'
import {
  parseMuseBatch,
  retryDelayMs,
  shouldAutoRetry,
  type MuseAutoLoginFailure,
  type MuseAutoLoginResult,
  type MuseBatchParseError,
  museImportKey
} from '@shared/museBatch'
import { CheckCircle2, Circle, FileUp, Loader2, ShieldAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { proxyPoolArgsForAccounts, useBotStore } from '@/store/botStore'

type RowState = 'waiting' | 'running' | 'ok' | 'failed' | 'needs-human' | 'cancelled' | 'skipped'
const provisionalAccounts = new Set<string>()

export function keepMuseBatchProxyAssignments(keepIds: readonly string[]): string[] {
  return [...new Set([...keepIds, ...provisionalAccounts])]
}

interface Row {
  id: string
  line: number
  email: string
  inboxUrl: string
  importKey?: string
  botId: string
  accountId: string
  state: RowState
  reason?: MuseAutoLoginFailure | 'unavailable' | 'window-closed'
  attempts: number
}

const REASON: Record<string, string> = {
  'no-email-field': 'Login page did not show the email field',
  'email-rejected': 'Muse did not accept this email',
  'no-code-field': 'Code field not found',
  'inbox-unreachable': 'Inbox page could not be opened',
  'code-timeout': 'No new code arrived in the inbox',
  'code-rejected': 'Code was rejected',
  'needs-human': 'Meta asks for a human check',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
  error: 'Unexpected error',
  'window-closed': 'Login window was closed',
  unavailable: 'Needs the BotArk desktop app'
}

const PARSE_REASON: Record<MuseBatchParseError['reason'], string> = {
  'missing-inbox': 'missing inbox link',
  'bad-email': 'not an email',
  'bad-url': 'inbox link must be https',
  duplicate: 'duplicate email'
}

const PLACEHOLDER = `# 每行一个：邮箱 | 收件箱链接
name@example.com | https://generator.email/name@example.com
other@example.com----https://generator.email/other@example.com`

function freshName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()))
  if (!lower.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

function StateIcon({ state }: { state: RowState }) {
  const cls = 'size-4 shrink-0'
  if (state === 'running') return <Loader2 className={cn(cls, 'animate-spin text-ink-secondary')} aria-hidden />
  if (state === 'ok') return <CheckCircle2 className={cn(cls, 'text-status-online')} aria-hidden />
  if (state === 'failed') return <XCircle className={cn(cls, 'text-status-error')} aria-hidden />
  if (state === 'needs-human') return <ShieldAlert className={cn(cls, 'text-status-attention')} aria-hidden />
  return <Circle className={cn(cls, 'text-ink-muted')} aria-hidden />
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Paste or load `email | inbox_url` lines to sign in separate Muse bots with email codes. */
export function MuseBatchImport({ onDone, onBusyChange }: { onDone: () => void; onBusyChange?: (busy: boolean) => void }) {
  useDesktopLocale()
  const t = useT()
  const addBot = useBotStore((s) => s.addBot)
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [concurrency, setConcurrency] = useState(1)
  const [running, setRunning] = useState(false)
  const [preparationError, setPreparationError] = useState(false)
  const rowsRef = useRef<Row[]>([])
  const runRef = useRef<AbortController | null>(null)
  const draining = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const parsed = useMemo(() => parseMuseBatch(text), [text])
  const muse = getBridge()?.muse

  const patch = (id: string, next: Partial<Row>) => {
    rowsRef.current = rowsRef.current.map((r) => (r.id === id ? { ...r, ...next } : r))
    setRows(rowsRef.current)
  }

  const release = (accountId: string) => {
    if (!accountId) return
    provisionalAccounts.delete(accountId)
    void muse?.cancelLogin(accountId).catch(() => {})
  }

  const adopt = (row: Row, signal: AbortSignal) => {
    if (signal.aborted) return release(row.accountId)
    const local = row.email.split('@')[0] ?? 'Muse'
    const { bots, accounts } = useBotStore.getState()
    if (row.importKey && Object.values(accounts).some((account) =>
      account.platformId === 'meta-muse' && account.importKey === row.importKey
    )) {
      release(row.accountId)
      return patch(row.id, { state: 'skipped', reason: undefined })
    }
    addBot({
      id: row.botId,
      platformId: 'meta-muse',
      name: freshName(`Muse · ${local}`, bots.map((bot) => bot.name)),
      accounts: [{ key: row.accountId, accountId: row.accountId, displayName: local, handle: '', importKey: row.importKey }],
      background: true
    })
    provisionalAccounts.delete(row.accountId)
    patch(row.id, { state: 'ok', reason: undefined })
  }

  // A manual checkpoint finished in the shown window → keep that account as a bot.
  // Closing that window instead makes the row retryable rather than stuck.
  useEffect(() => {
    if (!muse?.onEvent) return
    return muse.onEvent((event) => {
      if (event.type !== 'login') return
      const row = rowsRef.current.find((r) => r.accountId === event.accountId && r.state === 'needs-human')
      const signal = runRef.current?.signal
      if (!row || !signal || signal.aborted) return
      if (event.signedIn) adopt(row, signal)
      else if (event.windowClosed) {
        release(row.accountId)
        patch(row.id, { state: 'failed', reason: 'window-closed' })
      }
    })
  }, [muse])

  const busy = running || rows.some((r) => r.state === 'running' || r.state === 'needs-human')
  useLayoutEffect(() => onBusyChange?.(busy), [busy, onBusyChange])

  // Leaving the dialog drops half-made sessions (never ones already adopted).
  const abortRun = () => {
    runRef.current?.abort()
    for (const row of rowsRef.current) {
      if (row.state === 'running' || row.state === 'needs-human') release(row.accountId)
    }
  }

  useLayoutEffect(
    () => () => {
      abortRun()
      runRef.current = null
      draining.current = false
    },
    []
  )

  /** One clean login attempt with a fresh account id (and so a fresh partition). */
  const attemptOnce = async (row: Row, signal: AbortSignal): Promise<{ res: MuseAutoLoginResult; accountId: string; botId: string }> => {
    const accountId = createId('acc')
    const botId = createId('bot')
    const attempts = (rowsRef.current.find((r) => r.id === row.id)?.attempts ?? row.attempts) + 1
    patch(row.id, { state: 'running', accountId, botId, attempts })
    // Give this account its own pool proxy. Rows still in flight are not in
    // the store yet, so list them too or the pool frees and re-hands out
    // their proxies (two concurrent logins on one IP).
    if (muse?.assignProxyPool) {
      provisionalAccounts.add(accountId)
      const args = proxyPoolArgsForAccounts(useBotStore.getState().accounts, [accountId])
      await muse.assignProxyPool(args.accountIds, keepMuseBatchProxyAssignments(args.keepIds)).catch(() => undefined)
    }
    if (signal.aborted) return { res: { ok: false, reason: 'cancelled' }, accountId, botId }
    try {
      const res = await muse!.autoLogin({ botId, accountId, email: row.email, inboxUrl: row.inboxUrl })
      return { res, accountId, botId }
    } catch {
      return { res: { ok: false, reason: 'error' }, accountId, botId }
    }
  }

  const runOne = async (row: Row, signal: AbortSignal) => {
    if (!muse?.autoLogin) return patch(row.id, { state: 'failed', reason: 'unavailable' })
    for (;;) {
      const { res, accountId, botId } = await attemptOnce(row, signal)
      const current = { ...row, accountId, botId }
      if (signal.aborted) return release(accountId)
      if (res.ok) return adopt(current, signal)
      if (res.reason === 'cancelled') {
        release(accountId)
        return patch(row.id, { state: 'cancelled', reason: 'cancelled' })
      }
      if (res.reason === 'needs-human' && res.canShow) return patch(row.id, { state: 'needs-human', reason: res.reason })
      release(accountId)
      const attempts = rowsRef.current.find((r) => r.id === row.id)?.attempts ?? 1
      const reason = res.reason ?? 'timeout'
      if (!shouldAutoRetry(reason, attempts)) return patch(row.id, { state: 'failed', reason })
      // Transient failure: show why, back off, then try again from scratch.
      patch(row.id, { reason })
      await waitForRetry(retryDelayMs(attempts), signal)
      if (signal.aborted) return
    }
  }

  const drain = async (signal: AbortSignal) => {
    const worker = async () => {
      while (!signal.aborted) {
        const next = rowsRef.current.find((r) => r.state === 'waiting')
        if (!next) return
        await runOne(next, signal)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
  }

  const run = async (prepare?: (signal: AbortSignal) => Promise<void>) => {
    if (draining.current) return
    const previous = runRef.current
    const controller = previous && !previous.signal.aborted ? previous : new AbortController()
    runRef.current = controller
    draining.current = true
    setRunning(true)
    setPreparationError(false)
    try {
      if (prepare) await prepare(controller.signal)
      await drain(controller.signal)
    } catch {
      if (!controller.signal.aborted) {
        cancel()
        setPreparationError(true)
      }
    } finally {
      if (runRef.current === controller) {
        draining.current = false
        setRunning(false)
      }
    }
  }

  const start = () => run(async (signal) => {
    const keys = await Promise.all(parsed.items.map((item) => museImportKey(item.email)))
    if (signal.aborted) return
    const imported = new Set(
      Object.values(useBotStore.getState().accounts)
        .filter((a) => a.platformId === 'meta-muse' && a.importKey)
        .map((a) => a.importKey)
    )
    rowsRef.current = parsed.items.map((item, i) => ({
      id: createId('row'),
      line: item.line,
      email: item.email,
      inboxUrl: item.inboxUrl,
      importKey: keys[i],
      botId: '',
      accountId: '',
      state: imported.has(keys[i]) ? 'skipped' : 'waiting',
      attempts: 0
    }))
    setRows(rowsRef.current)
  })

  const cancel = () => {
    abortRun()
    for (const r of rowsRef.current) {
      if (r.state === 'waiting' || r.state === 'running' || r.state === 'needs-human') {
        patch(r.id, { state: 'cancelled', reason: 'cancelled' })
      }
    }
  }

  const retry = (row?: Row) => {
    if (draining.current && runRef.current?.signal.aborted) return
    for (const r of rowsRef.current) {
      if (row ? r.id === row.id : r.state === 'failed' || r.state === 'cancelled') {
        if (r.state === 'needs-human') release(r.accountId)
        // A manual retry gets a fresh set of automatic attempts.
        patch(r.id, { state: 'waiting', accountId: '', reason: undefined, attempts: 0 })
      }
    }
    if (!draining.current) void run()
  }

  const counts = rows.reduce<Record<RowState, number>>(
    (acc, r) => ({ ...acc, [r.state]: acc[r.state] + 1 }),
    { waiting: 0, running: 0, ok: 0, failed: 0, 'needs-human': 0, cancelled: 0, skipped: 0 }
  )
  const stateLabel: Record<RowState, string> = {
    waiting: t('Waiting'),
    running: t('Signing in…'),
    ok: t('Signed in'),
    failed: t('Failed'),
    'needs-human': t('Needs you'),
    cancelled: t('Cancelled'),
    skipped: t('Already imported, skipped')
  }

  if (rows.length === 0) {
    return (
      <div className="flex animate-veil-in flex-col gap-3">
        <p className="rounded-lg bg-hover px-3 py-2 text-[12px] leading-[17px] text-ink-secondary">
          {t('One account per line: email | inbox link. BotArk signs each one in with the emailed code (read from the inbox page) and makes it its own bot. Inbox links stay on this device and are not saved.')}
        </p>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={desktopCopy(PLACEHOLDER, PLACEHOLDER.replace('# 每行一个：邮箱 | 收件箱链接', '# One per line: email | inbox URL'))}
          aria-label={t('Accounts to import')}
          spellCheck={false}
          rows={8}
          className="block w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-[12px] leading-[18px] text-ink outline-none placeholder:text-ink-muted focus:border-ink/30"
        />
        <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <span className="tabular-nums">{t('{n} ready', { n: String(parsed.items.length) })}</span>
          {parsed.errors.length > 0 && (
            <span className="truncate text-status-error" title={parsed.errors.map((e) => `#${e.line} ${t(PARSE_REASON[e.reason])}`).join('\n')}>
              · {t('{n} lines skipped', { n: String(parsed.errors.length) })}（
              {parsed.errors
                .slice(0, 3)
                .map((e) => `#${e.line} ${t(PARSE_REASON[e.reason])}`)
                .join('，')}
              {parsed.errors.length > 3 ? '…' : ''}）
            </span>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-ink-secondary hover:bg-hover hover:text-ink"
          >
            <FileUp className="size-3.5" aria-hidden />
            {t('Load .txt')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,text/plain"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void file.text().then((body) => setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${body}` : body)))
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
            <span>{t('At a time')}</span>
            <SegmentedControl
              size="xs"
              value={String(concurrency)}
              onValueChange={(v) => setConcurrency(Number(v))}
              options={[
                { value: '1', label: '1' },
                { value: '2', label: '2' }
              ]}
            />
          </div>
          {running ? (
            <Button className="ml-auto" onClick={cancel}>{t('Cancel')}</Button>
          ) : (
            <Button className="ml-auto" variant="primary" disabled={parsed.items.length === 0} onClick={() => void start()}>
              {t('Import {n}', { n: String(parsed.items.length) })}
            </Button>
          )}
        </div>
        {preparationError && <p role="alert" className="text-[12px] text-status-error">{t('Something went wrong.')}</p>}
      </div>
    )
  }

  const finished = !busy && counts.waiting === 0
  return (
    <div className="flex animate-veil-in flex-col gap-3">
      {preparationError && <p role="alert" className="text-[12px] text-status-error">{t('Something went wrong.')}</p>}
      <div className="flex items-center gap-3 text-[12px] text-ink-secondary tabular-nums">
        <span>{t('{done}/{total} done', { done: String(counts.ok), total: String(rows.length) })}</span>
        {counts.failed > 0 && <span className="text-status-error">{t('{n} failed', { n: String(counts.failed) })}</span>}
        {counts['needs-human'] > 0 && (
          <span className="text-status-attention">{t('{n} need you', { n: String(counts['needs-human']) })}</span>
        )}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-hover">
        <div
          className="h-full rounded-full bg-ink/70 transition-[width] duration-300"
          style={{ width: `${Math.round(((rows.length - counts.waiting - counts.running) / rows.length) * 100)}%` }}
        />
      </div>
      <ul className="max-h-[300px] overflow-y-auto rounded-xl border border-line bg-surface" aria-label={t('Import progress')}>
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0">
            <StateIcon state={row.state} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-ink">{row.email}</p>
              <p className={cn('truncate text-[11px]', row.state === 'failed' ? 'text-status-error' : 'text-ink-muted')}>
                {stateLabel[row.state]}
                {row.reason && row.state !== 'cancelled' ? ` · ${t(REASON[row.reason] ?? row.reason)}` : ''}
                {row.attempts > 1 ? ` · ${t('attempt {n}', { n: String(row.attempts) })}` : ''}
              </p>
            </div>
            {row.state === 'needs-human' && (
              <Button size="sm" onClick={() => void muse?.showLogin(row.accountId)}>
                {t('Open window')}
              </Button>
            )}
            {(row.state === 'failed' || row.state === 'cancelled' || row.state === 'needs-human') && (
              <Button size="sm" onClick={() => retry(row)}>
                {t('Retry')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        {running || counts['needs-human'] > 0 ? (
          <Button onClick={cancel}>{t('Cancel')}</Button>
        ) : (
          (counts.failed > 0 || counts.cancelled > 0) && <Button onClick={() => retry()}>{t('Retry failed')}</Button>
        )}
        <Button className="ml-auto" variant="primary" disabled={!finished} onClick={onDone}>
          {t('Done')}
        </Button>
      </div>
    </div>
  )
}
