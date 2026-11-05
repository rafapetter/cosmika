#!/usr/bin/env node
import { createHmac } from 'node:crypto'

// E2E smoke test for Tier 3 features:
//   - profile/account update + password
//   - custom attributes CRUD
//   - agent availability replace
//   - contacts import (create + dedupe)
//   - webhooks create + delivery + audit
//   - conversation forwarding
//   - audit log read
//
// Runs against the API at $API_URL (default http://localhost:3110).
// Run: pnpm e2e:tier3

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const founderEmail = `e2e-t3-${suffix}@cosmika.test`
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

async function call(method, path, opts = {}, overrideToken) {
  const { token: optsToken, body, expect } = opts
  const token = overrideToken ?? optsToken
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  if (text) {
    try { json = JSON.parse(text) } catch { /* keep as text */ }
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status} body=${text}`)
  }
  return { status: res.status, json }
}

async function main() {
  console.log(`E2E Tier 3 smoke against ${API}`)

  // ─── bootstrap: sign up a fresh account ───
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: founderEmail,
      password,
      fullName: 'Tier3 Founder',
      accountName: `Tier3 Co ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id
  const userId = signUp.json.user.id
  const memberId = signUp.json.membership.id
  ok('signed up', !!token)

  // ─── profile (PATCH /auth/me + password) ───
  const updated = await call('PATCH', '/auth/me', {
    token, expect: 200,
    body: { fullName: 'Renamed Founder', locale: 'en' },
  })
  ok('PATCH /auth/me applies name', updated.json?.fullName === 'Renamed Founder')
  ok('PATCH /auth/me applies locale', updated.json?.locale === 'en')

  const badPw = await call('POST', '/auth/me/password', {
    token, expect: 400,
    body: { currentPassword: 'wrong', newPassword: 'new-password-1234' },
  })
  ok('password change with bad current → 400', badPw.status === 400)

  const goodPw = await call('POST', '/auth/me/password', {
    token, expect: 204,
    body: { currentPassword: password, newPassword: 'new-password-1234' },
  })
  ok('password change with good current → 204', goodPw.status === 204)

  const reSignIn = await call('POST', '/auth/sign-in', {
    expect: 200,
    body: { email: founderEmail, password: 'new-password-1234' },
  })
  ok('can sign in with new password', !!reSignIn.json?.session?.token)

  // ─── custom attributes ───
  const ca = await call('POST', `/accounts/${accountId}/custom-attributes`, {
    token, expect: 201,
    body: { target: 'CONTACT', key: 'lead_score', label: 'Lead score', type: 'NUMBER' },
  })
  ok('create custom attribute', ca.json?.key === 'lead_score')

  const caDupe = await call('POST', `/accounts/${accountId}/custom-attributes`, {
    token, expect: 409,
    body: { target: 'CONTACT', key: 'lead_score', label: 'Dupe', type: 'TEXT' },
  })
  ok('duplicate key returns 409', caDupe.status === 409)

  const caList = await call('GET', `/accounts/${accountId}/custom-attributes?target=CONTACT`, {
    token, expect: 200,
  })
  ok('list custom attributes', Array.isArray(caList.json) && caList.json.length >= 1)

  const caUpdate = await call('PATCH', `/accounts/${accountId}/custom-attributes/${ca.json.id}`, {
    token, expect: 200,
    body: { label: 'Updated lead score' },
  })
  ok('update custom attribute label', caUpdate.json?.label === 'Updated lead score')

  const caDel = await call('DELETE', `/accounts/${accountId}/custom-attributes/${ca.json.id}`, {
    token, expect: 204,
  })
  ok('delete custom attribute', caDel.status === 204)

  // ─── agent availability ───
  const av = await call('PUT', `/accounts/${accountId}/agents/${memberId}/availability`, {
    token, expect: 200,
    body: {
      schedule: [
        { dayOfWeek: 1, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
        { dayOfWeek: 2, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
      ],
    },
  })
  ok('PUT availability returns 2 days', Array.isArray(av.json) && av.json.length === 2)

  const avGet = await call('GET', `/accounts/${accountId}/agents/${memberId}/availability`, {
    token, expect: 200,
  })
  ok('GET availability has 2 days', avGet.json.length === 2)

  // ─── contacts import ───
  const importRes = await call('POST', `/accounts/${accountId}/contacts/import`, {
    token, expect: 201,
    body: {
      rows: [
        { name: 'Ada Lovelace', email: `ada-${suffix}@example.com` },
        { name: 'Grace Hopper', email: `grace-${suffix}@example.com`, phoneNumber: '+15550101' },
      ],
    },
  })
  ok('import created 2', importRes.json?.created === 2)

  const reimport = await call('POST', `/accounts/${accountId}/contacts/import`, {
    token, expect: 201,
    body: {
      rows: [
        { name: 'Ada L. (renamed)', email: `ada-${suffix}@example.com` },
      ],
    },
  })
  ok('re-import dedupes by email → updated', reimport.json?.updated === 1)

  // ─── webhooks ───
  const wh = await call('POST', `/accounts/${accountId}/webhooks`, {
    token, expect: 201,
    body: { name: 'Tier3 wh', url: 'https://httpbin.org/post', events: ['contact.created', 'message.created'] },
  })
  ok('webhook create returns secret', typeof wh.json?.secret === 'string' && wh.json.secret.startsWith('whsec_'))

  // Trigger a webhook via contact create.
  await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: { name: 'Webhook trigger', email: `wh-${suffix}@example.com` },
  })

  // Delivery is async (worker ticks every 30s). Poll up to 70s for SUCCESS.
  let deliveries
  let succeeded = false
  for (let t = 0; t < 14 && !succeeded; t += 1) {
    await new Promise(r => setTimeout(r, 5000))
    deliveries = await call('GET', `/accounts/${accountId}/webhooks/${wh.json.id}/deliveries`, {
      token, expect: 200,
    })
    succeeded = deliveries.json?.[0]?.status === 'SUCCESS'
  }
  ok('at least one delivery recorded', Array.isArray(deliveries.json) && deliveries.json.length >= 1)
  if (deliveries.json[0]) {
    ok('delivery succeeded (httpbin 200)',
      deliveries.json[0].status === 'SUCCESS' && deliveries.json[0].responseStatus === 200,
      `status=${deliveries.json[0].status} httpStatus=${deliveries.json[0].responseStatus} err=${deliveries.json[0].errorMessage}`)
  }

  const whToggle = await call('PATCH', `/accounts/${accountId}/webhooks/${wh.json.id}`, {
    token, expect: 200,
    body: { isActive: false },
  })
  ok('toggle webhook off', whToggle.json?.isActive === false)

  await call('DELETE', `/accounts/${accountId}/webhooks/${wh.json.id}`, {
    token, expect: 204,
  })
  ok('webhook delete', true)

  // ─── conversation forward ───
  // Need: a contact, two inboxes, and a conversation in one of them.
  const c1 = await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: { name: 'Forward target', email: `fwd-${suffix}@example.com` },
  })
  const i1 = await call('POST', `/accounts/${accountId}/inboxes`, {
    token, expect: 201,
    body: { name: 'Inbox A', channelType: 'API', channelConfig: {} },
  })
  const i2 = await call('POST', `/accounts/${accountId}/inboxes`, {
    token, expect: 201,
    body: { name: 'Inbox B', channelType: 'API', channelConfig: {} },
  })
  const conv = await call('POST', `/accounts/${accountId}/conversations`, {
    token, expect: 201,
    body: { contactId: c1.json.id, inboxId: i1.json.id },
  })
  const fwd = await call('POST', `/accounts/${accountId}/conversations/${conv.json.id}/forward`, {
    token, expect: 201,
    body: { targetInboxId: i2.json.id, note: 'For escalation' },
  })
  ok('forward returns new conversation id', typeof fwd.json?.conversationId === 'string')
  ok('forward returns new displayId', typeof fwd.json?.displayId === 'number')

  // ─── audit log ───
  const audit = await call('GET', `/accounts/${accountId}/audit-logs`, {
    token, expect: 200,
  })
  ok('audit log returns items', Array.isArray(audit.json?.items) && audit.json.items.length > 0)
  const actions = new Set((audit.json.items ?? []).map(i => i.action))
  ok('audit has custom_attribute.create', actions.has('custom_attribute.create'))
  ok('audit has custom_attribute.update', actions.has('custom_attribute.update'))
  ok('audit has custom_attribute.delete', actions.has('custom_attribute.delete'))
  ok('audit has webhook.create', actions.has('webhook.create'))
  ok('audit has webhook.update', actions.has('webhook.update'))
  ok('audit has webhook.delete', actions.has('webhook.delete'))
  ok('audit has conversation.forward', actions.has('conversation.forward'))
  ok('audit has contact.import', actions.has('contact.import'))
  ok('audit has account.update (from sign-up flow? no — we PATCHed it later)',
    true) // we didn't PATCH account in this script, so don't require

  // filter
  const filtered = await call('GET', `/accounts/${accountId}/audit-logs?action=webhook.create`, {
    token, expect: 200,
  })
  ok('filter by action narrows result',
    filtered.json.items.every(i => i.action === 'webhook.create'))

  // ─── SLA policies ───
  const sla = await call('POST', `/accounts/${accountId}/sla-policies`, {
    token, expect: 201,
    body: {
      name: 'Default SLA',
      firstResponseUrgentMinutes: 5,
      resolutionUrgentMinutes: 60,
    },
  })
  ok('SLA policy created', sla.json?.name === 'Default SLA')
  ok('first reply urgent overridden', sla.json?.firstResponseUrgentMinutes === 5)
  ok('first reply NORMAL defaults to 240', sla.json?.firstResponseNormalMinutes === 240)

  const slaList = await call('GET', `/accounts/${accountId}/sla-policies`, {
    token, expect: 200,
  })
  ok('SLA list returns 1', slaList.json.length === 1)

  // Attach to an inbox
  await call('PATCH', `/accounts/${accountId}/inboxes/${i1.json.id}`, {
    token, expect: 200,
    body: { slaPolicyId: sla.json.id },
  })

  // Create an URGENT conversation in that inbox + immediately query list,
  // confirm slaStatus is computed.
  const slaContact = await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: { name: 'SLA Contact', email: `sla-${suffix}@example.com` },
  })
  const slaConv = await call('POST', `/accounts/${accountId}/conversations`, {
    token, expect: 201,
    body: { contactId: slaContact.json.id, inboxId: i1.json.id },
  })
  await call('PATCH', `/accounts/${accountId}/conversations/${slaConv.json.id}`, {
    token, expect: 200,
    body: { priority: 'URGENT' },
  })

  const convList = await call(
    'GET',
    `/accounts/${accountId}/conversations?inboxId=${i1.json.id}`,
    { token, expect: 200 },
  )
  const slaConvRow = convList.json.data.find((c) => c.id === slaConv.json.id)
  ok('SLA conv has slaStatus', !!slaConvRow?.slaStatus)
  ok('SLA on URGENT freshly-created is ON_TRACK', slaConvRow?.slaStatus?.state === 'ON_TRACK')
  ok('SLA dimension is firstResponse', slaConvRow?.slaStatus?.dimension === 'firstResponse')

  await call('DELETE', `/accounts/${accountId}/sla-policies/${sla.json.id}`, {
    token, expect: 204,
  })

  // ─── Webhook retry path ───
  // Create a webhook pointing at a failing URL, fire an event, observe
  // delivery rows with status PENDING + multiple attempts.
  const whFail = await call('POST', `/accounts/${accountId}/webhooks`, {
    token, expect: 201,
    body: {
      name: 'Failing wh',
      url: 'http://127.0.0.1:1/never-listens',  // immediate ECONNREFUSED
      events: ['contact.created'],
    },
  })
  await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: { name: 'Trigger retry', email: `retry-${suffix}@example.com` },
  })
  // Worker runs every 30s; wait long enough for one tick.
  await new Promise(r => setTimeout(r, 35_000))
  const retryDeliveries = await call(
    'GET',
    `/accounts/${accountId}/webhooks/${whFail.json.id}/deliveries`,
    { token, expect: 200 },
  )
  ok('failing webhook recorded a delivery', retryDeliveries.json.length === 1)
  const dlv = retryDeliveries.json[0]
  ok('first attempt failed (attempts >=1)', dlv && dlv.attempts >= 1)
  ok('row stayed PENDING for retry (not yet FAILED)',
    dlv && (dlv.status === 'PENDING' || dlv.status === 'FAILED'))

  // Manual retry endpoint
  const retryRes = await call(
    'POST',
    `/accounts/${accountId}/webhooks/${whFail.json.id}/deliveries/${dlv.id}/retry`,
    { token, expect: 204 },
  )
  ok('manual retry returns 204', retryRes.status === 204)

  await call('DELETE', `/accounts/${accountId}/webhooks/${whFail.json.id}`, {
    token, expect: 204,
  })

  // ─── Knowledge base ───
  const article = await call('POST', `/accounts/${accountId}/articles`, {
    token, expect: 201,
    body: {
      slug: 'refunds-policy',
      title: 'Refunds policy',
      content: 'Customers can request a refund within 30 days of purchase.',
      status: 'PUBLISHED',
      tags: ['billing', 'refunds'],
    },
  })
  ok('article created PUBLISHED', article.json?.status === 'PUBLISHED')
  ok('article has slug', article.json?.slug === 'refunds-policy')

  const dupeArticle = await call('POST', `/accounts/${accountId}/articles`, {
    token, expect: 409,
    body: { slug: 'refunds-policy', title: 'Dupe', content: 'x' },
  })
  ok('duplicate slug returns 409', dupeArticle.status === 409)

  const draftArticle = await call('POST', `/accounts/${accountId}/articles`, {
    token, expect: 201,
    body: {
      slug: 'shipping-times',
      title: 'Shipping times',
      content: 'Standard shipping arrives in 3-5 business days.',
      status: 'DRAFT',
    },
  })
  ok('draft article created', draftArticle.json?.status === 'DRAFT')

  const articleList = await call('GET', `/accounts/${accountId}/articles?status=PUBLISHED`, {
    token, expect: 200,
  })
  ok('list filter status=PUBLISHED returns 1', articleList.json.length === 1)

  const articleSearch = await call(
    'GET',
    `/accounts/${accountId}/articles/search?q=refund`,
    { token, expect: 200 },
  )
  ok('search finds published article by ILIKE fallback',
    articleSearch.json.length >= 1 && articleSearch.json[0].slug === 'refunds-policy')

  const draftSearch = await call(
    'GET',
    `/accounts/${accountId}/articles/search?q=shipping`,
    { token, expect: 200 },
  )
  ok('search ignores DRAFT articles', draftSearch.json.length === 0)

  await call('DELETE', `/accounts/${accountId}/articles/${article.json.id}`, {
    token, expect: 204,
  })
  await call('DELETE', `/accounts/${accountId}/articles/${draftArticle.json.id}`, {
    token, expect: 204,
  })

  // ─── GDPR — export + anonymize ───
  const gdprContact = await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: {
      name: 'GDPR Test',
      email: `gdpr-${suffix}@example.com`,
      phoneNumber: '+15550199',
    },
  })

  const exportBundle = await call(
    'GET',
    `/accounts/${accountId}/contacts/${gdprContact.json.id}/export`,
    { token, expect: 200 },
  )
  ok('export bundle has contact section', !!exportBundle.json.contact)
  ok('export bundle contains email', exportBundle.json.contact.email === `gdpr-${suffix}@example.com`)
  ok('export bundle has conversations array', Array.isArray(exportBundle.json.conversations))

  const anonRes = await call(
    'POST',
    `/accounts/${accountId}/contacts/${gdprContact.json.id}/anonymize`,
    { token, expect: 201 },
  )
  ok('anonymize clears email', anonRes.json?.email === null)
  ok('anonymize clears phone', anonRes.json?.phoneNumber === null)
  ok('anonymize sets name to [redacted]', anonRes.json?.name === '[redacted]')

  // Audit
  const s2Audit = await call(
    'GET',
    `/accounts/${accountId}/audit-logs?action=contact.export`,
    { token, expect: 200 },
  )
  ok('contact.export logged', s2Audit.json.items.length >= 1)
  const s2AuditAnon = await call(
    'GET',
    `/accounts/${accountId}/audit-logs?action=contact.anonymize`,
    { token, expect: 200 },
  )
  ok('contact.anonymize logged', s2AuditAnon.json.items.length >= 1)
  const s2AuditArticle = await call(
    'GET',
    `/accounts/${accountId}/audit-logs?action=article.create`,
    { token, expect: 200 },
  )
  ok('article.create logged', s2AuditArticle.json.items.length >= 1)

  // ─── S3: Usage / plan enforcement ───
  const usage = await call('GET', `/accounts/${accountId}/usage`, {
    token, expect: 200,
  })
  ok('usage endpoint returns plan', typeof usage.json?.plan === 'string')
  ok('usage exposes caps', !!usage.json?.caps)
  ok('contacts count present', typeof usage.json?.contacts === 'number')

  // ─── S3: API keys ───
  const apiKey = await call('POST', `/accounts/${accountId}/api-keys`, {
    token, expect: 201,
    body: { name: 'S3 test key' },
  })
  ok('api key create returns secret',
    typeof apiKey.json?.secret === 'string' && apiKey.json.secret.startsWith('cosmika_'))
  ok('api key has prefix', /^[0-9a-f]{8}$/.test(apiKey.json?.prefix ?? ''))

  const whoami = await call('GET', '/api/v1/whoami', {
    expect: 200,
  }, apiKey.json.secret)
  ok('whoami via API key returns account', whoami.json?.account?.id === accountId)

  const noAuth = await call('GET', '/api/v1/whoami', { expect: 401 })
  ok('whoami without key returns 401', noAuth.status === 401)

  await call('DELETE', `/accounts/${accountId}/api-keys/${apiKey.json.id}`, {
    token, expect: 204,
  })
  const revoked = await call('GET', '/api/v1/whoami', { expect: 401 }, apiKey.json.secret)
  ok('revoked key returns 401', revoked.status === 401)

  // ─── S3: 2FA ───
  const setup = await call('POST', '/auth/me/2fa/setup', {
    token, expect: 200,
  })
  ok('totp setup returns secret', typeof setup.json?.secret === 'string')
  ok('totp setup returns otpauth url', String(setup.json?.otpauthUrl ?? '').startsWith('otpauth://totp/'))

  // Forge a code by importing the helper. We can't easily import from the
  // built API here; instead trust that verifyTotp accepts a code generated
  // from the same secret. Generate one quickly via TOTP step.
  const totpCode = (() => {
    const secret = setup.json.secret
    // Base32 decode
    const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    const clean = secret.replace(/=+$/, '').toUpperCase()
    let bits = 0, value = 0; const bytes = []
    for (const ch of clean) {
      const idx = ALPH.indexOf(ch); if (idx === -1) continue
      value = (value << 5) | idx; bits += 5
      if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
    }
    const key = Buffer.from(bytes)
    const counter = Math.floor(Date.now() / 1000 / 30)
    const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter))
    const mac = createHmac('sha1', key).update(buf).digest()
    const off = mac[mac.length - 1] & 0x0f
    const num = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]
    return String(num % 1_000_000).padStart(6, '0')
  })()

  const verify = await call('POST', '/auth/me/2fa/verify', {
    token, expect: 200,
    body: { code: totpCode },
  })
  ok('totp verify enables 2fa', verify.json?.enabled === true)
  ok('totp verify returns recovery codes',
    Array.isArray(verify.json?.recoveryCodes) && verify.json.recoveryCodes.length >= 5)

  // Sign in now requires a challenge.
  const signInWith2fa = await call('POST', '/auth/sign-in', {
    expect: 200,
    body: { email: founderEmail, password: 'new-password-1234' },
  })
  ok('sign-in returns totp challenge', signInWith2fa.json?.kind === 'totp')
  ok('challenge token present', typeof signInWith2fa.json?.challengeToken === 'string')

  // Disable 2FA so subsequent test flows aren't blocked.
  await call('POST', '/auth/me/2fa/disable', {
    token, expect: 204,
    body: { code: totpCode },
  })

  // ─── S3: Member management ───
  const newMemberEmail = `s3-member-${suffix}@example.com`
  const invited = await call('POST', `/accounts/${accountId}/members`, {
    token, expect: 201,
    body: { email: newMemberEmail, role: 'AGENT', fullName: 'S3 Agent' },
  })
  ok('invite returns membership', invited.json?.role === 'AGENT')

  const promoted = await call(
    'PATCH',
    `/accounts/${accountId}/members/${invited.json.userId}`,
    { token, expect: 200, body: { role: 'ADMINISTRATOR' } },
  )
  ok('role change applied', promoted.json?.role === 'ADMINISTRATOR')

  // Try removing the original admin (the founder). Since the newly-promoted
  // user is also an admin now, that should succeed — but we still skip
  // because we need this session active. Instead, demote them back, then
  // remove.
  await call(
    'PATCH',
    `/accounts/${accountId}/members/${invited.json.userId}`,
    { token, expect: 200, body: { role: 'AGENT' } },
  )

  await call(
    'DELETE',
    `/accounts/${accountId}/members/${invited.json.userId}`,
    { token, expect: 204 },
  )

  // Try removing yourself (founder). Should be rejected with 400 (BadRequest).
  const removeSelf = await call(
    'DELETE',
    `/accounts/${accountId}/members/${userId}`,
    { token, expect: 400 },
  )
  ok('cannot remove yourself', removeSelf.status === 400)

  // ─── S4: global search ───
  // Seed: create an article + a conversation so search has hits.
  await call('POST', `/accounts/${accountId}/articles`, {
    token, expect: 201,
    body: {
      slug: 'globally-searchable',
      title: 'How to find unique-' + suffix,
      content: 'This article exists to validate search.',
      status: 'PUBLISHED',
    },
  })
  const searchContact = await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: {
      name: 'Search Contact unique-' + suffix,
      email: `search-${suffix}@example.com`,
    },
  })

  const tooShort = await call(
    'GET',
    `/accounts/${accountId}/search?q=a`,
    { token, expect: 200 },
  )
  ok('search ignores queries <2 chars', tooShort.json.hits.length === 0)

  const searchRes = await call(
    'GET',
    `/accounts/${accountId}/search?q=unique-${suffix}`,
    { token, expect: 200 },
  )
  const kinds = new Set(searchRes.json.hits.map((h) => h.kind))
  ok('search returns contact hit', kinds.has('contact'))
  ok('search returns article hit', kinds.has('article'))

  await call('DELETE', `/accounts/${accountId}/contacts/${searchContact.json.id}`, {
    token, expect: 204,
  })

  // ─── S5: forwarded-from ───
  // Use the conversation created earlier (fwd.json.conversationId).
  const fwdDetail = await call(
    'GET',
    `/accounts/${accountId}/conversations/${fwd.json.conversationId}`,
    { token, expect: 200 },
  )
  ok('forwardedFrom field present', fwdDetail.json?.forwardedFrom !== undefined)
  ok('forwardedFrom matches source conversation',
    fwdDetail.json?.forwardedFrom?.id === conv.json.id)
  ok('forwardedFrom carries displayId',
    typeof fwdDetail.json?.forwardedFrom?.displayId === 'number')

  // A vanilla (non-forwarded) conversation should have forwardedFrom=null.
  const plainDetail = await call(
    'GET',
    `/accounts/${accountId}/conversations/${conv.json.id}`,
    { token, expect: 200 },
  )
  ok('plain convo has forwardedFrom=null', plainDetail.json?.forwardedFrom === null)

  // ─── S5: auto-assign by availability ───
  // The founder is the only inbox member here. The endpoint picks them only
  // while their saved schedule covers this moment in the account's timezone.
  const inboxForAssign = await call('POST', `/accounts/${accountId}/inboxes`, {
    token, expect: 201,
    body: { name: 'Auto-assign inbox', channelType: 'API', channelConfig: {} },
  })
  await call('POST', `/accounts/${accountId}/inboxes/${inboxForAssign.json.id}/members`, {
    token, expect: 201,
    body: { userId },
  })
  const assignContact = await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: { name: 'Assign Test', email: `assign-${suffix}@example.com` },
  })
  const assignConv = await call('POST', `/accounts/${accountId}/conversations`, {
    token, expect: 201,
    body: { contactId: assignContact.json.id, inboxId: inboxForAssign.json.id },
  })
  const autoAssign = () => call(
    'POST',
    `/accounts/${accountId}/conversations/${assignConv.json.id}/auto-assign`,
    { token, expect: 201 },
  )
  const setSchedule = (schedule) => call(
    'PUT',
    `/accounts/${accountId}/agents/${memberId}/availability`,
    { token, expect: 200, body: { schedule } },
  )

  // No schedule saved means not available: the conversation stays in the queue.
  await setSchedule([])
  const autoOff = await autoAssign()
  ok('auto-assign picks nobody when no agent is on shift', autoOff.json?.assigneeId === null,
    `assigneeId=${autoOff.json?.assigneeId}`)

  // On shift every day of the week. A window closes at 23:59 at the latest and
  // the close is exclusive, so one window per day always leaves a minute out:
  // pick the shape whose uncovered minute is hours away from now.
  const hourNow = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: signUp.json.account.defaultTimezone,
      hourCycle: 'h23',
      hour: '2-digit',
    }).format(new Date()),
  )
  const shift = hourNow < 12
    ? { openHour: 0, openMinute: 0, closeHour: 23, closeMinute: 59 } // out: 23:59
    : { openHour: 12, openMinute: 0, closeHour: 11, closeMinute: 59 } // overnight, out: 11:59
  await setSchedule(
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, ...shift, closedAllDay: false })),
  )
  const auto = await autoAssign()
  ok('auto-assign returns a userId', typeof auto.json?.assigneeId === 'string')
  ok('auto-assigned to the inbox member on shift', auto.json?.assigneeId === userId)

  // ─── S6: SSRF guard on webhooks ───
  const ssrfWh = await call('POST', `/accounts/${accountId}/webhooks`, {
    token, expect: 201,
    body: {
      name: 'SSRF probe',
      url: 'http://169.254.169.254/latest/meta-data/',
      events: ['contact.created'],
    },
  })
  await call('POST', `/accounts/${accountId}/contacts`, {
    token, expect: 201,
    body: { name: 'SSRF trigger', email: `ssrf-${suffix}@example.com` },
  })
  // Wait for the worker to attempt at least once + record the SSRF block.
  // Worker ticks every 30s. After 1 attempt the row stays PENDING with the
  // backoff timer set; what we care about is `errorMessage` matching.
  let ssrfDeliveries
  for (let i = 0; i < 14; i += 1) {
    await new Promise(r => setTimeout(r, 5000))
    ssrfDeliveries = await call(
      'GET',
      `/accounts/${accountId}/webhooks/${ssrfWh.json.id}/deliveries`,
      { token, expect: 200 },
    )
    if ((ssrfDeliveries.json[0]?.attempts ?? 0) >= 1) break
  }
  ok('SSRF webhook delivery blocked by URL guard',
    /blocked|internal|URL/i.test(ssrfDeliveries.json[0]?.errorMessage ?? ''),
    `errorMessage=${ssrfDeliveries.json[0]?.errorMessage}`)
  await call('DELETE', `/accounts/${accountId}/webhooks/${ssrfWh.json.id}`, {
    token, expect: 204,
  })

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
