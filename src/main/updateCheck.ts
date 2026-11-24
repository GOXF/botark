/** Pure decision for the GitHub "latest release" check (testable without Electron). */

export type LatestReleaseOutcome =
  | { type: 'not-available' }
  | { type: 'available'; version: string; releaseNotes?: string }
  | { type: 'error'; message: string }

export function interpretLatestRelease(
  res: { status: number; ok: boolean },
  data: unknown,
  currentVersion: string,
  isNewer: (remote: string, current: string) => boolean
): LatestReleaseOutcome {
  // 404 on /releases/latest: nothing published yet, so genuinely up to date.
  if (res.status === 404) return { type: 'not-available' }
  if (!res.ok) {
    const why =
      res.status === 403 || res.status === 429 ? '，GitHub 限流了，稍后再试' : res.status >= 500 ? '，GitHub 暂时不可用' : ''
    return { type: 'error', message: `检查更新失败（HTTP ${res.status}${why}）` }
  }
  const malformed: LatestReleaseOutcome = { type: 'error', message: '检查更新失败（无法读取 GitHub 发布信息）' }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return malformed
  const { tag_name, name, body, draft, prerelease } = data as Record<string, unknown>
  if (
    (tag_name !== undefined && typeof tag_name !== 'string') ||
    (name != null && typeof name !== 'string') ||
    (body != null && typeof body !== 'string') ||
    (draft !== undefined && typeof draft !== 'boolean') ||
    (prerelease !== undefined && typeof prerelease !== 'boolean')
  ) return malformed
  const version = tag_name || name
  if (!version) return { type: 'error', message: '检查更新失败（发布信息里没有版本号）' }
  const remote = version.trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i.test(remote)) {
    return malformed
  }
  if (draft || prerelease) return { type: 'not-available' }
  if (isNewer(remote, currentVersion)) {
    return { type: 'available', version: remote, releaseNotes: body ?? undefined }
  }
  return { type: 'not-available' }
}

export function checkFailedMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return /timeout|aborted/i.test(raw) ? '检查更新超时，请检查网络后重试' : `检查更新失败：${raw}`
}
