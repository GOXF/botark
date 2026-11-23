import type { HarkAuthStatus } from '@shared/ipc'
import type { BotHubBridge } from '@shared/bridge'

export const HARK_IMPORT_INVALID_MESSAGE =
  '未检测到有效 Hark 会话，请检查 Cookie（含 __Secure-hark.session_token）或 Token 是否有效'

type HarkImportBridge = Pick<BotHubBridge['hark'], 'importCredentials'>

/**
 * The single paste-credentials import path for Hark, shared by
 * Settings → 账号管理 and the 新建 Bot dialog.
 *
 * Writes the cookies into the account's `persist:bothub-account-*` partition
 * and verifies them via `/api/auth/get-session`. On success the main process
 * closes any open login window itself and broadcasts `login signedIn`.
 *
 * Deliberately never calls `cancelLogin`: that clears the partition's storage
 * if session probing fails transiently, and is unnecessary once imported.
 */
export async function importHarkCredentialsForAccount(
  bridge: HarkImportBridge | undefined,
  accountId: string,
  rawInput: string
): Promise<HarkAuthStatus & { signedIn: true }> {
  const raw = rawInput.trim()
  if (!bridge?.importCredentials) throw new Error('Hark 导入需要桌面端（Electron）')
  if (!accountId.trim()) throw new Error('缺少账号 ID')
  if (!raw) throw new Error(HARK_IMPORT_INVALID_MESSAGE)
  const st = await bridge.importCredentials({ accountId, rawInput: raw })
  if (!st.signedIn) throw new Error(HARK_IMPORT_INVALID_MESSAGE)
  return st as HarkAuthStatus & { signedIn: true }
}
