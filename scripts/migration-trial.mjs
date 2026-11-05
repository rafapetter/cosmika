#!/usr/bin/env node
// Migration trial: an end-to-end smoke that exercises every path a real
// customer would use right after a deploy. Run as a post-deploy gate.
//
// Verifies:
//   1. /ready on api + realtime (downstreams reachable)
//   2. Sign-up creates an Account
//   3. Inbox + AI agent CRUD + bot↔inbox attach
//   4. Public widget endpoints land messages
//   5. AI orchestrator replies (using COSMIKA_AI_STUB=1)
//   6. Admin api lists the conversation + reads the messages
//   7. Realtime gateway pushes MessageCreated within 2s
//
// Run: pnpm migration-trial   (no args; reads API/REALTIME from env)

import WebSocket from 'ws'

const API = process.env.API_URL ?? 'http://localhost:3110'
const REALTIME = process.env.REALTIME_URL ?? 'ws://localhost:3120/ws'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

let pass = 0
let fail = 0

function ok(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  ✓  ${label}`)
  } else {
    fail += 1
    console.log(`  ✗  ${label}` + (detail ? ` — ${detail}` : ''))
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
    throw new Error(`${method} ${path} expected ${expect} got ${res.status}: ${text}`)
  }
  return { status: res.status, json }
}

function nextEvent(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const handler = (raw) => {
      try {
        const m = JSON.parse(raw.toString())
        if (predicate(m)) {
          ws.off('message', handler)
          clearTimeout(timer)
          resolve(m)
        }
      } catch {
        // ignore
      }
    }
    const timer = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('timeout waiting for realtime event'))
    }, timeoutMs)
    ws.on('message', handler)
  })
}

async function main() {
  console.log(`Cosmika migration trial`)
  console.log(`  api=${API}`)
  console.log(`  realtime=${REALTIME}`)
  console.log('')

  console.log('▸ Probes')
  const apiReady = await fetch(`${API}/ready`)
  ok(
    'api /ready returns 200',
    apiReady.status === 200,
    `got ${apiReady.status}`,
  )
  const apiReadyBody = await apiReady.json()
  ok('api postgres ok', apiReadyBody.checks?.postgres?.ok === true)
  ok('api redis ok', apiReadyBody.checks?.redis?.ok === true)

  const realtimeReady = await fetch(
    REALTIME.replace(/^ws/, 'http').replace(/\/ws$/, '/ready'),
  )
  ok(
    'realtime /ready returns 200',
    realtimeReady.status === 200,
    `got ${realtimeReady.status}`,
  )

  console.log('\n▸ Account + admin auth')
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `trial-${suffix}@cosmika.test`,
      password: 'correct-horse-battery',
      fullName: 'Trial Admin',
      accountName: `Trial ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id
  ok('sign-up created account', typeof accountId === 'string')

  console.log('\n▸ Widget inbox + AI bot wiring')
  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Trial Web',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'Trial' },
    },
  })
  const widgetHash = inbox.json.channelConfig.widgetHash
  ok('widget inbox has widgetHash', typeof widgetHash === 'string')

  const bot = await call('POST', `/accounts/${accountId}/agent-bots`, {
    token,
    expect: 201,
    body: {
      name: 'Trial Bot',
      systemPrompt: 'You are a helpful trial bot.',
      model: 'claude-haiku-4-5',
      dailyBudgetUsd: 5.0,
    },
  })
  const patched = await call('PATCH', `/accounts/${accountId}/inboxes/${inbox.json.id}`, {
    token,
    expect: 200,
    body: { agentBotId: bot.json.id, aiAutoreplyMode: 'AUTO_FULL' },
  })
  ok('bot attached to inbox', patched.json.agentBotId === bot.json.id)

  console.log('\n▸ Open realtime WS')
  const ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`${REALTIME}?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 3000)
    sock.once('open', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  await nextEvent(ws, (m) => m.type === 'Connected')
  ok('realtime WS connected', true)

  console.log('\n▸ Visitor session via /widget')
  const widgetEventPromise = nextEvent(
    ws,
    (m) =>
      m.type === 'MessageCreated' &&
      m.senderType === 'CONTACT' &&
      (m.content ?? '').includes('Hi from the trial widget'),
  )
  const sess = await call('POST', `/widget/${widgetHash}/sessions`, {
    expect: 201,
    body: { name: 'Trial Visitor' },
  })
  ok('visitor session minted JWT', typeof sess.json.visitorToken === 'string')
  await call('POST', `/widget/${widgetHash}/messages`, {
    expect: 201,
    body: { visitorToken: sess.json.visitorToken, content: 'Hi from the trial widget' },
  })
  const widgetEvent = await widgetEventPromise
  ok('realtime pushed the inbound message', widgetEvent.conversationId === sess.json.conversationId)

  console.log('\n▸ AI orchestrator replied')
  // The stub answers with a generic "Thanks for reaching out…". Poll up to 1s.
  let botReply
  for (let i = 0; i < 5; i += 1) {
    const msgs = await call(
      'GET',
      `/widget/${widgetHash}/messages?visitorToken=${sess.json.visitorToken}`,
      { expect: 200 },
    )
    botReply = msgs.json.find(
      (m) => m.senderType === 'AGENT_BOT' && (m.content ?? '').length > 0,
    )
    if (botReply) break
    await new Promise((r) => setTimeout(r, 200))
  }
  ok('AGENT_BOT reply landed', !!botReply)

  console.log('\n▸ Admin api sees the conversation')
  const convs = await call(
    'GET',
    `/accounts/${accountId}/conversations?inboxId=${inbox.json.id}`,
    { token, expect: 200 },
  )
  ok('admin lists 1 conversation', convs.json.data.length === 1)
  const adminMsgs = await call(
    'GET',
    `/accounts/${accountId}/conversations/${sess.json.conversationId}/messages`,
    { token, expect: 200 },
  )
  ok(
    'admin sees both CONTACT + AGENT_BOT messages',
    adminMsgs.json.data.some((m) => m.senderType === 'CONTACT') &&
      adminMsgs.json.data.some((m) => m.senderType === 'AGENT_BOT'),
  )

  console.log('\n▸ Status change publishes')
  const statusPromise = nextEvent(
    ws,
    (m) =>
      m.type === 'ConversationStatusChanged' &&
      m.conversationId === sess.json.conversationId,
  )
  await call('PATCH', `/accounts/${accountId}/conversations/${sess.json.conversationId}`, {
    token,
    expect: 200,
    body: { status: 'RESOLVED' },
  })
  const statusEvent = await statusPromise
  ok('realtime pushed status change', statusEvent.status === 'RESOLVED')

  ws.close()

  console.log(`\nResult: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`\nMigration trial failed: ${err.message}`)
  process.exit(1)
})
