#!/usr/bin/env node
// E2E smoke test for Module 5 (AI Orchestrator).
// Requires api running with COSMIKA_AI_STUB=1 (deterministic test stub).
// Run: pnpm e2e:ai

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const adminEmail = `e2e-ai-${suffix}@cosmika.test`
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

async function setup() {
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: adminEmail,
      password,
      fullName: 'AI Admin',
      accountName: `AI E2E ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id

  // Create a bot with low daily budget so we can test fallback.
  const bot = await call('POST', `/accounts/${accountId}/agent-bots`, {
    token,
    expect: 201,
    body: {
      name: 'Test Bot',
      systemPrompt: 'You are a helpful test bot.',
      model: 'claude-haiku-4-5',
      dailyBudgetUsd: 0.01,
    },
  })
  ok('bot defaults model', bot.json.model === 'claude-haiku-4-5')
  ok('bot fallbackToHuman defaults true', bot.json.fallbackToHuman === true)
  ok('bot dailyBudget set', bot.json.dailyBudgetUsd === 0.01)

  // Inbox + contact + conversation.
  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'AI Inbox',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'AI Test' },
    },
  })

  // Attach bot via PATCH agentBotId + set autoreply mode.
  const patched = await call('PATCH', `/accounts/${accountId}/inboxes/${inbox.json.id}`, {
    token,
    expect: 200,
    body: { agentBotId: bot.json.id, aiAutoreplyMode: 'AUTO_FULL' },
  })
  ok('inbox agentBotId set via PATCH', patched.json.agentBotId === bot.json.id)
  ok('inbox aiAutoreplyMode set', patched.json.aiAutoreplyMode === 'AUTO_FULL')

  // Try attaching an unknown bot → 404.
  const bad = await call('PATCH', `/accounts/${accountId}/inboxes/${inbox.json.id}`, {
    token,
    expect: 404,
    body: { agentBotId: 'cmp_unknown' },
  })
  ok('unknown agentBotId returns 404', bad.status === 404)

  // Creating an inbox does not enrol its creator; a handoff needs a member
  // of the inbox to land on.
  await call('POST', `/accounts/${accountId}/inboxes/${inbox.json.id}/members`, {
    token,
    expect: 201,
    body: { userId: signUp.json.user.id },
  })

  const contact = await call('POST', `/accounts/${accountId}/contacts`, {
    token,
    expect: 201,
    body: { name: 'AI Tester', email: 'tester@ai.test' },
  })

  const conv = await call('POST', `/accounts/${accountId}/conversations`, {
    token,
    expect: 201,
    body: { contactId: contact.json.id, inboxId: inbox.json.id },
  })

  // A conversation opened by an agent through the API starts under HUMAN
  // control, where the bot only ever writes private drafts. The channels
  // (widget, WhatsApp) open theirs under BOT control when the inbox has a bot
  // in an auto-reply mode, so do the same here.
  const botDriven = await call('PATCH', `/accounts/${accountId}/conversations/${conv.json.id}`, {
    token,
    expect: 200,
    body: { controlMode: 'BOT' },
  })
  ok('conversation under BOT control', botDriven.json.controlMode === 'BOT')

  return {
    token,
    accountId,
    userId: signUp.json.user.id,
    botId: bot.json.id,
    inboxId: inbox.json.id,
    contactId: contact.json.id,
    conversationId: conv.json.id,
  }
}

async function main() {
  console.log(`E2E AI smoke against ${API}`)

  const ctx = await setup()

  // AUTO_FULL: inbound triggers bot to send AGENT_BOT reply.
  await call('POST', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages/inbound`, {
    token: ctx.token,
    expect: 201,
    body: { content: 'Hello, can you help?' },
  })
  await new Promise((r) => setTimeout(r, 200))

  const msgs1 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages`, {
    token: ctx.token,
    expect: 200,
  })
  const senderTypes = msgs1.json.data.map((m) => m.senderType)
  ok('inbound message persisted (CONTACT)', senderTypes.includes('CONTACT'))
  // Public, not a draft: a private "[draft] ..." row is AGENT_BOT too.
  const botReply = msgs1.json.data.find((m) => m.senderType === 'AGENT_BOT')
  ok(
    'AUTO_FULL bot reply sent to the contact (AGENT_BOT, public)',
    botReply?.isPrivate === false && !botReply.content.startsWith('[draft]'),
    JSON.stringify(botReply ?? null),
  )

  // AI session view shows the session + token usage.
  const view1 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/ai`, {
    token: ctx.token,
    expect: 200,
  })
  ok('AI session created', view1.json.session !== null)
  ok(
    'tokens tracked',
    view1.json.session.totalTokensOut > 0 && view1.json.session.totalCostUsd > 0,
  )

  // Non-destructive tool runs immediately.
  await call('POST', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages/inbound`, {
    token: ctx.token,
    expect: 201,
    body: { content: 'STUB_USE_TOOL please tag this conversation' },
  })
  await new Promise((r) => setTimeout(r, 200))

  const conv2 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}`, {
    token: ctx.token,
    expect: 200,
  })
  ok('attach_tag non-destructive ran', conv2.json.aiTags.includes('stubbed'))

  const view2 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/ai`, {
    token: ctx.token,
    expect: 200,
  })
  const successCalls = view2.json.recentToolCalls.filter(
    (c) => c.status === 'SUCCESS',
  )
  ok('SUCCESS tool call recorded', successCalls.length >= 1)

  // Handing off to a human runs straight away. It used to be queued for
  // approval, which left the contact waiting on a person to approve calling a
  // person; no built-in tool needs approval any more. Approving and rejecting
  // is covered where it still applies, on a custom tool, in e2e-ai-extras.mjs.
  await call('POST', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages/inbound`, {
    token: ctx.token,
    expect: 201,
    body: { content: 'STUB_ASSIGN_HUMAN please' },
  })
  await new Promise((r) => setTimeout(r, 200))

  const view3 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/ai`, {
    token: ctx.token,
    expect: 200,
  })
  const handoff = view3.json.recentToolCalls.find(
    (c) => c.toolName === 'assign_conversation_to_human',
  )
  ok('handoff tool ran without approval (SUCCESS)', handoff?.status === 'SUCCESS', `status=${handoff?.status}`)
  ok(
    'nothing left PENDING',
    view3.json.recentToolCalls.every((c) => c.status !== 'PENDING'),
  )

  const conv3 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}`, {
    token: ctx.token,
    expect: 200,
  })
  ok('needs-human tag added', conv3.json.aiTags.includes('needs-human'))
  // Nobody here has a schedule saved, so nobody is on shift. A handoff still
  // lands on a member of the inbox rather than on nobody.
  ok(
    'handoff routed to the inbox member (off-shift fallback)',
    handoff?.output?.agentAssigned === true && conv3.json.assigneeId === ctx.userId,
    `agentAssigned=${handoff?.output?.agentAssigned} assigneeId=${conv3.json.assigneeId}`,
  )

  // Budget cap: STUB_BIG_RESPONSE burns 1M output tokens, far past the bot's
  // $0.01 daily budget. The next inbound must not reach the model: the desk
  // gets a SYSTEM notice and the conversation goes to a human.
  await call('POST', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages/inbound`, {
    token: ctx.token,
    expect: 201,
    body: { content: 'STUB_BIG_RESPONSE please give me lots of tokens' },
  })
  await new Promise((r) => setTimeout(r, 200))

  await call('POST', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages/inbound`, {
    token: ctx.token,
    expect: 201,
    body: { content: 'Hello, are you still there?' },
  })
  await new Promise((r) => setTimeout(r, 200))

  const msgs3 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages`, {
    token: ctx.token,
    expect: 200,
  })
  // The notice is written in the account's language (pt-BR by default).
  const budgetNotice =
    /Daily AI budget exceeded|Orçamento diário de IA excedido|Presupuesto diario de IA excedido/
  const budgetMsg = msgs3.json.data.find(
    (m) => m.senderType === 'SYSTEM' && budgetNotice.test(m.content ?? ''),
  )
  ok('budget-exceeded SYSTEM message inserted', !!budgetMsg)
  const conv4 = await call('GET', `/accounts/${ctx.accountId}/conversations/${ctx.conversationId}`, {
    token: ctx.token,
    expect: 200,
  })
  ok(
    'over budget hands control to a human',
    conv4.json.controlMode === 'HUMAN',
    `controlMode=${conv4.json.controlMode}`,
  )

  // Bot cost was tracked.
  const bot2 = await call('GET', `/accounts/${ctx.accountId}/agent-bots/${ctx.botId}`, {
    token: ctx.token,
    expect: 200,
  })
  ok('bot cost tracked > 0', bot2.json.costLast24hUsd > 0)

  // Outsider ACL on agent-bots.
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-ai-out-${suffix}@cosmika.test`,
      password,
      fullName: 'Outsider',
      accountName: 'Outsider Co',
    },
  })
  const outList = await call(
    'GET',
    `/accounts/${ctx.accountId}/agent-bots`,
    { token: outsider.json.session.token, expect: 403 },
  )
  ok('outsider list returns 403', outList.status === 403)

  // Delete agent-bot detaches from inboxes (Inbox.agentBotId becomes null).
  await call('DELETE', `/accounts/${ctx.accountId}/agent-bots/${ctx.botId}`, {
    token: ctx.token,
    expect: 204,
  })
  const inboxAfter = await call(
    'GET',
    `/accounts/${ctx.accountId}/inboxes/${ctx.inboxId}`,
    { token: ctx.token, expect: 200 },
  )
  ok('inbox.agentBotId nulled after bot delete', inboxAfter.json.agentBotId === null)

  // Unauthenticated guard.
  const unauth = await call('GET', `/accounts/${ctx.accountId}/agent-bots`, {
    expect: 401,
  })
  ok('unauthenticated bot list returns 401', unauth.status === 401)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
