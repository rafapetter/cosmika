#!/usr/bin/env node
// E2E smoke test for Module 6 widget endpoints.
// Run: pnpm e2e:widget

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const adminEmail = `e2e-widget-${suffix}@cosmika.test`
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

async function call(method, path, opts = {}) {
  const { token, body, expect, origin } = opts
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
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
  return { status: res.status, json, text }
}

async function main() {
  console.log(`E2E widget smoke against ${API}`)

  // Admin setup.
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: adminEmail,
      password,
      fullName: 'A',
      accountName: `W ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id

  // Create web_widget inbox with a configured websiteUrl.
  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Web',
      channelType: 'WEB_WIDGET',
      channelConfig: {
        websiteName: 'Test',
        websiteUrl: 'https://example.com',
      },
    },
  })
  const hash = inbox.json.channelConfig.widgetHash
  ok('widgetHash auto-generated', typeof hash === 'string' && hash.length === 32)

  // Email inbox does NOT get a widgetHash.
  const emailInbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Email',
      channelType: 'EMAIL',
      channelConfig: {},
    },
  })
  ok(
    'EMAIL inbox has no widgetHash',
    emailInbox.json.channelConfig.widgetHash === undefined,
  )

  // Bad hash → 404.
  const bad = await call('POST', `/widget/nothere0000000000000000000000000/sessions`, {
    expect: 404,
    body: {},
  })
  ok('unknown hash returns 404', bad.status === 404)

  // Create visitor session (no origin → CORS skip).
  const sess1 = await call('POST', `/widget/${hash}/sessions`, {
    expect: 201,
    body: { name: 'Visitor One', email: 'v1@example.com' },
  })
  ok('session returned visitorToken', typeof sess1.json.visitorToken === 'string')
  ok('session returned conversationId', typeof sess1.json.conversationId === 'string')
  const visitor1Token = sess1.json.visitorToken
  const conv1 = sess1.json.conversationId

  // Origin mismatch → 400.
  const wrongOrigin = await call('POST', `/widget/${hash}/sessions`, {
    expect: 400,
    body: {},
    origin: 'https://evil.example',
  })
  ok('foreign origin returns 400', wrongOrigin.status === 400)

  // Matching origin → 201.
  const sameOrigin = await call('POST', `/widget/${hash}/sessions`, {
    expect: 201,
    body: { visitorId: 'visitor-aaaaaaaa' },
    origin: 'https://example.com',
  })
  ok('allowed origin succeeds', sameOrigin.status === 201)

  // Post message.
  const post = await call('POST', `/widget/${hash}/messages`, {
    expect: 201,
    body: { visitorToken: visitor1Token, content: 'hello from visitor' },
  })
  ok('message persisted', typeof post.json.id === 'string')

  // List messages — should include the one we just posted, NOT private notes.
  const list = await call('GET', `/widget/${hash}/messages?visitorToken=${visitor1Token}`, {
    expect: 200,
  })
  ok('list returns the visitor message', list.json.some((m) => m.content === 'hello from visitor'))

  // Inject a private note via admin path + confirm the visitor cannot see it.
  await call('POST', `/accounts/${accountId}/conversations/${conv1}/messages`, {
    token,
    expect: 201,
    body: { content: 'internal note — visitor must not see this', isPrivate: true, attachmentIds: [] },
  })
  const list2 = await call('GET', `/widget/${hash}/messages?visitorToken=${visitor1Token}`, {
    expect: 200,
  })
  ok(
    'private note filtered from visitor list',
    !list2.json.some((m) => (m.content ?? '').includes('internal note')),
  )

  // Public reply from agent → visitor SHOULD see it.
  await call('POST', `/accounts/${accountId}/conversations/${conv1}/messages`, {
    token,
    expect: 201,
    body: { content: 'agent public reply', attachmentIds: [] },
  })
  const list3 = await call('GET', `/widget/${hash}/messages?visitorToken=${visitor1Token}`, {
    expect: 200,
  })
  ok(
    'visitor sees agent public reply',
    list3.json.some((m) => m.content === 'agent public reply'),
  )

  // Bad token → 400 on POST.
  const badToken = await call('POST', `/widget/${hash}/messages`, {
    expect: 400,
    body: { visitorToken: 'definitely-not-a-real-jwt-just-text', content: 'hi' },
  })
  ok('garbage token returns 400', badToken.status === 400)

  // Wrong-hash token → 400.
  const inbox2 = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Web2',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'Test2' },
    },
  })
  const wrong = await call('POST', `/widget/${inbox2.json.channelConfig.widgetHash}/messages`, {
    expect: 400,
    body: { visitorToken: visitor1Token, content: 'crossing widgets' },
  })
  ok('cross-widget token returns 400', wrong.status === 400)

  // Re-using same visitorId reuses the conversation.
  const sess2 = await call('POST', `/widget/${hash}/sessions`, {
    expect: 201,
    body: { visitorId: 'visitor-aaaaaaaa' },
  })
  ok(
    'reusing visitorId reuses conversation',
    sess2.json.conversationId === sameOrigin.json.conversationId,
  )

  // embed.js → 200 + JS body.
  const embed = await call('GET', `/widget/${hash}/embed.js`, { expect: 200 })
  ok('embed.js contains widget code', embed.text.includes('window.Cosmika'))

  // Validation: empty content → 400.
  const empty = await call('POST', `/widget/${hash}/messages`, {
    expect: 400,
    body: { visitorToken: visitor1Token, content: '' },
  })
  ok('empty message returns 400', empty.status === 400)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
