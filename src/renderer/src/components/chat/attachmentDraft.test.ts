import { describe, expect, it, vi } from 'vitest'
import { createAttachmentDraft } from './attachmentDraft'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { createInlineLinkScanner, MarkdownText } from './MarkdownText'

describe('attachment drafts', () => {
  it('blocks sending immediately and preserves selection order across overlapping reads', async () => {
    const draft = createAttachmentDraft(() => undefined)
    const slow = new File(['a'], 'first.png')
    let finish!: (data: ArrayBuffer) => void
    vi.spyOn(slow, 'arrayBuffer').mockReturnValue(new Promise((resolve) => { finish = resolve }))

    const first = draft.add([slow])
    expect(draft.forSend()).toBeNull()
    await draft.add([new File(['b'], 'second.txt')])
    expect(draft.forSend()).toBeNull()
    finish(new Uint8Array([97]).buffer)
    await first

    expect(draft.forSend()).toMatchObject([
      { name: 'first.png', mimeType: 'image/png', dataBase64: 'YQ==' },
      { name: 'second.txt', dataBase64: 'Yg==' }
    ])
  })

  it('keeps files that read successfully and requires failed files to be removed before sending', async () => {
    const changed = vi.fn()
    const draft = createAttachmentDraft(changed)
    const failed = new File(['a'], 'failed.txt')
    vi.spyOn(failed, 'arrayBuffer').mockRejectedValue(new Error('unreadable'))
    const big = new File(['not really this large'], 'large.png')
    vi.spyOn(big, 'size', 'get').mockReturnValue(21 * 1024 * 1024)
    const empty = new File([], 'empty.txt')

    await draft.add([failed, big, empty, new File(['ok'], 'good.txt')])

    const entries = changed.mock.lastCall![0]
    expect(entries.map((entry: { status: string }) => entry.status)).toEqual([
      'read-failed', 'too-large', 'empty', 'ready'
    ])
    expect(draft.forSend()).toBeNull()
    for (const entry of entries.slice(0, 3)) draft.remove(entry.file.id)
    expect(draft.forSend()).toMatchObject([{ name: 'good.txt', dataBase64: 'b2s=' }])
  })

  it('does not restore a removed or cleared file when its read completes', async () => {
    const changed = vi.fn()
    const draft = createAttachmentDraft(changed)
    const slow = new File(['a'], 'old.txt')
    let finish!: (data: ArrayBuffer) => void
    vi.spyOn(slow, 'arrayBuffer').mockReturnValue(new Promise((resolve) => { finish = resolve }))

    const first = draft.add([slow])
    draft.remove(changed.mock.lastCall![0][0].file.id)
    expect(draft.forSend()).toEqual([])
    draft.clear()
    await draft.add([new File(['b'], 'new.txt')])
    finish(new Uint8Array([97]).buffer)
    await first

    expect(draft.forSend()).toMatchObject([{ name: 'new.txt' }])
  })

  it('uses a browser data URL read and keeps the base64 payload only', async () => {
    let finish!: () => void
    const file = new File(['audio'], 'sample.wav')
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer')
    class Reader {
      result: string | null = null
      onload?: () => void
      readAsDataURL() {
        finish = () => {
          this.result = 'data:audio/wav;base64,YXVkaW8='
          this.onload?.()
        }
      }
    }
    vi.stubGlobal('FileReader', Reader)
    try {
      const draft = createAttachmentDraft(() => undefined)
      const reading = draft.add([file])
      expect(draft.forSend()).toBeNull()
      finish()
      await reading
      expect(arrayBuffer).not.toHaveBeenCalled()
      expect(draft.forSend()).toMatchObject([{ name: 'sample.wav', mimeType: 'audio/wav', dataBase64: 'YXVkaW8=' }])
    } finally {
      vi.unstubAllGlobals()
      arrayBuffer.mockRestore()
    }
  })

  it('joins multiple encoding chunks without adding padding in the middle', async () => {
    const bytes = Uint8Array.from({ length: 51_200 }, (_, i) => i % 256)
    const draft = createAttachmentDraft(() => undefined)
    await draft.add([new File([bytes], 'chunked.dat')])
    expect(draft.forSend()?.[0]?.dataBase64).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('Markdown inline parsing', () => {
  it('scans 64,000 unmatched opening brackets in under 5 ms', () => {
    const unmatched = '['.repeat(64_000)
    const markdown = (text: string) => renderToStaticMarkup(createElement(MarkdownText, { text }))
    markdown('**bold** [link](https://example.test)')
    const start = performance.now()
    const link = createInlineLinkScanner(unmatched)(0)
    const markup = markdown(unmatched)
    const elapsed = performance.now() - start
    expect(link).toBeNull()
    expect(elapsed).toBeLessThan(5)
    expect(markup).toContain(unmatched)
  })

  it('preserves link and image rendering alongside code, emphasis, tables, lists and quotes', () => {
    const text = [
      '`[literal](https://literal.test)` and **[link](https://example.test)** and *italic* ~~strike~~',
      '`[` [outside](https://outside.test)',
      '',
      '![image](https://example.test/a.png) ![](https://example.test/b.png) []() [unfinished',
      'drop [[hatch_widget:hidden]] keep [[hatch_widget:unfinished',
      '',
      '| Heading |',
      '| --- |',
      '| table value |',
      '',
      '> quoted',
      '',
      '- listed',
      '',
      '```ts',
      'const val = 1',
      '```'
    ].join('\n')
    const markup = renderToStaticMarkup(createElement(MarkdownText, { text }))
    expect(markup).toContain('[literal](https://literal.test)')
    expect(markup).not.toContain('href="https://literal.test"')
    expect(markup).toContain('href="https://example.test"')
    expect(markup).toContain('href="https://outside.test"')
    expect(markup).toContain('>outside</a>')
    expect(markup).toContain('<strong')
    expect(markup).toContain('<em')
    expect(markup).toContain('<del')
    expect(markup).toContain('alt="image"')
    expect(markup).toContain('alt=""')
    expect(markup).toContain('[]() [unfinished')
    expect(markup).toContain('drop  keep [[hatch_widget:unfinished')
    expect(markup).toContain('<table')
    expect(markup).toContain('<blockquote')
    expect(markup).toContain('<ul')
    expect(markup).toContain('<code>const val = 1</code>')
  })
})
