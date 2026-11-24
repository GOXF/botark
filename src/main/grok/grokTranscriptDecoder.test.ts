import { describe, expect, it } from 'vitest'
import {
  decodeTranscriptBody,
  parseGrokMessagingCard,
  parseGrokTranscriptEntry
} from './grokTranscriptDecoder'

function b64Json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
}

describe('grokTranscriptDecoder', () => {
  it('retains envelope nonce, streaming state and entry revision when decoding base64', () => {
    const raw = {
      entry_id: 'echo', seq: '5', updatedSeq: '7', revision: 3, is_streaming: false,
      client_nonce: 'wire-nonce', requestId: 'turn-id',
      body: b64Json({ id: 'inner-id', kind: 'message', text: '你好', clientNonce: 'old-nonce', isStreaming: true })
    }
    expect(decodeTranscriptBody(raw)).toMatchObject({ client_nonce: 'wire-nonce', is_streaming: false, text: '你好' })
    expect(parseGrokTranscriptEntry(raw, 'agent')).toMatchObject({
      entryId: 'echo', updatedSeq: '7', revision: '3', isStreaming: false,
      clientNonce: 'wire-nonce', requestId: 'turn-id', role: 'user', text: '你好'
    })
  })

  it('ignores choice cards with omitted options', () => {
    expect(parseGrokMessagingCard({ card_id: 'choice', kind: 'GROK_BOT_MESSAGING_CARD_KIND_CHOICE' }, 'agent')).toEqual({})
  })

  it('decodes send-message text with widget option values and entryId preservation', () => {
    const decoded = parseGrokTranscriptEntry(
      {
        seq: '42',
        entry_kind: 'send-message',
        entry_id: 'tbs9',
        body: b64Json({
          kind: 'send-message',
          id: 'tbs9',
          timestampMs: 1_762_000_001_000,
          message: {
            type: 'text',
            content: '请选择你要部署的环境：',
            widget: {
              id: 'w_env',
              options: [
                { label: '生产环境 (Prod)', value: 'env_prod' },
                { label: '预发环境 (Staging)', value: 'env_staging' }
              ]
            }
          }
        })
      },
      'agent-1'
    )

    expect(decoded).not.toBeNull()
    expect(decoded!.role).toBe('assistant')
    expect(decoded!.entryId).toBe('tbs9')
    expect(decoded!.text).toBe('请选择你要部署的环境：')
    expect(decoded!.widgets).toHaveLength(1)
    expect(decoded!.widgets![0]!.options).toEqual(['生产环境 (Prod)', '预发环境 (Staging)'])
    expect(decoded!.widgets![0]!.optionValues).toEqual(['env_prod', 'env_staging'])
    expect(decoded!.widgets![0]!.entryId).toBe('tbs9')
  })

  it('decodes auto-review-approval and local-tool-permission entries into actionable approvals', () => {
    const autoReview = parseGrokTranscriptEntry(
      {
        seq: '50',
        entry_kind: 'send-message',
        entry_id: 'tbs_ar',
        body: b64Json({
          kind: 'send-message',
          id: 'tbs_ar',
          message: {
            type: 'auto-review-approval',
            approval: {
              requestId: 'ar_req_7',
              surface: 'slack',
              title: 'Send Slack message to #eng',
              command: 'Deploying v2.4 now',
              status: 'pending'
            }
          }
        })
      },
      'agent-1'
    )

    expect(autoReview?.approval).toBeDefined()
    expect(autoReview!.approval!.kind).toBe('auto-review')
    expect(autoReview!.approval!.requestId).toBe('ar_req_7')
    expect(autoReview!.approval!.decisionOptions).toEqual(['allow_once', 'allow_always', 'deny'])

    const localPerm = parseGrokTranscriptEntry(
      {
        seq: '51',
        entry_kind: 'send-message',
        entry_id: 'tbs_ltp',
        body: b64Json({
          kind: 'send-message',
          id: 'tbs_ltp',
          message: {
            type: 'local-tool-permission',
            ask: {
              requestId: 'ltp_99',
              toolName: 'bash',
              command: 'ls -la ~/Projects',
              status: 'pending'
            }
          }
        })
      },
      'agent-1'
    )

    expect(localPerm?.approval).toBeDefined()
    expect(localPerm!.approval!.kind).toBe('local-tool')
    expect(localPerm!.approval!.entryId).toBe('tbs_ltp')
    expect(localPerm!.approval!.requestId).toBe('ltp_99')
  })

  it('ignores already expired local-tool-permission entries', () => {
    const expired = parseGrokTranscriptEntry(
      {
        seq: '52',
        entry_kind: 'send-message',
        entry_id: 'tbs_exp',
        body: b64Json({
          kind: 'send-message',
          message: {
            type: 'local-tool-permission',
            ask: {
              requestId: 'ltp_old',
              status: 'expired'
            }
          }
        })
      },
      'agent-1'
    )
    expect(expired?.approval).toBeUndefined()
  })

  it('extracts attachment media parts from send-message attachment entries', () => {
    const att = parseGrokTranscriptEntry(
      {
        seq: '60',
        entry_kind: 'send-message',
        entry_id: 'tbs_img',
        body: b64Json({
          kind: 'send-message',
          message: {
            type: 'attachment',
            path: '/home/box/charts/revenue.png',
            name: 'revenue.png',
            mimeType: 'image/png'
          }
        })
      },
      'agent-1'
    )

    expect(att?.media).toEqual([
      {
        kind: 'image',
        path: '/home/box/charts/revenue.png',
        name: 'revenue.png',
        mimeType: 'image/png'
      }
    ])
  })

  it('decodes 0.79.3 GrokBotMessagingCard payloads into pending approval cards', () => {
    const parsed = parseGrokMessagingCard(
      {
        card_id: 'card_abc',
        version: 3,
        kind: 'GROK_BOT_MESSAGING_CARD_KIND_APPROVAL',
        subkind: 'GROK_BOT_MESSAGING_CARD_SUBKIND_CREDENTIAL_REQUEST',
        state: 'GROK_BOT_MESSAGING_CARD_STATE_OPEN',
        title: 'Authorize GitHub Connector',
        subtitle: 'Read repository issues'
      },
      'agent-1',
      ''
    )

    expect(parsed.approval).toBeDefined()
    expect(parsed.approval!.kind).toBe('messaging-card')
    expect(parsed.approval!.requestId).toBe('card_abc')
    expect(parsed.approval!.cardVersion).toBe(3)
  })

  it('preserves body_omitted metadata when decoding bodyless envelopes', () => {
    const out = decodeTranscriptBody({ seq: '70', body_omitted: true })
    expect(out['body_omitted']).toBe(true)
    const entry = parseGrokTranscriptEntry(
      { seq: '70', entry_id: 'tbs_big', entry_kind: 'send-message', body_omitted: true },
      'agent-1'
    )
    expect(entry?.bodyOmitted).toBe(true)
  })

  it('decodes user-form, secret-request, and FORM MessagingCard into interactive grok_form richWidgets', () => {
    const userForm = parseGrokTranscriptEntry(
      {
        seq: '71',
        entry_kind: 'send-message',
        entry_id: 'tbs_form1',
        body: b64Json({
          kind: 'send-message',
          id: 'tbs_form1',
          message: {
            type: 'user-form',
            form: {
              title: 'Configure Deployment',
              subtitle: 'Fill in target environment details',
              fields: [
                { id: 'region', label: 'Region', required: true, options: ['us-east-1', 'eu-west-1'] },
                { id: 'api_token', label: 'API Token', type: 'password', secret: true }
              ]
            }
          }
        })
      },
      'agent-1'
    )
    expect(userForm?.richWidgets).toHaveLength(1)
    const rwForm = userForm!.richWidgets![0]!
    expect(rwForm.kind).toBe('grok_form')
    if (rwForm.kind === 'grok_form') {
      expect(rwForm.formKind).toBe('user-form')
      expect(rwForm.entryId).toBe('tbs_form1')
      expect(rwForm.fields).toHaveLength(2)
      expect(rwForm.fields[0]!.options).toEqual([
        { id: 'us-east-1', label: 'us-east-1' },
        { id: 'eu-west-1', label: 'eu-west-1' }
      ])
      expect(rwForm.fields[1]!.secret).toBe(true)
    }

    const secretReq = parseGrokTranscriptEntry(
      {
        seq: '72',
        entry_kind: 'send-message',
        entry_id: 'tbs_sec1',
        body: b64Json({
          kind: 'send-message',
          id: 'tbs_sec1',
          message: {
            type: 'secret-request',
            secretRequest: {
              name: 'OPENAI_API_KEY',
              description: 'Required to run synthesis job'
            }
          }
        })
      },
      'agent-1'
    )
    const rwSec = secretReq?.richWidgets?.[0]
    expect(rwSec?.kind).toBe('grok_form')
    if (rwSec?.kind === 'grok_form') {
      expect(rwSec.formKind).toBe('secret-request')
      expect(rwSec.fields[0]!.id).toBe('OPENAI_API_KEY')
      expect(rwSec.fields[0]!.secret).toBe(true)
    }

    const formCard = parseGrokMessagingCard(
      {
        card_id: 'card_form_9',
        version: 2,
        kind: 'GROK_BOT_MESSAGING_CARD_KIND_FORM',
        state: 'PENDING',
        title: 'Enter Database Credentials',
        fields: [{ id: 'db_url', label: 'Postgres URL', required: true, secret: true }]
      },
      'agent-1'
    )
    expect(formCard.richWidget?.kind).toBe('grok_form')
    if (formCard.richWidget?.kind === 'grok_form') {
      expect(formCard.richWidget.formKind).toBe('messaging-card')
      expect(formCard.richWidget.cardVersion).toBe(2)
      expect(formCard.richWidget.entryId).toBe('card_form_9')
    }
  })

  it('formats payment amount & merchant in GrokBotMessagingCard approval detail', () => {
    const payCard = parseGrokMessagingCard(
      {
        card_id: 'card_pay_1',
        version: 1,
        kind: 'GROK_BOT_MESSAGING_CARD_KIND_PAYMENT',
        state: 'PENDING',
        title: 'Approve Purchase',
        subtitle: 'Pro Plan Renewal',
        payment: {
          amount_cents: 4900,
          currency: 'usd',
          merchant_name: 'Vercel Inc.'
        }
      },
      'agent-1'
    )
    expect(payCard.approval?.detail).toContain('49.00 USD')
    expect(payCard.approval?.detail).toContain('Vercel Inc.')
    expect(payCard.approval?.host).toBe('Vercel Inc.')
  })
})
