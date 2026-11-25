import { describe, expect, it } from 'vitest'
import { harkPresentationLinks, normalizeSyncMessage } from './harkClient'

const pres = {
  kind: 'links',
  links: [
    { url: 'https://github.com/GOXF/botark/actions/runs/1', label: 'Actions', name: '昨晚最后一次运行' },
    { url: 'https://github.com/GOXF/botark/releases/tag/v1', label: 'Release', name: 'v1' }
  ]
}

describe('Hark links block', () => {
  it('reads link cards', () => {
    expect(harkPresentationLinks(pres).map((l) => l.name)).toEqual(['昨晚最后一次运行', 'v1'])
  })
  it('shows cards, not files, and drops the bare-URL text', () => {
    const m = normalizeSyncMessage('m1', {
      role: 'assistant',
      content: `${pres.links[0]!.url}\n${pres.links[1]!.url}`,
      presentation: pres
    })
    expect(m.links?.length).toBe(2)
    expect(m.artifacts ?? []).toEqual([])
    expect(m.content).toBe('')
  })
})
