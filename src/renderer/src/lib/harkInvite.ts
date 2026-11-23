// Parse Hark GET /invite (ported from hark-hub-go internal/invite parseKnown).
// Known shape: {show, code, counted, friendsPerReward, friendsToNextReward, rewardsEarned, landedReward:{endsAt}}
export interface HarkInvite {
  code: string
  link: string
  counted: number // -1 unknown
  perReward: number // -1 unknown
  rewardEnds: string // '' when none
}

const CODE_RE = /^[A-Za-z0-9-]{1,32}$/
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : -1)

export function parseHarkInvite(raw: unknown): HarkInvite | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const c = String(r['code'] ?? r['inviteCode'] ?? '').trim()
  const code = CODE_RE.test(c) ? c : ''
  const landed = r['landedReward'] as Record<string, unknown> | null | undefined
  const ends = landed && typeof landed === 'object' ? String(landed['endsAt'] ?? '') : ''
  return {
    code,
    link: code ? `https://hark.com/r/${code}` : '',
    counted: int(r['counted']),
    perReward: int(r['friendsPerReward']),
    rewardEnds: ends
  }
}

/** Progress within the current reward cycle: filled segments out of perReward. */
export function inviteProgress(inv: HarkInvite): { filled: number; total: number } | null {
  if (inv.counted < 0 || inv.perReward <= 0) return null
  const total = inv.perReward
  const rem = inv.counted % total
  // exactly at a multiple (and >0) after a reward landed: show the cycle as full
  const filled = rem === 0 && inv.counted > 0 ? total : rem
  return { filled, total }
}
