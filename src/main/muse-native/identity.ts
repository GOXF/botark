import type { MuseIdentityView } from '@shared/ipc'
import { inferMediaMime } from '../mediaMime'
import type { FetchFn } from './controlPlane'
import { fetchFsRawPreview } from './fs'
import type { MuseNativeGateway } from './gateway'
import { unwrapMuseResult } from './index'

const MAX_AVATAR_BYTES = 512 * 1024

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function pickStr(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

export function parseIdentityMarkdown(markdown: string): {
  displayName?: string
  emoji?: string
  avatarRef?: string
} {
  let displayName: string | undefined
  let emoji: string | undefined
  let avatarRef: string | undefined

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    const nameMatch = /^(?:[-*]\s*)?(?:\*\*)?(?:name|名称|名字)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(line)
    if (nameMatch && !displayName) {
      const candidate = nameMatch[1]!.replace(/^\*+|\*+$/g, '').replace(/^`|`$/g, '').trim()
      if (candidate && !/^[_(\[]/.test(candidate) && candidate.length <= 40) {
        displayName = candidate
      }
    }
    const emojiMatch = /^(?:[-*]\s*)?(?:\*\*)?(?:emoji|表情)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(line)
    if (emojiMatch && !emoji) {
      const candidate = emojiMatch[1]!.replace(/^\*+|\*+$/g, '').trim()
      if (candidate && candidate.length <= 8 && !/^[a-z_(]/i.test(candidate)) {
        emoji = candidate
      }
    }
    const avatarMatch = /^(?:[-*]\s*)?(?:\*\*)?(?:avatar|photo|image|头像|虚拟形象)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(line)
    if (avatarMatch && !avatarRef) {
      const candidate = avatarMatch[1]!.replace(/^\*+|\*+$/g, '').replace(/^`|`$/g, '').trim()
      if (
        candidate &&
        (candidate.startsWith('data:image/') ||
          /^https?:\/\//i.test(candidate) ||
          /\.(?:png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(candidate))
      ) {
        avatarRef = candidate
      }
    }
  }

  return { displayName, emoji, avatarRef }
}

export function extractMuseIdentityFields(payloads: unknown[]): {
  displayName?: string
  emoji?: string
  museId?: string
  avatarSha256?: string
  photoSha256?: string
  avatarRef?: string
  avatarColor?: string
} {
  let displayName: string | undefined
  let emoji: string | undefined
  let museId: string | undefined
  let avatarSha256: string | undefined
  let photoSha256: string | undefined
  let avatarRef: string | undefined
  let avatarColor: string | undefined

  const visit = (val: unknown, depth = 0): void => {
    if (depth > 4 || !val) return
    const o = asObj(val)
    if (!o) return

    displayName ??= pickStr(o, [
      'agent_name',
      'agentName',
      'persona_name',
      'personaName',
      'display_name',
      'displayName',
      'name',
      'nickname'
    ])
    emoji ??= pickStr(o, ['emoji', 'icon_emoji', 'iconEmoji'])
    museId ??= pickStr(o, ['muse_id', 'museId', 'self_muse_id', 'selfMuseId'])
    avatarSha256 ??= pickStr(o, ['avatar_sha256', 'avatarSha256'])
    photoSha256 ??= pickStr(o, ['photo_sha256', 'photoSha256'])
    avatarRef ??= pickStr(o, [
      'avatar_data_url',
      'avatarDataUrl',
      'avatar_url',
      'avatarUrl',
      'photo_url',
      'photoUrl',
      'image_url',
      'imageUrl',
      'avatar_path',
      'avatarPath'
    ])
    if (!avatarRef && typeof o['avatar'] === 'string' && o['avatar'].trim()) {
      avatarRef = o['avatar'].trim()
    }
    avatarColor ??= pickStr(o, ['avatar_color', 'avatarColor', 'theme_color', 'themeColor', 'color'])

    for (const nestedKey of ['identity', 'profile', 'agent', 'self', 'status', 'result', 'data', 'avatar']) {
      if (o[nestedKey] && typeof o[nestedKey] === 'object') {
        visit(o[nestedKey], depth + 1)
      }
    }
  }

  for (const p of payloads) visit(p, 0)
  return { displayName, emoji, museId, avatarSha256, photoSha256, avatarRef, avatarColor }
}

function bytesToImageDataUrl(bytes: Uint8Array, headerMime?: string, nameHint?: string): string | undefined {
  if (!bytes.byteLength || bytes.byteLength > MAX_AVATAR_BYTES) return undefined
  const mime = inferMediaMime({ headerMime, nameOrPath: nameHint, bytes })
  if (!mime.startsWith('image/')) return undefined
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

export async function fetchMuseIdentitySnapshot(
  gateway: MuseNativeGateway,
  partitionFetch: FetchFn
): Promise<MuseIdentityView> {
  const [idRaw, onboardRaw, peersRaw, identityMdRaw] = await Promise.all([
    gateway.request('identity', {}).then(unwrapMuseResult).catch(() => null),
    gateway.request('onboarding.identity', {}).then(unwrapMuseResult).catch(() => null),
    gateway.request('peers.status', {}).then(unwrapMuseResult).catch(() => null),
    gateway.request('fs.read', { path: 'IDENTITY.md' }).then(unwrapMuseResult).catch(() => null)
  ])

  const fields = extractMuseIdentityFields([idRaw, onboardRaw, peersRaw])

  if (identityMdRaw) {
    const mdObj = asObj(identityMdRaw)
    const mdText =
      typeof identityMdRaw === 'string'
        ? identityMdRaw
        : typeof mdObj?.['content'] === 'string'
          ? (mdObj['content'] as string)
          : typeof mdObj?.['text'] === 'string'
            ? (mdObj['text'] as string)
            : ''
    if (mdText) {
      const parsedMd = parseIdentityMarkdown(mdText)
      fields.displayName ??= parsedMd.displayName
      fields.emoji ??= parsedMd.emoji
      fields.avatarRef ??= parsedMd.avatarRef
    }
  }

  let avatarDataUrl: string | undefined

  if (fields.avatarRef?.startsWith('data:image/')) {
    avatarDataUrl = fields.avatarRef
  }

  // 1. Try binary `peers.avatar` / `peers.photo` when museId + sha256 exist
  if (!avatarDataUrl && fields.museId && (fields.avatarSha256 || fields.photoSha256)) {
    const candidates: Array<{ method: 'peers.avatar' | 'peers.photo'; sha: string }> = []
    if (fields.avatarSha256) candidates.push({ method: 'peers.avatar', sha: fields.avatarSha256 })
    if (fields.photoSha256) candidates.push({ method: 'peers.photo', sha: fields.photoSha256 })

    for (const c of candidates) {
      try {
        const bin = await gateway.requestBinary(c.method, { muse_id: fields.museId, sha256: c.sha })
        avatarDataUrl = bytesToImageDataUrl(bin.body, bin.contentType, `${c.method}.png`)
        if (avatarDataUrl) break
      } catch {
        /* try next */
      }
    }
  }

  // 2. Try HTTP(S) avatar URL via authenticated partition session
  if (!avatarDataUrl && fields.avatarRef && /^https?:\/\//i.test(fields.avatarRef)) {
    try {
      const res = await partitionFetch(fields.avatarRef, { method: 'GET' })
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer())
        avatarDataUrl = bytesToImageDataUrl(bytes, res.headers.get('content-type') ?? undefined, fields.avatarRef)
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Try workspace avatar file via `fs.raw`
  const workspaceCandidates = [
    ...(fields.avatarRef && !/^https?:\/\//i.test(fields.avatarRef) && !fields.avatarRef.startsWith('data:')
      ? [fields.avatarRef]
      : []),
    'avatar.png',
    'avatar.webp',
    'workspace/avatar.png',
    'workspace/avatar.webp'
  ]
  if (!avatarDataUrl) {
    for (const candidatePath of workspaceCandidates) {
      try {
        const preview = await fetchFsRawPreview(gateway, candidatePath)
        if (preview.mimeType.startsWith('image/') && preview.byteLength <= MAX_AVATAR_BYTES) {
          avatarDataUrl = `data:${preview.mimeType};base64,${preview.dataBase64}`
          break
        }
      } catch {
        /* try next */
      }
    }
  }

  return {
    displayName: fields.displayName,
    emoji: fields.emoji,
    avatarDataUrl,
    avatarColor: fields.avatarColor
  }
}
