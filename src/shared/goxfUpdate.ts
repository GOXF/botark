/**
 * GOXF fork only: IPC contract for the two fork-specific update prompts.
 *   - upstream: qybaihe/botark published a newer release → merge it into the fork
 *   - portable: GOXF/botark published a newer v*-goxf.* build → self-replace the portable exe
 * Kept in its own file so merging upstream touches as little shared code as possible.
 */

export const GOXF_UPDATE_CHANNELS = {
  event: 'goxf:update:event',
  openUpstream: 'goxf:update:open-upstream',
  installPortable: 'goxf:update:install-portable',
  state: 'goxf:update:state',
  setChannel: 'goxf:update:set-channel'
} as const

/** stable = v*-goxf.N releases; test = also dev prereleases from every push to goxf/portable. */
export type GoxfUpdateChannel = 'stable' | 'test'

export interface GoxfUpstreamPrompt {
  /** Upstream version, without leading v, e.g. "0.13.0". */
  version: string
  url: string
}

export interface GoxfPortablePrompt {
  /** Full fork version, e.g. "0.12.0-goxf.2". */
  version: string
  url: string
  /** True when running as a portable exe on Windows and the release has a portable asset. */
  canSelfUpdate: boolean
}

export type GoxfUpdateEvent =
  | { type: 'upstream-available'; prompt: GoxfUpstreamPrompt }
  | { type: 'portable-available'; prompt: GoxfPortablePrompt }
  | { type: 'portable-downloading'; percent: number }
  | { type: 'portable-extracting'; version: string }
  | { type: 'portable-restarting'; version: string }
  | { type: 'portable-error'; message: string }

export interface GoxfUpdateState {
  currentVersion: string
  upstreamBaseVersion: string
  portable: boolean
  channel: GoxfUpdateChannel
  upstream: GoxfUpstreamPrompt | null
  portableUpdate: GoxfPortablePrompt | null
}

export interface GoxfUpdateBridge {
  openUpstream(): Promise<{ ok: true }>
  installPortable(): Promise<{ ok: true }>
  state(): Promise<GoxfUpdateState>
  setChannel(channel: GoxfUpdateChannel): Promise<GoxfUpdateState>
  onEvent(listener: (event: GoxfUpdateEvent) => void): () => void
}
