#!/usr/bin/env node
// E2E smoke test for Module 4 (Conversations & Messages).
// Drives the api via fetch. Requires api running on $API_URL (default http://localhost:3110).
// Run: pnpm e2e:conversations

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const adminEmail = `e2e-conv-${suffix}@cosmika.test`
const outsiderEmail = `e2e-conv-out-${suffix}@cosmika.test`
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
  console.log(`E2E conversations smoke against ${API}`)

  // sign-up admin
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: adminEmail,
      password,
      fullName: 'Conv Admin',
      accountName: `Conv E2E ${suffix}`,
    },
  })
  const adminToken = signUp.json.session.token
  const accountId = signUp.json.account.id

  // setup: create inbox + contact
  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token: adminToken,
    expect: 201,
    body: {
      name: 'Site',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'Conv Co' },
    },
  })
  const inboxId = inbox.json.id

  const contact = await call('POST', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 201,
    body: { name: 'Carol', email: 'carol@example.com' },
  })
  const contactId = contact.json.id

  // empty list
  const empty = await call('GET', `/accounts/${accountId}/conversations`, {
    token: adminToken,
    expect: 200,
  })
  ok('empty conversation list', Array.isArray(empty.json.data) && empty.json.data.length === 0)

  // create conversation with initial USER message
  const conv1 = await call('POST', `/accounts/${accountId}/conversations`, {
    token: adminToken,
    expect: 201,
    body: {
      contactId,
      inboxId,
      sourceId: 'widget-visitor-abc',
      initialMessage: {
        senderType: 'USER',
        content: 'Hello Carol, how can we help?',
      },
    },
  })
  ok('conv created OPEN', conv1.json.status === 'OPEN')
  ok('initial USER message sets firstReplyAt', conv1.json.firstReplyAt !== null)
  ok('agentLastSeenAt set', conv1.json.agentLastSeenAt !== null)
  const convId = conv1.json.id

  // GET detail
  const detail = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convId}`,
    { token: adminToken, expect: 200 },
  )
  ok('detail contains contact', detail.json.contact?.name === 'Carol')
  ok('detail contains inbox', detail.json.inbox?.id === inboxId)
  ok('detail messageCount', detail.json.messageCount === 1)
  ok('detail participants empty', detail.json.participants.length === 0)

  // list messages
  const msgs1 = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convId}/messages`,
    { token: adminToken, expect: 200 },
  )
  ok('msgs1 has 1 USER message', msgs1.json.data.length === 1)
  ok(
    'initial message senderType',
    msgs1.json.data[0].senderType === 'USER',
  )

  // send agent message (private note)
  const note = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/messages`,
    {
      token: adminToken,
      expect: 201,
      body: { content: 'Internal note: VIP customer', isPrivate: true },
    },
  )
  ok('private note created', note.json.isPrivate === true)
  ok('private note senderType', note.json.senderType === 'USER')

  // send agent message (public)
  const reply = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/messages`,
    {
      token: adminToken,
      expect: 201,
      body: { content: "Sorry for the wait, I'm on it." },
    },
  )
  ok('public reply created', reply.json.isPrivate === false)

  // attachments rejected
  const att = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/messages`,
    {
      token: adminToken,
      expect: 400,
      body: { content: 'with file', attachmentIds: ['fake'] },
    },
  )
  ok('attachments rejected at validation', att.status === 400)

  // inbound message (admin-only)
  const inbound = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/messages/inbound`,
    {
      token: adminToken,
      expect: 201,
      body: { content: 'Hi! I need help.', externalSourceId: 'widget-1' },
    },
  )
  ok('inbound senderType', inbound.json.senderType === 'CONTACT')
  ok('inbound externalSourceId', inbound.json.externalSourceId === 'widget-1')

  // update priority + status (a conversation in progress moves freely
  // between OPEN and PENDING)
  const pending = await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${convId}`,
    {
      token: adminToken,
      expect: 200,
      body: { status: 'PENDING', priority: 'HIGH' },
    },
  )
  ok('status PENDING applied', pending.json.status === 'PENDING')
  ok('priority HIGH applied', pending.json.priority === 'HIGH')
  ok('resolvedAt still null', pending.json.resolvedAt === null)
  const backToOpen = await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${convId}`,
    { token: adminToken, expect: 200, body: { status: 'OPEN' } },
  )
  ok('PENDING back to OPEN applied', backToOpen.json.status === 'OPEN')
  ok('reopenedAt untouched by PENDING→OPEN', backToOpen.json.reopenedAt === null)

  // assign to admin
  const assigned = await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${convId}`,
    {
      token: adminToken,
      expect: 200,
      body: { assigneeId: signUp.json.user.id },
    },
  )
  ok('assignee set', assigned.json.assigneeId === signUp.json.user.id)

  // assignee to unknown user → 404
  const assignUnknown = await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${convId}`,
    {
      token: adminToken,
      expect: 404,
      body: { assigneeId: 'cmp_unknown' },
    },
  )
  ok('assignee to unknown returns 404', assignUnknown.status === 404)

  // unassign
  const unassigned = await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${convId}`,
    {
      token: adminToken,
      expect: 200,
      body: { assigneeId: null },
    },
  )
  ok('assignee cleared', unassigned.json.assigneeId === null)

  // participants — add admin
  const part = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/participants`,
    {
      token: adminToken,
      expect: 201,
      body: { userId: signUp.json.user.id },
    },
  )
  ok('participant added', part.json.userId === signUp.json.user.id)

  const dupPart = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/participants`,
    {
      token: adminToken,
      expect: 409,
      body: { userId: signUp.json.user.id },
    },
  )
  ok('duplicate participant returns 409', dupPart.status === 409)

  const rmPart = await call(
    'DELETE',
    `/accounts/${accountId}/conversations/${convId}/participants/${signUp.json.user.id}`,
    { token: adminToken, expect: 204 },
  )
  ok('participant removed', rmPart.status === 204)

  const rmMissing = await call(
    'DELETE',
    `/accounts/${accountId}/conversations/${convId}/participants/${signUp.json.user.id}`,
    { token: adminToken, expect: 404 },
  )
  ok('removing missing participant returns 404', rmMissing.status === 404)

  // search messages
  const search = await call(
    'GET',
    `/accounts/${accountId}/conversations?q=internal+note`,
    { token: adminToken, expect: 200 },
  )
  ok('search returns convo', search.json.data.length === 1)

  // filter by status
  const openOnly = await call(
    'GET',
    `/accounts/${accountId}/conversations?status=OPEN`,
    { token: adminToken, expect: 200 },
  )
  ok('OPEN filter returns convo', openOnly.json.data.length === 1)

  const resolvedOnly = await call(
    'GET',
    `/accounts/${accountId}/conversations?status=RESOLVED`,
    { token: adminToken, expect: 200 },
  )
  ok('RESOLVED filter empty (nothing closed yet)', resolvedOnly.json.data.length === 0)

  // filter by inbox
  const inboxFilter = await call(
    'GET',
    `/accounts/${accountId}/conversations?inboxId=${inboxId}`,
    { token: adminToken, expect: 200 },
  )
  ok('inbox filter matches', inboxFilter.json.data.length === 1)

  // create a second conversation reusing same contact + inbox
  // (should reuse ContactInbox via uniqueness)
  const conv2 = await call('POST', `/accounts/${accountId}/conversations`, {
    token: adminToken,
    expect: 201,
    body: { contactId, inboxId },
  })
  ok(
    'reused contactInbox id',
    conv2.json.contactInboxId === conv1.json.contactInboxId,
  )

  // create with unknown contact → 404
  const ghost = await call('POST', `/accounts/${accountId}/conversations`, {
    token: adminToken,
    expect: 404,
    body: { contactId: 'cmp_unknown', inboxId },
  })
  ok('unknown contact returns 404', ghost.status === 404)

  // Outsider ACL — cannot list, cannot create
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: outsiderEmail,
      password,
      fullName: 'Outsider',
      accountName: 'Outsider Co',
    },
  })
  const outsiderToken = outsider.json.session.token
  const outList = await call(
    'GET',
    `/accounts/${accountId}/conversations`,
    { token: outsiderToken, expect: 403 },
  )
  ok('outsider list returns 403', outList.status === 403)
  const outGet = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convId}`,
    { token: outsiderToken, expect: 403 },
  )
  ok('outsider get returns 403', outGet.status === 403)

  // Unauthenticated
  const unauth = await call(
    'GET',
    `/accounts/${accountId}/conversations`,
    { expect: 401 },
  )
  ok('unauthenticated list returns 401', unauth.status === 401)

  // ── A closed conversation is never reopened (Terms 4.2) ────────────
  const resolved = await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${convId}`,
    { token: adminToken, expect: 200, body: { status: 'RESOLVED' } },
  )
  ok('status RESOLVED applied', resolved.json.status === 'RESOLVED')
  ok('resolvedAt set', resolved.json.resolvedAt !== null)
  ok('reopenedAt still null', resolved.json.reopenedAt === null)

  const closedReply = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/messages`,
    { token: adminToken, expect: 409, body: { content: 'One more thing...' } },
  )
  ok('reply into a closed conversation returns 409', closedReply.status === 409)
  ok('409 carries conversation_closed', closedReply.json?.code === 'conversation_closed')

  const closedNote = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/messages`,
    { token: adminToken, expect: 201, body: { content: 'ligou depois', isPrivate: true } },
  )
  ok('internal note on a closed conversation still accepted', closedNote.json.isPrivate === true)

  const closedInbound = await call(
    'POST',
    `/accounts/${accountId}/conversations/${convId}/messages/inbound`,
    { token: adminToken, expect: 409, body: { content: 'again', externalSourceId: 'widget-closed' } },
  )
  ok('recorded inbound into a closed conversation returns 409', closedInbound.json?.code === 'conversation_closed')

  for (const next of ['OPEN', 'PENDING']) {
    const reopen = await call(
      'PATCH',
      `/accounts/${accountId}/conversations/${convId}`,
      { token: adminToken, expect: 409, body: { status: next } },
    )
    ok(`RESOLVED→${next} returns 409 conversation_closed`, reopen.json?.code === 'conversation_closed')
  }

  const bulkReopen = await call('POST', `/accounts/${accountId}/conversations/bulk`, {
    token: adminToken,
    body: { ids: [convId], action: { type: 'STATUS', status: 'OPEN' } },
  })
  ok('bulk "mark open" skips the closed conversation', bulkReopen.json?.updated === 0)

  const stillClosed = await call(
    'GET',
    `/accounts/${accountId}/conversations/${convId}`,
    { token: adminToken, expect: 200 },
  )
  ok('conversation is still RESOLVED after every attempt', stillClosed.json.status === 'RESOLVED')
  ok('reopenedAt never set', stillClosed.json.reopenedAt === null)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
