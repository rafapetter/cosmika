#!/usr/bin/env node
// E2E smoke for WhatsApp Cloud API ingest + outbound.
// Requires cosmika-api running with COSMIKA_WHATSAPP_STUB=1 (so outbound
// doesn't actually call graph.facebook.com).

import { createHmac } from 'node:crypto'

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const password = 'correct-horse-battery'

let pass = 0
let fail = 0

function ok(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  ok  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}` + (detail ? ` — ${detail}` : ''))
  }
}

async function call(method, path, { token, body, expect, headers, rawText } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body || rawText ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: rawText ?? (body ? JSON.stringify(body) : undefined),
  })
  const text = await res.text()
  let json = null
  if (text) {
    try { json = JSON.parse(text) } catch { /* keep raw */ }
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status}: ${text}`)
  }
  return { status: res.status, json, text }
}

function sign(body, appSecret) {
  return 'sha256=' + createHmac('sha256', appSecret).update(body).digest('hex')
}

async function main() {
  console.log(`E2E whatsapp smoke against ${API}`)

  // Provision admin + WhatsApp-typed inbox with verifyToken + appSecret.
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-wa-${suffix}@cosmika.test`,
      password,
      fullName: 'WA Admin',
      accountName: `WA ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id

  const verifyToken = `vt-${suffix}`
  const appSecret = `s-${suffix}-app-secret-min-10-chars`

  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'WhatsApp prod',
      channelType: 'WHATSAPP',
      channelConfig: {
        phoneNumberId: '123456789',
        businessAccountId: '987654321',
        accessToken: 'EAAFakeTokenForTests',
        appSecret,
        webhookVerifyToken: verifyToken,
      },
    },
  })
  const inboxId = inbox.json.id

  // Channel config is redacted on response — accessToken/appSecret/verifyToken stripped.
  ok(
    'accessToken redacted on response',
    !('accessToken' in inbox.json.channelConfig),
  )
  ok(
    'appSecret redacted on response',
    !('appSecret' in inbox.json.channelConfig),
  )
  ok(
    'webhookVerifyToken redacted on response',
    !('webhookVerifyToken' in inbox.json.channelConfig),
  )

  // ── GET challenge ────────────────────────────────────────────────
  const correctChallenge = await call(
    'GET',
    `/webhooks/whatsapp/${inboxId}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=hello-world`,
    { expect: 200 },
  )
  ok('GET challenge echoes hub.challenge', correctChallenge.text === 'hello-world')

  const wrongToken = await call(
    'GET',
    `/webhooks/whatsapp/${inboxId}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello`,
    { expect: 403 },
  )
  ok('wrong verify_token returns 403', wrongToken.status === 403)

  // ── POST inbound (signature-verified) ─────────────────────────────
  const inbound = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+5511999999999', phone_number_id: '123456789' },
              contacts: [{ wa_id: '5511988887777', profile: { name: 'Maria' } }],
              messages: [
                {
                  from: '5511988887777',
                  id: `wamid-${suffix}-1`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Olá! Preciso de ajuda com meu pedido' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const body = JSON.stringify(inbound)

  // No signature → 403
  const noSig = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: body,
    expect: 403,
  })
  ok('missing signature returns 403', noSig.status === 403)

  // Bad signature → 403
  const badSig = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: body,
    expect: 403,
    headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
  })
  ok('bad signature returns 403', badSig.status === 403)

  // Good signature → 200 + processed:1
  const good = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: body,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(body, appSecret) },
  })
  ok('valid signature returns 200', good.status === 200)
  ok('processed = 1', good.json.processed === 1)

  // Contact created with the wa_id as phone
  const contacts = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=5511988887777`,
    { token, expect: 200 },
  )
  ok('contact upserted from waId', contacts.json.data.length === 1)
  ok('contact name from profile', contacts.json.data[0]?.name === 'Maria')

  // Conversation visible
  const convos = await call('GET', `/accounts/${accountId}/conversations`, {
    token,
    expect: 200,
  })
  ok('conversation created', convos.json.data.length >= 1)
  let convoId = convos.json.data[0].id

  // Message body matches
  const msgs = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    { token, expect: 200 },
  )
  const inboundMsg = msgs.json.data.find((m) => m.senderType === 'CONTACT')
  ok('inbound message stored', !!inboundMsg)
  ok(
    'message body matches',
    inboundMsg?.content === 'Olá! Preciso de ajuda com meu pedido',
  )

  // ── Idempotency: same wamid is deduped ────────────────────────────
  const dup = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: body,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(body, appSecret) },
  })
  ok('replay still 200', dup.status === 200)
  const msgsAfter = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    { token, expect: 200 },
  )
  const inboundCount = msgsAfter.json.data.filter(
    (m) => m.senderType === 'CONTACT',
  ).length
  ok('wamid deduped — no second contact message', inboundCount === 1)

  // ── Non-text message: image w/ caption ───────────────────────────
  const imageInbound = {
    ...inbound,
    entry: [
      {
        ...inbound.entry[0],
        changes: [
          {
            field: 'messages',
            value: {
              ...inbound.entry[0].changes[0].value,
              messages: [
                {
                  from: '5511988887777',
                  id: `wamid-${suffix}-img`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'image',
                  image: { caption: 'Look', mime_type: 'image/jpeg', id: 'media123' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const imgBody = JSON.stringify(imageInbound)
  const imgRes = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: imgBody,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(imgBody, appSecret) },
  })
  ok('image inbound processed', imgRes.json.processed === 1)

  const msgsImg = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    { token, expect: 200 },
  )
  const imgMsg = msgsImg.json.data.find(
    (m) => m.externalSourceId === `wamid-${suffix}-img`,
  )
  ok('image message stored', !!imgMsg)
  ok('image contentType = IMAGE', imgMsg?.contentType === 'IMAGE')
  ok('image caption preserved as content', imgMsg?.content === 'Look')

  // ── Outbound: agent sends a reply → WhatsApp Cloud API stub ──────
  // (COSMIKA_WHATSAPP_STUB=1 short-circuits the actual HTTPS call.)
  const send = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    {
      token,
      expect: 201,
      body: { content: 'Olá Maria! Vou verificar agora.' },
    },
  )
  ok('agent reply created', send.json.senderType === 'USER')

  // ── Outbound media: attachments ride the channel too ─────────────
  // An attachment-only message has empty content and still has to reach the
  // contact — the whole point of wiring media into the outbound push.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const uploadForm = new FormData()
  uploadForm.append('file', new Blob([png], { type: 'image/png' }), 'photo.png')
  const upload = await fetch(`${API}/accounts/${accountId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: uploadForm,
  })
  const uploaded = await upload.json()
  ok('attachment uploaded for outbound', upload.status === 201 && !!uploaded.id)

  const mediaOnly = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    {
      token,
      expect: 201,
      body: { content: '', attachmentIds: [uploaded.id] },
    },
  )
  ok('attachment-only message accepted', mediaOnly.status === 201)
  ok('attachment-only message has empty content', mediaOnly.json.content === '')

  const withMedia = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    { token, expect: 200 },
  )
  const mediaMsg = withMedia.json.data.find((m) => m.id === mediaOnly.json.id)
  ok('attachment hydrated on the outbound message', mediaMsg?.attachments?.length === 1)
  ok('attachment fileName preserved', mediaMsg?.attachments?.[0]?.fileName === 'photo.png')

  // Neither text nor attachments is still rejected.
  const empty = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    { token, expect: 400, body: { content: '' } },
  )
  ok('empty message with no attachments returns 400', empty.status === 400)

  // A closed conversation is never reopened: the next inbound from the same
  // contact opens a NEW conversation (Terms 4.2: it counts on the plan's meter).
  await call('PATCH', `/accounts/${accountId}/conversations/${convoId}`, {
    token,
    expect: 200,
    body: { status: 'RESOLVED' },
  })
  const reopenInbound = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+5511999999999', phone_number_id: '123456789' },
              contacts: [{ wa_id: '5511988887777' }],
              messages: [
                {
                  from: '5511988887777',
                  id: `wamid-${suffix}-2`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Voltei!' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const reopenBody = JSON.stringify(reopenInbound)
  await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: reopenBody,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(reopenBody, appSecret) },
  })
  const closedConvoId = convoId
  const after = await call(
    'GET',
    `/accounts/${accountId}/conversations/${closedConvoId}`,
    { token, expect: 200 },
  )
  ok('closed conversation stays RESOLVED after a new inbound', after.json.status === 'RESOLVED')
  ok('closed conversation was not reopened', after.json.reopenedAt === null)
  const convosAfterClose = await call('GET', `/accounts/${accountId}/conversations`, {
    token,
    expect: 200,
  })
  const fresh = convosAfterClose.json.data.filter(
    (c) => c.id !== closedConvoId && c.status === 'OPEN',
  )
  ok('inbound after close opened exactly one new conversation', fresh.length === 1)
  const freshMsgs = await call(
    'GET',
    `/accounts/${accountId}/conversations/${fresh[0]?.id}/messages`,
    { token, expect: 200 },
  )
  ok(
    'the new message landed in the new conversation',
    freshMsgs.json.data.some((m) => m.externalSourceId === `wamid-${suffix}-2`),
  )
  // Everything this contact sends from here on belongs to the new one.
  convoId = fresh[0]?.id

  // ── BSUID (Meta 2026 usernames): dual-key contact resolution ──────
  const BSUID_A = `BR.A${suffix}1111111111`
  const BSUID_B = `BR.B${suffix}2222222222`

  // 1. Known-phone user adopts a username: webhook now carries user_id
  //    alongside wa_id → BSUID backfills onto the existing contact, no dup.
  const bsuidBackfill = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+5511999999999', phone_number_id: '123456789' },
              contacts: [{ wa_id: '5511988887777', user_id: BSUID_A, profile: { name: 'Maria' } }],
              messages: [
                {
                  from: '5511988887777',
                  id: `wamid-${suffix}-bsuid-1`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Agora tenho username' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const bfBody = JSON.stringify(bsuidBackfill)
  const bfRes = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: bfBody,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(bfBody, appSecret) },
  })
  ok('wa_id + user_id webhook processed', bfRes.json.processed === 1)
  const contactsAfterBf = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=5511988887777`,
    { token, expect: 200 },
  )
  ok('no duplicate contact after BSUID backfill', contactsAfterBf.json.data.length === 1)

  // 2. Same user goes phone-less: wa_id and from omitted, only the BSUID.
  //    Must land on the SAME contact + conversation.
  const bsuidOnly = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+5511999999999', phone_number_id: '123456789' },
              contacts: [{ user_id: BSUID_A, profile: { name: 'Maria', username: 'maria.real' } }],
              messages: [
                {
                  from_user_id: BSUID_A,
                  id: `wamid-${suffix}-bsuid-2`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Sem telefone visível' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const boBody = JSON.stringify(bsuidOnly)
  const boRes = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: boBody,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(boBody, appSecret) },
  })
  ok('phone-less (BSUID-only) webhook processed', boRes.json.processed === 1)
  const contactsAfterBo = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=5511988887777`,
    { token, expect: 200 },
  )
  ok('still one contact after phone-less webhook', contactsAfterBo.json.data.length === 1)
  const msgsBo = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convoId}/messages`,
    { token, expect: 200 },
  )
  ok(
    'phone-less message landed in the same conversation',
    msgsBo.json.data.some((m) => m.externalSourceId === `wamid-${suffix}-bsuid-2`),
  )

  // 3. Brand-new username-only user: contact created without a phone,
  //    keyed by the BSUID.
  const newUser = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+5511999999999', phone_number_id: '123456789' },
              contacts: [
                { user_id: BSUID_B, profile: { name: 'Sheena Nelson', username: 'realsheenanelson' } },
              ],
              messages: [
                {
                  from_user_id: BSUID_B,
                  id: `wamid-${suffix}-bsuid-3`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Does it come in another color?' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const nuBody = JSON.stringify(newUser)
  const nuRes = await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: nuBody,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(nuBody, appSecret) },
  })
  ok('new username-only user processed', nuRes.json.processed === 1)
  const sheena = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=Sheena`,
    { token, expect: 200 },
  )
  ok('phone-less contact created', sheena.json.data.length === 1)
  ok('phone-less contact has no phone number', sheena.json.data[0]?.phoneNumber == null)

  // Replay of the same BSUID-only user must not duplicate the contact.
  const nuDupPayload = {
    ...newUser,
    entry: [
      {
        ...newUser.entry[0],
        changes: [
          {
            field: 'messages',
            value: {
              ...newUser.entry[0].changes[0].value,
              messages: [
                {
                  from_user_id: BSUID_B,
                  id: `wamid-${suffix}-bsuid-4`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Anyone there?' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const nuDupBody = JSON.stringify(nuDupPayload)
  await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: nuDupBody,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(nuDupBody, appSecret) },
  })
  const sheenaAfter = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=Sheena`,
    { token, expect: 200 },
  )
  ok('BSUID-only follow-up did not duplicate the contact', sheenaAfter.json.data.length === 1)

  // Agent reply to the phone-less contact goes through the BSUID recipient
  // path (stubbed outbound) without erroring.
  const sheenaConvos = await call('GET', `/accounts/${accountId}/conversations`, {
    token,
    expect: 200,
  })
  const sheenaConvo = sheenaConvos.json.data.find(
    (c) => c.contact?.name === 'Sheena Nelson',
  )
  ok('conversation exists for the phone-less contact', !!sheenaConvo)
  const sheenaReply = await call(
    'POST',
    `/accounts/${accountId}/conversations/${sheenaConvo.id}/messages`,
    {
      token,
      expect: 201,
      body: { content: 'Yes! Blue and green.' },
    },
  )
  ok('agent reply to phone-less contact created', sheenaReply.json.senderType === 'USER')

  // 4. Phone becomes visible for the username-only user: same contact
  //    gains the phone, no duplicate is created.
  const reassoc = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '987654321',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+5511999999999', phone_number_id: '123456789' },
              contacts: [
                { wa_id: '5511977776666', user_id: BSUID_B, profile: { name: 'Sheena Nelson' } },
              ],
              messages: [
                {
                  from: '5511977776666',
                  id: `wamid-${suffix}-bsuid-5`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'My phone is visible again' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const raBody = JSON.stringify(reassoc)
  await call('POST', `/webhooks/whatsapp/${inboxId}`, {
    rawText: raBody,
    expect: 200,
    headers: { 'x-hub-signature-256': sign(raBody, appSecret) },
  })
  const sheenaByPhone = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=5511977776666`,
    { token, expect: 200 },
  )
  ok('re-associated contact found by the new phone', sheenaByPhone.json.data.length === 1)
  ok(
    're-association kept a single contact',
    sheenaByPhone.json.data[0]?.name === 'Sheena Nelson',
  )
  const sheenaFinal = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=Sheena`,
    { token, expect: 200 },
  )
  ok('no duplicate contact after re-association', sheenaFinal.json.data.length === 1)

  // ── 404 for non-WhatsApp inbox ───────────────────────────────────
  const wWidget = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Site',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'S' },
    },
  })
  const noWa = await call(
    'GET',
    `/webhooks/whatsapp/${wWidget.json.id}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y`,
    { expect: 404 },
  )
  ok('GET challenge on non-WHATSAPP inbox returns 404', noWa.status === 404)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
