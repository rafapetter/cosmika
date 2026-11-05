#!/usr/bin/env node
// E2E smoke test for Module 6 realtime gateway.
// Requires `cosmika-api` on $API_URL and `cosmika-realtime` on $REALTIME_URL.
// Run: pnpm e2e:realtime

import WebSocket from 'ws'

const API = process.env.API_URL ?? 'http://localhost:3110'
const REALTIME = process.env.REALTIME_URL ?? 'ws://localhost:3120/ws'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const adminEmail = `e2e-rt-${suffix}@cosmika.test`
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
  const { token, body, expect } = opts
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

function openSocket(token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${REALTIME}?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('ws open timed out'))
    }, timeoutMs)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function nextMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const handler = (raw) => {
      try {
        const payload = JSON.parse(raw.toString())
        if (predicate(payload)) {
          ws.off('message', handler)
          clearTimeout(timer)
          resolve(payload)
        }
      } catch {
        // ignore
      }
    }
    const timer = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('timeout waiting for matching event'))
    }, timeoutMs)
    ws.on('message', handler)
  })
}

async function main() {
  console.log(`E2E realtime smoke against ${API} + ${REALTIME}`)

  // Reject when token missing.
  await new Promise((resolve) => {
    const ws = new WebSocket(`${REALTIME}?token=`)
    ws.once('error', () => {
      ok('rejects empty token', true)
      resolve()
    })
    ws.once('unexpected-response', (_req, res) => {
      ok('rejects empty token', res.statusCode === 401)
      ws.terminate()
      resolve()
    })
  })

  // Reject when token invalid.
  await new Promise((resolve) => {
    const ws = new WebSocket(`${REALTIME}?token=bogus`)
    ws.once('error', () => {
      ok('rejects bogus token', true)
      resolve()
    })
    ws.once('unexpected-response', (_req, res) => {
      ok('rejects bogus token', res.statusCode === 401)
      ws.terminate()
      resolve()
    })
  })

  // Real session.
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: adminEmail,
      password,
      fullName: 'A',
      accountName: `Rt ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id

  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Site',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'Rt' },
    },
  })
  const contact = await call('POST', `/accounts/${accountId}/contacts`, {
    token,
    expect: 201,
    body: { name: 'Visitor', email: `vis-${suffix}@example.com` },
  })
  const conv = await call('POST', `/accounts/${accountId}/conversations`, {
    token,
    expect: 201,
    body: { contactId: contact.json.id, inboxId: inbox.json.id },
  })

  const ws = await openSocket(token)

  // Hello / Connected event.
  const hello = await nextMessage(ws, (m) => m.type === 'Connected')
  ok('received Connected hello with accountId', hello.accountId === accountId)

  // Send an agent message → expect MessageCreated.
  const messagePromise = nextMessage(
    ws,
    (m) =>
      m.type === 'MessageCreated' &&
      m.conversationId === conv.json.id &&
      m.content === 'realtime push test',
  )
  await call('POST', `/accounts/${accountId}/conversations/${conv.json.id}/messages`, {
    token,
    expect: 201,
    body: { content: 'realtime push test', attachmentIds: [] },
  })
  const messageEvent = await messagePromise
  ok('received MessageCreated', messageEvent.senderType === 'USER')
  ok('MessageCreated includes inboxId', messageEvent.inboxId === inbox.json.id)
  ok('MessageCreated includes accountId', messageEvent.accountId === accountId)

  // Status change → ConversationStatusChanged.
  const statusPromise = nextMessage(
    ws,
    (m) => m.type === 'ConversationStatusChanged' && m.conversationId === conv.json.id,
  )
  await call('PATCH', `/accounts/${accountId}/conversations/${conv.json.id}`, {
    token,
    expect: 200,
    body: { status: 'RESOLVED' },
  })
  const statusEvent = await statusPromise
  ok('received ConversationStatusChanged', statusEvent.status === 'RESOLVED')

  // Inbound (admin path) → MessageCreated.
  const inboundPromise = nextMessage(
    ws,
    (m) =>
      m.type === 'MessageCreated' &&
      m.senderType === 'CONTACT' &&
      m.conversationId === conv.json.id,
  )
  await call('POST', `/accounts/${accountId}/conversations/${conv.json.id}/messages/inbound`, {
    token,
    expect: 201,
    body: { content: 'inbound from contact' },
  })
  const inboundEvent = await inboundPromise
  ok('received inbound MessageCreated', inboundEvent.content === 'inbound from contact')

  // Widget message also publishes.
  const widgetHash = inbox.json.channelConfig.widgetHash
  const sess = await call('POST', `/widget/${widgetHash}/sessions`, {
    expect: 201,
    body: { name: 'WidgetVisitor' },
  })
  const widgetPromise = nextMessage(
    ws,
    (m) =>
      m.type === 'MessageCreated' &&
      m.senderType === 'CONTACT' &&
      m.content === 'from the widget',
  )
  await call('POST', `/widget/${widgetHash}/messages`, {
    expect: 201,
    body: { visitorToken: sess.json.visitorToken, content: 'from the widget' },
  })
  const widgetEvent = await widgetPromise
  ok('widget message received over realtime', widgetEvent.content === 'from the widget')

  // Events scoped per-account: a different account's session must NOT see the above.
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-rt-out-${suffix}@cosmika.test`,
      password,
      fullName: 'Out',
      accountName: 'Out',
    },
  })
  const outsiderWs = await openSocket(outsider.json.session.token)
  await nextMessage(outsiderWs, (m) => m.type === 'Connected') // drain
  let leaked = false
  outsiderWs.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.type === 'MessageCreated') leaked = true
    } catch {
      // ignore
    }
  })
  await call('POST', `/accounts/${accountId}/conversations/${conv.json.id}/messages`, {
    token,
    expect: 201,
    body: { content: 'should not leak', attachmentIds: [] },
  })
  await new Promise((r) => setTimeout(r, 500))
  ok('outsider does not receive other account events', !leaked)

  ws.close()
  outsiderWs.close()

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
