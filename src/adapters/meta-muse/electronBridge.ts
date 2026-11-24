import type { BotHubBridge } from '@shared/bridge'

/** Renderer-only accessor; adapters ship in the web bundle. */
export function getBotHubBridge(): BotHubBridge | undefined {
  return (globalThis as { window?: { electron?: BotHubBridge } }).window?.electron
}
