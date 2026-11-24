import type { PlatformId } from '@adapters/types'
import type { SecurityVaultStatus } from '@shared/ipc'
import { getBridge } from './bridge'
import { t } from './i18n'

const DOT_MEMORY_VAULT_KEY = 'dot.memory.snapshot.v1'
const LEGACY_LOCALSTORAGE_KEY = 'bothub.dot.memorySnapshot'

let memoryFallbackCache = ''
let dotMemoryQueue = Promise.resolve()

// Reads can migrate plaintext into the vault, so they share the draft's mutation queue.
function queueDotMemoryOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = dotMemoryQueue.then(operation)
  dotMemoryQueue = result.then(() => undefined, () => undefined)
  return result
}

/**
 * Load the Dot cross-account memory migration draft from the main-process
 * `safeStorage` vault, automatically migrating and purging any legacy plaintext
 * `window.localStorage` entry left by older builds.
 */
export function loadDotMemoryDraft(): Promise<string> {
  return queueDotMemoryOperation(async () => {
    let legacyPlain = ''
    try {
      if (typeof window !== 'undefined') {
        legacyPlain = window.localStorage.getItem(LEGACY_LOCALSTORAGE_KEY) || ''
      }
    } catch {
      /* Local storage can be unavailable in browser mode. */
    }

    const vault = getBridge()?.vault
    if (!vault) return legacyPlain || memoryFallbackCache

    try {
      if (legacyPlain) {
        memoryFallbackCache = legacyPlain
        const result = await vault.setSecret(DOT_MEMORY_VAULT_KEY, legacyPlain)
        if (result.ok && result.encrypted) window.localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY)
        return legacyPlain
      }
      const stored = await vault.getSecret(DOT_MEMORY_VAULT_KEY)
      memoryFallbackCache = stored ?? ''
    } catch {
      /* Keep the in-memory draft available while the vault is unavailable. */
    }
    return memoryFallbackCache
  })
}

/**
 * Persist the Dot cross-account memory migration draft into the encrypted
 * main-process `safeStorage` vault (never into plaintext `localStorage`).
 */
export function saveDotMemoryDraft(markdown: string): Promise<boolean> {
  return queueDotMemoryOperation(async () => {
    const draft = markdown.trim() ? markdown : ''
    memoryFallbackCache = draft
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY)
    } catch {
      /* The encrypted vault is independent of browser local storage. */
    }

    const vault = getBridge()?.vault
    if (!vault) return false

    try {
      if (!draft) return (await vault.deleteSecret(DOT_MEMORY_VAULT_KEY)).ok
      const res = await vault.setSecret(DOT_MEMORY_VAULT_KEY, draft)
      return res.ok && res.encrypted
    } catch {
      return false
    }
  })
}

/** Wait for pending draft mutations before clearing all vault secrets and the local draft. */
export function clearVaultCredentials(): Promise<void> {
  return queueDotMemoryOperation(async () => {
    memoryFallbackCache = ''
    const bridge = getBridge()
    const vault = bridge?.vault
    const results = await Promise.allSettled([
      Promise.resolve().then(() => {
        if (typeof window === 'undefined') return
        window.localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY)
        if (window.localStorage.getItem(LEGACY_LOCALSTORAGE_KEY) !== null) {
          throw new Error(t('Could not remove the legacy memory draft'))
        }
      }),
      Promise.resolve().then(async () => {
        if (bridge && (!vault?.clearAll || !(await vault.clearAll()).ok)) {
          throw new Error(t('Could not clear the security vault'))
        }
      })
    ])
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) {
      throw new Error(errors.map((error) => error instanceof Error ? error.message : String(error)).join('\n'))
    }
  })
}

export async function fetchSecurityVaultStatus(
  accountId?: string,
  platformId?: PlatformId
): Promise<SecurityVaultStatus | null> {
  const vault = getBridge()?.vault
  if (!vault?.status) return null
  try {
    return await vault.status({ accountId, platformId })
  } catch {
    return null
  }
}

export async function hardenSecurityVaultPermissions(): Promise<{
  repaired: number
  status: SecurityVaultStatus
} | null> {
  const vault = getBridge()?.vault
  if (!vault?.hardenPermissions) return null
  try {
    return await vault.hardenPermissions()
  } catch {
    return null
  }
}
