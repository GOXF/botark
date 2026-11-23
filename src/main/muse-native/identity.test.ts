import { describe, expect, it } from 'vitest'
import { extractMuseIdentityFields, parseIdentityMarkdown } from './identity'

describe('Muse virtual avatar & identity extraction', () => {
  it('extracts persona name, muse_id, and avatar hashes from identity + peers.status payloads', () => {
    const fields = extractMuseIdentityFields([
      { identity: { agent_name: 'Juno', emoji: '🌙' } },
      { status: { self: { muse_id: 'muse_123', avatar_sha256: 'deadbeef' } } }
    ])
    expect(fields).toEqual({
      displayName: 'Juno',
      emoji: '🌙',
      museId: 'muse_123',
      avatarSha256: 'deadbeef',
      photoSha256: undefined,
      avatarRef: undefined,
      avatarColor: undefined
    })
  })

  it('parses IDENTITY.md fallback fields cleanly', () => {
    const md = `# IDENTITY.md
- **Name:** Kai
- **Emoji:** ⚡
- **Avatar:** avatars/kai.webp
`
    expect(parseIdentityMarkdown(md)).toEqual({
      displayName: 'Kai',
      emoji: '⚡',
      avatarRef: 'avatars/kai.webp'
    })
  })
})
