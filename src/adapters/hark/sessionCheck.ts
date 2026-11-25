/** Last Hark session check per account (manual 刷新会话 or the main process's 20-minute renewal). */
export type HarkSessionCheck =
  | { result: 'checking'; at: number }
  | { result: 'ok'; at: number; expiresAt?: number }
  | { result: 'expired'; at: number }
  | { result: 'failed'; at: number; message?: string; background?: boolean }

const checks = new Map<string, HarkSessionCheck>()
const listeners = new Set<() => void>()

export function recordHarkSessionCheck(accountId: string, check: HarkSessionCheck): void {
  checks.set(accountId, check)
  for (const fn of listeners) fn()
}

export function getHarkSessionCheck(accountId: string): HarkSessionCheck | undefined {
  return checks.get(accountId)
}

export function subscribeHarkSessionChecks(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const pad = (n: number) => String(n).padStart(2, '0')
const hm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const md = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}月${d.getDate()}日` }

export type HarkSessionLine = { tone: 'muted' | 'ok' | 'error' | 'warn'; text: string }

/** One line under the account status; `now` fades a success to grey after 10 minutes. */
export function harkSessionLine(check: HarkSessionCheck | undefined, now = Date.now()): HarkSessionLine | null {
  if (!check) return null
  switch (check.result) {
    case 'checking':
      return { tone: 'muted', text: '正在验证 Hark 会话…' }
    case 'ok': {
      const until = check.expiresAt ? `会话有效至 ${md(check.expiresAt)} ${hm(check.expiresAt)} · ` : '会话有效 · '
      return { tone: now - check.at < 10 * 60_000 ? 'ok' : 'muted', text: `${until}${hm(check.at)} 刷新` }
    }
    case 'expired':
      return { tone: 'error', text: `会话已失效，请重新登录 · ${hm(check.at)}` }
    case 'failed': {
      const head = check.background ? `后台刷新失败 ${hm(check.at)}` : `刷新失败 ${hm(check.at)}`
      const tail = check.message ? ` · ${check.message}` : ''
      return { tone: 'warn', text: `${head}${tail}${check.background ? '，稍后自动重试' : ''}` }
    }
  }
}
