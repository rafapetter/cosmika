#!/usr/bin/env node
// E2E for the AI extras added after Module 5:
//   - AUTO_SAFE confidence gating
//   - built-in tools (set_priority, add_internal_note, attach_tag)
//   - Custom tools via webhook: one that runs straight away, and a
//     destructive one that waits for a human to approve or reject it
//
// Requires cosmika-api with COSMIKA_AI_STUB=1.

import { createServer } from 'node:http'

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
  if (text) { try { json = JSON.parse(text) } catch { /* keep raw */ } }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status}: ${text}`)
  }
  return { status: res.status, json }
}

async function main() {
  console.log(`E2E ai-extras smoke against ${API}`)

  // ── Spin up a local webhook for custom tool tests ────────────────
  const webhookCalls = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        const body = JSON.parse(raw)
        webhookCalls.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify(
            body.tool === 'refund_order'
              ? { refunded: true }
              : { creditScore: 712, tier: 'GOLD' },
          ),
        )
      } catch {
        res.writeHead(500); res.end()
      }
    })
  })
  // By name, not by address: the API refuses to call a tool webhook on a
  // loopback or private IP, and lets `localhost` through outside production.
  // No bind host either, so it answers whichever of 127.0.0.1 and ::1 the
  // API resolves `localhost` to.
  await new Promise((resolve) => server.listen(0, resolve))
  const port = server.address().port
  const webhookUrl = `http://localhost:${port}/`

  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-ai-extras-${suffix}@cosmika.test`,
      password,
      fullName: 'Admin',
      accountName: `AI ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id

  // Bot with all built-in tools + 2 custom tools + AUTO_SAFE threshold low
  // enough that empty/short replies auto-send (stub returns short replies).
  const bot = await call('POST', `/accounts/${accountId}/agent-bots`, {
    token,
    expect: 201,
    body: {
      name: 'Triage bot',
      systemPrompt: 'You help customers.',
      autoSafeConfidenceThreshold: 50,
      toolsEnabled: [
        { name: 'attach_tag' },
        { name: 'set_priority' },
        { name: 'add_internal_note' },
        { name: 'lookup_credit_score' }, // custom
      ],
      customTools: [
        {
          name: 'lookup_credit_score',
          description: 'Look up the customer credit score',
          input_schema: {
            type: 'object',
            properties: { customerId: { type: 'string' } },
          },
          webhook: { url: webhookUrl, method: 'POST' },
        },
        {
          name: 'refund_order',
          description: 'Refund the customer order',
          input_schema: {
            type: 'object',
            properties: { orderId: { type: 'string' } },
          },
          webhook: { url: webhookUrl, method: 'POST' },
          // Needs a human to approve it before it runs.
          destructive: true,
        },
      ],
    },
  })
  ok('bot created w/ autoSafeConfidenceThreshold', bot.json.autoSafeConfidenceThreshold === 50)
  ok('bot persisted customTools', bot.json.customTools.length === 2)

  // Inbox in AUTO_SAFE mode with this bot
  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Site',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'S' },
      aiAutoreplyMode: 'AUTO_SAFE',
    },
  })
  await call('PATCH', `/accounts/${accountId}/inboxes/${inbox.json.id}`, {
    token,
    expect: 200,
    body: { agentBotId: bot.json.id },
  })

  const contact = await call('POST', `/accounts/${accountId}/contacts`, {
    token,
    expect: 201,
    body: { name: 'C', email: 'c@example.com' },
  })

  // A conversation opened by an agent through the API starts under HUMAN
  // control, where the bot only ever writes private drafts whatever the mode
  // or the score. The channels (widget, WhatsApp) open theirs under BOT
  // control on an inbox like this one, so do the same: only then is AUTO_SAFE
  // the thing deciding between sending and drafting.
  const openBotConversation = async () => {
    const created = await call('POST', `/accounts/${accountId}/conversations`, {
      token,
      expect: 201,
      body: { contactId: contact.json.id, inboxId: inbox.json.id },
    })
    await call('PATCH', `/accounts/${accountId}/conversations/${created.json.id}`, {
      token,
      expect: 200,
      body: { controlMode: 'BOT' },
    })
    return created
  }

  // Trigger an inbound — orchestrator runs in stub mode, AUTO_SAFE decides
  const conv = await openBotConversation()
  await call(
    'POST',
    `/accounts/${accountId}/conversations/${conv.json.id}/messages/inbound`,
    {
      token,
      expect: 201,
      body: { content: 'I have a question', senderType: 'CONTACT' },
    },
  )

  // The stub returns a short text reply. With threshold=50 and no tools used,
  // confidence (80) ≥ 50 so it should auto-send (not be a draft).
  const msgs = await call(
    'GET',
    `/accounts/${accountId}/conversations/${conv.json.id}/messages`,
    { token, expect: 200 },
  )
  const aiMsgs = msgs.json.data.filter((m) => m.senderType === 'AGENT_BOT')
  ok('AI response was created', aiMsgs.length >= 1)
  const sent = aiMsgs.find((m) => !m.isPrivate)
  ok(
    'AUTO_SAFE auto-sent a reply scoring above the threshold',
    !!sent,
    sent ? '' : 'no public AI reply found',
  )

  // Now flip the threshold to 90 and use the STUB_UNCERTAIN marker to force
  // the stub to return an uncertain reply (two hedging phrases, score = 20).
  await call(
    'PATCH',
    `/accounts/${accountId}/agent-bots/${bot.json.id}`,
    {
      token,
      expect: 200,
      body: { autoSafeConfidenceThreshold: 90 },
    },
  )
  const conv2 = await openBotConversation()
  await call(
    'POST',
    `/accounts/${accountId}/conversations/${conv2.json.id}/messages/inbound`,
    {
      token,
      expect: 201,
      body: { content: 'STUB_UNCERTAIN — vague question', senderType: 'CONTACT' },
    },
  )
  const msgs2 = await call(
    'GET',
    `/accounts/${accountId}/conversations/${conv2.json.id}/messages`,
    { token, expect: 200 },
  )
  const ai2 = msgs2.json.data.find((m) => m.senderType === 'AGENT_BOT')
  ok(
    'high threshold falls back to DRAFT',
    ai2?.isPrivate === true,
    `isPrivate=${ai2?.isPrivate}`,
  )
  ok(
    'DRAFT prefixed with [draft]',
    ai2?.content?.startsWith('[draft]') === true,
  )

  // ── Custom tools: run, wait for approval, reject, approve ─────────
  // STUB_CALL_TOOL:<name> makes the stub call the tool with that name, which
  // is the only way to reach a custom tool: its name is the bot's to choose.
  const say = (conversationId, content) =>
    call('POST', `/accounts/${accountId}/conversations/${conversationId}/messages/inbound`, {
      token,
      expect: 201,
      body: { content, senderType: 'CONTACT' },
    })
  const toolCallsOf = async (conversationId) => {
    const view = await call('GET', `/accounts/${accountId}/conversations/${conversationId}/ai`, {
      token,
      expect: 200,
    })
    return view.json.recentToolCalls
  }
  const decide = (conversationId, toolCallIds, decision) =>
    call('POST', `/accounts/${accountId}/conversations/${conversationId}/ai/confirm-tool-calls`, {
      token,
      expect: 201,
      body: { toolCallIds, decision },
    })
  const webhookCallsFor = (tool) => webhookCalls.filter((c) => c.tool === tool)

  // A plain custom tool runs as soon as the model asks for it.
  const conv3 = await openBotConversation()
  await say(conv3.json.id, 'STUB_CALL_TOOL:lookup_credit_score')
  const lookups = webhookCallsFor('lookup_credit_score')
  ok('custom tool called its webhook once', lookups.length === 1, `calls=${lookups.length}`)
  ok(
    'webhook got the tool input and the conversation',
    lookups[0]?.input?.source === 'stub' &&
      lookups[0]?.context?.conversationId === conv3.json.id,
    JSON.stringify(lookups[0] ?? null),
  )
  const lookup = (await toolCallsOf(conv3.json.id)).find(
    (c) => c.toolName === 'lookup_credit_score',
  )
  ok(
    'custom tool recorded SUCCESS with the webhook answer',
    lookup?.status === 'SUCCESS' && lookup.output?.creditScore === 712,
    JSON.stringify(lookup ?? null),
  )

  // A destructive one is queued instead, and nothing leaves the API.
  const conv4 = await openBotConversation()
  await say(conv4.json.id, 'STUB_CALL_TOOL:refund_order')
  const queued = (await toolCallsOf(conv4.json.id)).filter((c) => c.status === 'PENDING')
  ok(
    'destructive custom tool queued PENDING',
    queued.length === 1 && queued[0].toolName === 'refund_order',
    JSON.stringify(queued),
  )
  ok('queued tool did not call the webhook', webhookCallsFor('refund_order').length === 0)
  const msgs4 = await call(
    'GET',
    `/accounts/${accountId}/conversations/${conv4.json.id}/messages`,
    { token, expect: 200 },
  )
  ok(
    'SYSTEM message tells the desk an approval is pending',
    msgs4.json.data.some((m) => m.senderType === 'SYSTEM'),
  )

  // REJECT settles the call without ever running it.
  const rejected = await decide(conv4.json.id, queued.map((c) => c.id), 'REJECT')
  ok(
    'REJECT returns REJECTED',
    rejected.json.length === 1 && rejected.json[0].status === 'REJECTED',
    JSON.stringify(rejected.json),
  )
  ok('REJECT did not call the webhook', webhookCallsFor('refund_order').length === 0)

  // CONFIRM runs it: the webhook is called and its answer is stored.
  await say(conv4.json.id, 'STUB_CALL_TOOL:refund_order again')
  const queued2 = (await toolCallsOf(conv4.json.id)).filter((c) => c.status === 'PENDING')
  ok('second destructive call queued PENDING', queued2.length === 1, JSON.stringify(queued2))
  const confirmed = await decide(conv4.json.id, queued2.map((c) => c.id), 'CONFIRM')
  ok(
    'CONFIRM returns CONFIRMED with the webhook answer',
    confirmed.json.length === 1 &&
      confirmed.json[0].status === 'CONFIRMED' &&
      confirmed.json[0].output?.refunded === true,
    JSON.stringify(confirmed.json),
  )
  const refunds = webhookCallsFor('refund_order')
  ok('CONFIRM called the webhook once', refunds.length === 1, `calls=${refunds.length}`)
  ok(
    'webhook got the queued input and the conversation',
    refunds[0]?.input?.source === 'stub' &&
      refunds[0]?.context?.conversationId === conv4.json.id,
    JSON.stringify(refunds[0] ?? null),
  )

  // A settled call is no longer PENDING, so approving it again runs nothing.
  const again = await decide(conv4.json.id, queued2.map((c) => c.id), 'CONFIRM')
  ok(
    'approving twice does not run the tool twice',
    again.json.length === 0 && webhookCallsFor('refund_order').length === 1,
    JSON.stringify(again.json),
  )

  server.close()

  // ── Confirm custom tool name is exposed on the bot DTO ────────────
  const fetched = await call(
    'GET',
    `/accounts/${accountId}/agent-bots/${bot.json.id}`,
    { token, expect: 200 },
  )
  ok('custom tool persisted', fetched.json.customTools[0]?.name === 'lookup_credit_score')

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
