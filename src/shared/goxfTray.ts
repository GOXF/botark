/** GOXF fork: what the window's close button does on Windows/Linux (macOS always hides). */
export type GoxfCloseBehavior = 'tray' | 'quit'

export const GOXF_TRAY_CHANNELS = {
  get: 'goxf:tray:get',
  set: 'goxf:tray:set'
} as const

export interface GoxfTrayBridge {
  get(): Promise<GoxfCloseBehavior>
  set(behavior: GoxfCloseBehavior): Promise<GoxfCloseBehavior>
}

export const normalizeCloseBehavior = (value: unknown): GoxfCloseBehavior => (value === 'quit' ? 'quit' : 'tray')
