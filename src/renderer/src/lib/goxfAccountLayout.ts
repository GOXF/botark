import { useSyncExternalStore } from 'react'

// GOXF: settings account lists as a grid (default, fills wide windows) or the original list.
// Shared across components (upstream split SettingsView into sections, so the header toggle
// and the Hark section's grid read the same value).
export type AccountLayout = 'grid' | 'list'
const KEY = 'goxf.accountLayout'

const listeners = new Set<() => void>()
let current: AccountLayout | undefined

function read(): AccountLayout {
  if (current === undefined) {
    try {
      current = localStorage.getItem(KEY) === 'list' ? 'list' : 'grid'
    } catch {
      current = 'grid'
    }
  }
  return current
}

function write(v: AccountLayout): void {
  current = v
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* ignore */
  }
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useAccountLayout(): [AccountLayout, (v: AccountLayout) => void] {
  const layout = useSyncExternalStore(subscribe, read, read)
  return [layout, write]
}
