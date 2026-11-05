#!/usr/bin/env node
// E2E smoke test for Module 2 (Inboxes + Channels).
// Drives the api via fetch. Requires api running on $API_URL (default http://localhost:3110).
// Run: pnpm e2e:inboxes

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const adminEmail = `e2e-inbox-${suffix}@cosmika.test`
const agentEmail = `e2e-inbox-agent-${suffix}@cosmika.test`
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

async function call(method, path, { token, body, expect } = {}) {
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
    try { json = JSON.parse(text) } catch { /* keep raw */ }
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status} body=${text}`)
  }
  return { status: res.status, json }
}

async function main() {
  console.log(`E2E inboxes smoke against ${API}`)

  // sign-up admin
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: adminEmail,
      password,
      fullName: 'Inbox Admin',
      accountName: `Inbox E2E ${suffix}`,
    },
  })
  const adminToken = signUp.json.session.token
  const accountId = signUp.json.account.id

  // invite agent
  const invite = await call('POST', `/accounts/${accountId}/members`, {
    token: adminToken,
    expect: 201,
    body: { email: agentEmail, role: 'AGENT', fullName: 'Inbox Agent' },
  })
  const agentUserId = invite.json.userId

  // empty inbox list
  const empty = await call('GET', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 200,
  })
  ok('empty inbox list', Array.isArray(empty.json) && empty.json.length === 0)

  // create WEB_WIDGET inbox
  const widget = await call('POST', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 201,
    body: {
      name: 'Acme widget',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'Acme', primaryColor: '#4F46E5' },
    },
  })
  ok('widget channelType', widget.json.channelType === 'WEB_WIDGET')
  ok('widget config websiteName', widget.json.channelConfig.websiteName === 'Acme')
  const widgetId = widget.json.id

  // create EMAIL inbox; forwarding auto-generated
  const email = await call('POST', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 201,
    body: {
      name: 'Acme support',
      channelType: 'EMAIL',
      channelConfig: { signature: '--\nAcme' },
    },
  })
  ok(
    'email forwarding auto-generated',
    typeof email.json.channelConfig.forwardingAddress === 'string' &&
      email.json.channelConfig.forwardingAddress.endsWith('@cosmika.app'),
  )

  // create WHATSAPP inbox — accessToken must be redacted in response
  const wa = await call('POST', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 201,
    body: {
      name: 'Acme WA',
      channelType: 'WHATSAPP',
      channelConfig: {
        phoneNumberId: 'phn',
        businessAccountId: 'biz',
        accessToken: 'shhh-secret-token',
      },
    },
  })
  ok('whatsapp accessToken redacted', !('accessToken' in wa.json.channelConfig))
  ok('whatsapp phoneNumberId kept', wa.json.channelConfig.phoneNumberId === 'phn')

  // invalid channel config — web widget without websiteName
  const bad = await call('POST', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 400,
    body: {
      name: 'Bad',
      channelType: 'WEB_WIDGET',
      channelConfig: {},
    },
  })
  ok('missing websiteName returns 400', bad.status === 400)

  // wrong-shape config for declared channel
  const mismatched = await call('POST', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 400,
    body: {
      name: 'Mismatched',
      channelType: 'WHATSAPP',
      channelConfig: { websiteName: 'wrong' },
    },
  })
  ok('mismatched config returns 400', mismatched.status === 400)

  // list returns 3
  const list = await call('GET', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 200,
  })
  ok('list returns 3 inboxes', list.json.length === 3)

  // GET single inbox with members
  const detail = await call(
    'GET',
    `/accounts/${accountId}/inboxes/${widgetId}`,
    { token: adminToken, expect: 200 },
  )
  ok('detail has members array', Array.isArray(detail.json.members))
  ok('detail members empty at first', detail.json.members.length === 0)

  // PATCH inbox config (re-validates against channel schema)
  const patched = await call(
    'PATCH',
    `/accounts/${accountId}/inboxes/${widgetId}`,
    {
      token: adminToken,
      expect: 200,
      body: {
        name: 'Acme widget renamed',
        channelConfig: { primaryColor: '#FF0000' },
        aiAutoreplyMode: 'AUTO_SAFE',
      },
    },
  )
  ok('PATCH name applied', patched.json.name === 'Acme widget renamed')
  ok(
    'PATCH preserves existing websiteName',
    patched.json.channelConfig.websiteName === 'Acme',
  )
  ok(
    'PATCH overwrites primaryColor',
    patched.json.channelConfig.primaryColor === '#FF0000',
  )
  ok('PATCH autoreply', patched.json.aiAutoreplyMode === 'AUTO_SAFE')

  // PATCH with invalid color → 400
  const patchBad = await call(
    'PATCH',
    `/accounts/${accountId}/inboxes/${widgetId}`,
    {
      token: adminToken,
      expect: 400,
      body: { channelConfig: { primaryColor: 'not-a-color' } },
    },
  )
  ok('PATCH invalid color returns 400', patchBad.status === 400)

  // Add agent as inbox member
  const member = await call(
    'POST',
    `/accounts/${accountId}/inboxes/${widgetId}/members`,
    {
      token: adminToken,
      expect: 201,
      body: { userId: agentUserId },
    },
  )
  ok('member added', member.json.userId === agentUserId)

  // Duplicate member add → 409
  const dup = await call(
    'POST',
    `/accounts/${accountId}/inboxes/${widgetId}/members`,
    {
      token: adminToken,
      expect: 409,
      body: { userId: agentUserId },
    },
  )
  ok('duplicate member returns 409', dup.status === 409)

  // Agent now signs in (we need to set a password for agent — but invite created passwordless)
  // So instead, verify the agent appears in the inbox member list.
  const detail2 = await call(
    'GET',
    `/accounts/${accountId}/inboxes/${widgetId}`,
    { token: adminToken, expect: 200 },
  )
  ok('agent appears in members', detail2.json.members.length === 1)

  // Remove member
  const rm = await call(
    'DELETE',
    `/accounts/${accountId}/inboxes/${widgetId}/members/${agentUserId}`,
    { token: adminToken, expect: 204 },
  )
  ok('member removed', rm.status === 204)

  // Removing non-existent member → 404
  const rm404 = await call(
    'DELETE',
    `/accounts/${accountId}/inboxes/${widgetId}/members/${agentUserId}`,
    { token: adminToken, expect: 404 },
  )
  ok('removing missing member returns 404', rm404.status === 404)

  // Outsider cannot see this account's inboxes
  const outsiderSignUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-outsider-${suffix}@cosmika.test`,
      password,
      fullName: 'Outsider',
      accountName: 'Outsider Co',
    },
  })
  const outsiderToken = outsiderSignUp.json.session.token
  const outsiderList = await call(
    'GET',
    `/accounts/${accountId}/inboxes`,
    { token: outsiderToken, expect: 403 },
  )
  ok('outsider list returns 403', outsiderList.status === 403)
  const outsiderCreate = await call(
    'POST',
    `/accounts/${accountId}/inboxes`,
    {
      token: outsiderToken,
      expect: 403,
      body: {
        name: 'evil',
        channelType: 'WEB_WIDGET',
        channelConfig: { websiteName: 'evil' },
      },
    },
  )
  ok('outsider create returns 403', outsiderCreate.status === 403)

  // Delete inbox
  const del = await call(
    'DELETE',
    `/accounts/${accountId}/inboxes/${widgetId}`,
    { token: adminToken, expect: 204 },
  )
  ok('delete inbox returns 204', del.status === 204)

  // After delete, get returns 404
  const after = await call(
    'GET',
    `/accounts/${accountId}/inboxes/${widgetId}`,
    { token: adminToken, expect: 404 },
  )
  ok('deleted inbox returns 404 on get', after.status === 404)

  // List now 2
  const finalList = await call('GET', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 200,
  })
  ok('list after delete has 2 inboxes', finalList.json.length === 2)

  // Unauthenticated request rejected
  const unauth = await call('GET', `/accounts/${accountId}/inboxes`, {
    expect: 401,
  })
  ok('unauthenticated list returns 401', unauth.status === 401)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
