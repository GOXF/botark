import type { SandTokens } from './grokSandAuth'

export interface GrokMainAuth {
  tokens: SandTokens
  machineId?: string
}

// The credential store lock in grokSandAuth owns both memory and disk updates.
const auths = new Map<string, GrokMainAuth>()

export function getGrokMainAuth(accountId: string): GrokMainAuth | undefined {
  return auths.get(accountId)
}

export function setGrokMainAuth(accountId: string, auth: GrokMainAuth): void {
  auths.set(accountId, auth)
}

export function clearGrokMainAuth(accountId: string): void {
  if (accountId === '*') auths.clear()
  else auths.delete(accountId)
}
