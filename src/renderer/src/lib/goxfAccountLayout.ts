import { useState } from 'react'

// GOXF: settings account lists as a grid (default, fills wide windows) or the original list.
export type AccountLayout = 'grid' | 'list'
const KEY = 'goxf.accountLayout'

export function useAccountLayout(): [AccountLayout, (v: AccountLayout) => void] {
  const [layout, setLayout] = useState<AccountLayout>(() => (localStorage.getItem(KEY) === 'list' ? 'list' : 'grid'))
  return [
    layout,
    (v) => {
      localStorage.setItem(KEY, v)
      setLayout(v)
    }
  ]
}
