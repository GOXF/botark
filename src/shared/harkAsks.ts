/** GOXF: Hark's pending user-input requests ("asks": a code, a sign-in, a card, an approval) for the native chat. */
export type HarkAskKind = 'code' | 'credential' | 'confirm'

export interface HarkAskView {
  id: string
  dispatchId?: string
  requestId?: string
  kind: HarkAskKind
  prompt: string
  domain?: string
}

interface RawAsk {
  id: string
  dispatchId?: string
  requestId?: string
  displayHint?: string
  prompt?: string
  domain?: string
  status: string
}

const DONE = /^(answered|resolved|completed|done|cancel+ed|expired|closed|submitted|dismissed|failed)$/i

export function askKind(hint = '', prompt = ''): HarkAskKind {
  const s = `${hint} ${prompt}`
  if (/\b(otp|2fa|mfa|totp|one[-_ ]?time|verification[-_ ]?code|code)\b|验证码|動態碼|两步验证/i.test(s)) return 'code'
  if (/password|passkey|login|sign[-_ ]?in|credential|card|payment|secret|api[-_ ]?key|token|vault|登录|密码|卡号|密钥/i.test(s)) return 'credential'
  return 'confirm'
}

export function pendingHarkAsks(asks: RawAsk[] | undefined): HarkAskView[] {
  return (asks ?? []).filter((a) => !DONE.test(a.status)).map((a) => ({
    id: a.id,
    dispatchId: a.dispatchId,
    requestId: a.requestId,
    kind: askKind(a.displayHint, a.prompt),
    prompt: (a.prompt || a.displayHint || 'Hark 需要你确认').slice(0, 200),
    domain: a.domain
  }))
}
