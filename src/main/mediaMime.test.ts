import { describe, expect, it } from 'vitest'
import { guessMediaMimeFromName, inferMediaMime, sniffMediaMimeFromBytes } from './mediaMime'
import { HarkConversationSyncState, extractMessages } from './hark/harkClient'
import { dotAttachmentsToMedia, normalizeRoomMessage } from './dot/dotClient'
import { extractGrokMedia } from './grok/grokTranscriptDecoder'
import { extractInlineDataUrlImages } from './hermes/hermesClient'

describe('mediaMime sniffing', () => {
  it('recognizes ADTS AAC without mislabeling MPEG audio or M4A', () => {
    const adts = Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0x02, 0x9f, 0xfc)
    const mp3 = Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 0, 0, 0)
    expect(sniffMediaMimeFromBytes(adts)).toBe('audio/aac')
    expect(sniffMediaMimeFromBytes(mp3)).toBe('audio/mpeg')
    expect(guessMediaMimeFromName('track.AAC?download=1')).toBe('audio/aac')
    expect(guessMediaMimeFromName('track.m4a')).toBe('audio/mp4')
  })

  it('sniffs image, video, audio, and pdf magic bytes', () => {
    expect(sniffMediaMimeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffMediaMimeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    // MP4 ftypisom
    expect(
      sniffMediaMimeFromBytes(
        new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      )
    ).toBe('video/mp4')
    // QuickTime ftypqt
    expect(
      sniffMediaMimeFromBytes(
        new Uint8Array([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20])
      )
    ).toBe('video/quicktime')
    // RIFF..WAVE
    expect(
      sniffMediaMimeFromBytes(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
      )
    ).toBe('audio/wav')
    // MP3 ID3
    expect(sniffMediaMimeFromBytes(new Uint8Array([0x49, 0x44, 0x33, 0x03]))).toBe('audio/mpeg')
    // Override generic application/octet-stream using magic bytes or extension
    expect(
      inferMediaMime({
        headerMime: 'application/octet-stream',
        nameOrPath: 'clip.mp4',
        bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      })
    ).toBe('video/mp4')
  })
})

describe('Hark cross-media sync extraction', () => {
  it('captures imageStack, presentation videos, and SSE tool_update artifactKeys', () => {
    const state = new HarkConversationSyncState()
    state.applyFrame(
      JSON.stringify({
        type: 'snapshot',
        shape: 'records',
        data: {
          log: [{ id: 'm1' }],
          messages: {
            m1: {
              role: 'assistant',
              content: '生成好了视频和配图',
              imageStack: [{ s3Key: 'uploads/panda.png', name: 'panda.png' }],
              presentation: {
                kind: 'video',
                video: { downloadUrl: 'https://cdn.hark.com/demo.mp4', name: 'demo.mp4' }
              }
            }
          }
        }
      })
    )
    state.applyFrame(
      JSON.stringify({
        type: 'patches',
        data: [
          {
            op: 'tool_add',
            id: 'm1',
            value: { dispatchId: 'd1', toolName: 'render_video', status: 'running' }
          },
          {
            op: 'tool_update',
            id: 'm1',
            dispatchId: 'd1',
            fields: {
              status: 'completed',
              artifactKeys: [{ path: 'out/final.webm', s3_key: 'artifacts/final.webm' }]
            }
          }
        ]
      })
    )

    const msg = state.messages.get('m1')
    expect(msg?.artifacts?.map((a) => a.name)).toEqual(['panda.png', 'demo.mp4', 'final.webm'])
    expect(msg?.artifacts?.[1]?.mimeType).toBe('video/mp4')
    expect(msg?.artifacts?.[2]?.mimeType).toBe('video/webm')

    // Fallback extractMessages preserves media too
    const fallback = extractMessages({
      messages: [
        {
          id: 'm2',
          role: 'assistant',
          content: 'done',
          videos: [{ url: 'https://cdn.hark.com/clip.mp4', name: 'clip.mp4' }]
        }
      ]
    })
    expect(fallback[0]?.artifacts?.[0]?.downloadUrl).toBe('https://cdn.hark.com/clip.mp4')
    expect(fallback[0]?.artifacts?.[0]?.mimeType).toBe('video/mp4')
  })
})

describe('Dot / Grok / Hermes video & image extraction', () => {
  it('extracts Dot room video & image attachments with inferred MIME', () => {
    const roomMsg = normalizeRoomMessage({
      id: 'dm1',
      role: 'assistant',
      content: {
        text: '视频和图已生成',
        attachments: [
          {
            attachment_id: 'a1',
            type: 'file',
            file_id: 'file_vid_1',
            file: { id: 'file_vid_1', name: 'showcase.mp4' }
          }
        ],
        images: [{ url: 'https://cdn.example.com/poster.webp', name: 'poster.webp' }]
      }
    })
    const media = dotAttachmentsToMedia(roomMsg.attachments)
    expect(media).toHaveLength(2)
    expect(media?.[0]).toMatchObject({ kind: 'file', path: 'dotfile://file_vid_1', mimeType: 'video/mp4' })
    expect(media?.[1]).toMatchObject({ kind: 'image', path: 'https://cdn.example.com/poster.webp', mimeType: 'image/webp' })
  })

  it('extracts Grok videos and images deduplicated', () => {
    const media = extractGrokMedia({
      message: {
        videos: [{ video_url: 'https://x.ai/v/demo.mp4', name: 'demo.mp4' }],
        images: ['https://x.ai/i/cover.png'],
        attachments: [{ url: 'https://x.ai/i/cover.png', name: 'cover.png' }]
      }
    })
    expect(media).toHaveLength(2)
    expect(media?.[0]).toMatchObject({ kind: 'image', path: 'https://x.ai/i/cover.png', mimeType: 'image/png' })
    expect(media?.[1]).toMatchObject({ kind: 'file', path: 'https://x.ai/v/demo.mp4', mimeType: 'video/mp4' })
  })

  it('extracts Hermes data:video and HTML <video>/<audio> tags', () => {
    const res = extractInlineDataUrlImages(
      '看下视频：\n![clip](data:video/mp4;base64,AAAA)\n<audio src="https://cdn.example.com/voice.mp3"></audio>'
    )
    expect(res.text).toBe('看下视频：')
    expect(res.media).toHaveLength(2)
    expect(res.media[0]).toMatchObject({ kind: 'file', mimeType: 'video/mp4', name: 'clip' })
    expect(res.media[1]).toMatchObject({ kind: 'file', mimeType: 'audio/mpeg', path: 'https://cdn.example.com/voice.mp3' })
  })
})
