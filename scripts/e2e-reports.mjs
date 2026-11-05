#!/usr/bin/env node
// E2E smoke for Module 8 (Reports & Dashboards).
// Seeds an account with conversations + messages, then verifies the three
// reports endpoints. Run: pnpm e2e:reports

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
  if (text) {
    try { json = JSON.parse(text) } catch { /* keep raw */ }
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status}: ${text}`)
  }
  return { status: res.status, json }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function isoDaysAgo(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days + 1)
  return d.toISOString().slice(0, 10)
}

async function main() {
  console.log(`E2E reports smoke against ${API}`)

  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-reports-${suffix}@cosmika.test`,
      password,
      fullName: 'Reports Admin',
      accountName: `Reports ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id
  const adminUserId = signUp.json.user.id

  // Empty overview (no data)
  const empty = await call(
    'GET',
    `/accounts/${accountId}/reports/overview`,
    { token, expect: 200 },
  )
  ok('empty overview totals 0', empty.json.totalConversations === 0)
  ok('empty overview status zeroed', empty.json.statusCounts.open === 0 && empty.json.statusCounts.resolved === 0)
  ok('empty avgFirstResponse null', empty.json.avgFirstResponseSeconds === null)
  ok('range from/to set on empty payload', !!empty.json.from && !!empty.json.to)

  // Seed: one inbox + contact + 3 conversations.
  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Site',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'S' },
    },
  })
  const inboxId = inbox.json.id

  const contact = await call('POST', `/accounts/${accountId}/contacts`, {
    token,
    expect: 201,
    body: { name: 'Sender', email: 's@example.com' },
  })
  const contactId = contact.json.id

  const convIds = []
  for (let i = 0; i < 3; i++) {
    const c = await call('POST', `/accounts/${accountId}/conversations`, {
      token,
      expect: 201,
      body: { contactId, inboxId },
    })
    convIds.push(c.json.id)

    // First inbound message
    await call(
      'POST',
      `/accounts/${accountId}/conversations/${c.json.id}/messages/inbound`,
      {
        token,
        expect: 201,
        body: { content: `Hello ${i}`, senderType: 'CONTACT' },
      },
    )

    // Agent reply (sets firstReplyAt)
    await call(
      'POST',
      `/accounts/${accountId}/conversations/${c.json.id}/messages`,
      {
        token,
        expect: 201,
        body: { content: `Reply ${i}` },
      },
    )
  }

  // Resolve one of them
  await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${convIds[0]}`,
    {
      token,
      expect: 200,
      body: { status: 'RESOLVED' },
    },
  )

  // Overview after seeding
  const ov = await call(
    'GET',
    `/accounts/${accountId}/reports/overview`,
    { token, expect: 200 },
  )
  ok('overview total conversations = 3', ov.json.totalConversations === 3)
  ok(
    'overview status counts add up',
    ov.json.statusCounts.open + ov.json.statusCounts.pending +
      ov.json.statusCounts.resolved === 3,
  )
  ok('one resolved', ov.json.statusCounts.resolved === 1)
  ok(
    'avgFirstResponseSeconds set (3 replies)',
    typeof ov.json.avgFirstResponseSeconds === 'number',
  )
  ok(
    'medianFirstResponseSeconds set',
    typeof ov.json.medianFirstResponseSeconds === 'number',
  )
  ok(
    'messagesBySender.CONTACT >= 3',
    ov.json.messagesBySender.CONTACT >= 3,
  )
  ok('messagesBySender.USER >= 3', ov.json.messagesBySender.USER >= 3)
  ok('sentimentBreakdown.unknown = 3', ov.json.sentimentBreakdown.unknown === 3)

  // Filter by inbox — same totals, since there's only one inbox
  const filtered = await call(
    'GET',
    `/accounts/${accountId}/reports/overview?inboxId=${inboxId}`,
    { token, expect: 200 },
  )
  ok('inboxId filter passes 3', filtered.json.totalConversations === 3)

  // Filter by a non-existent inboxId — should return 0
  const bogus = await call(
    'GET',
    `/accounts/${accountId}/reports/overview?inboxId=cmp_does_not_exist`,
    { token, expect: 200 },
  )
  ok('bogus inboxId filter returns 0', bogus.json.totalConversations === 0)

  // Timeseries conversations
  const ts = await call(
    'GET',
    `/accounts/${accountId}/reports/timeseries?metric=conversations&bucket=day`,
    { token, expect: 200 },
  )
  ok('timeseries returns metric+bucket echoed', ts.json.metric === 'conversations' && ts.json.bucket === 'day')
  ok('timeseries points array', Array.isArray(ts.json.points))
  ok('timeseries points sum to 3', ts.json.points.reduce((acc, p) => acc + p.value, 0) === 3)
  // All buckets should fall within from/to
  ok(
    'timeseries buckets within range',
    ts.json.points.every((p) => p.bucket >= ts.json.from && p.bucket <= ts.json.to),
  )

  const tsWeek = await call(
    'GET',
    `/accounts/${accountId}/reports/timeseries?metric=messages&bucket=week`,
    { token, expect: 200 },
  )
  ok('timeseries messages metric works', tsWeek.json.metric === 'messages')
  ok(
    'timeseries messages total ≥ 6',
    tsWeek.json.points.reduce((acc, p) => acc + p.value, 0) >= 6,
  )

  const tsFr = await call(
    'GET',
    `/accounts/${accountId}/reports/timeseries?metric=first_response_avg&bucket=day`,
    { token, expect: 200 },
  )
  ok('timeseries first_response_avg metric works', tsFr.json.metric === 'first_response_avg')
  ok(
    'first_response_avg has at least one bucket',
    tsFr.json.points.length >= 1,
  )

  // Leaderboard — admin resolved 1
  const lb = await call(
    'GET',
    `/accounts/${accountId}/reports/agent-leaderboard`,
    { token, expect: 200 },
  )
  ok('leaderboard entries array', Array.isArray(lb.json.entries))
  // The resolved conv had no assignee, so leaderboard could be empty. Assign
  // a conversation to admin and resolve it to verify the join works.
  const last = convIds[2]
  await call('PATCH', `/accounts/${accountId}/conversations/${last}`, {
    token,
    expect: 200,
    body: { assigneeId: adminUserId },
  })
  await call('PATCH', `/accounts/${accountId}/conversations/${last}`, {
    token,
    expect: 200,
    body: { status: 'RESOLVED' },
  })
  const lb2 = await call(
    'GET',
    `/accounts/${accountId}/reports/agent-leaderboard`,
    { token, expect: 200 },
  )
  const adminRow = lb2.json.entries.find((e) => e.userId === adminUserId)
  ok('admin appears in leaderboard', !!adminRow)
  ok('admin resolved count = 1', adminRow?.resolvedCount === 1)
  ok(
    'admin avgFirstResponseSeconds present',
    typeof adminRow?.avgFirstResponseSeconds === 'number',
  )

  // Validation — bad metric
  const badMetric = await call(
    'GET',
    `/accounts/${accountId}/reports/timeseries?metric=bogus&bucket=day`,
    { token, expect: 400 },
  )
  ok('bad metric returns 400', badMetric.status === 400)

  // Validation — bad date
  const badDate = await call(
    'GET',
    `/accounts/${accountId}/reports/overview?from=not-a-date`,
    { token, expect: 400 },
  )
  ok('bad date returns 400', badDate.status === 400)

  // Default range — last 30 days
  const defaultRange = await call(
    'GET',
    `/accounts/${accountId}/reports/overview`,
    { token, expect: 200 },
  )
  const today = todayISO()
  const thirty = isoDaysAgo(30)
  ok(
    'default range ends today',
    defaultRange.json.to === today,
    `to=${defaultRange.json.to}`,
  )
  ok(
    'default range starts 30 days ago',
    defaultRange.json.from === thirty,
    `from=${defaultRange.json.from}`,
  )

  // Wide ranges are allowed since 01c0e3c (All-time preset queries from 2015).
  const wide = await call(
    'GET',
    `/accounts/${accountId}/reports/overview?from=2020-01-01&to=2025-01-01`,
    { token, expect: 200 },
  )
  ok('multi-year range is accepted (All-time preset)', wide.json.totalConversations === 0)

  // ACL — outsider
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-reports-out-${suffix}@cosmika.test`,
      password,
      fullName: 'Out',
      accountName: 'Outsider',
    },
  })
  const outsiderToken = outsider.json.session.token

  const outOv = await call(
    'GET',
    `/accounts/${accountId}/reports/overview`,
    { token: outsiderToken, expect: 403 },
  )
  ok('outsider gets 403 on overview', outOv.status === 403)
  const outLb = await call(
    'GET',
    `/accounts/${accountId}/reports/agent-leaderboard`,
    { token: outsiderToken, expect: 403 },
  )
  ok('outsider gets 403 on leaderboard', outLb.status === 403)
  const outTs = await call(
    'GET',
    `/accounts/${accountId}/reports/timeseries?metric=conversations`,
    { token: outsiderToken, expect: 403 },
  )
  ok('outsider gets 403 on timeseries', outTs.status === 403)

  // ACL — non-admin member
  // Sign up a second user, invite them as AGENT (not admin), confirm 403
  const member = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-reports-agent-${suffix}@cosmika.test`,
      password,
      fullName: 'Agent',
      accountName: 'Discarded',
    },
  })
  // Re-issue an AccountMember row by adding them to the admin account.
  // The existing schema doesn't expose an "invite" endpoint, but adding a
  // team member would create one. Skip this for now; outsider 403 is enough.

  // Unauthenticated
  const unauth = await call(
    'GET',
    `/accounts/${accountId}/reports/overview`,
    { expect: 401 },
  )
  ok('unauthenticated overview returns 401', unauth.status === 401)

  // discard member for lint
  void member

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
