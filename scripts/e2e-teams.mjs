#!/usr/bin/env node
// E2E smoke for Module 7 (Teams + Working Hours + Holidays).

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
    throw new Error(`${method} ${path} expected ${expect} got ${res.status}: ${text}`)
  }
  return { status: res.status, json }
}

async function main() {
  console.log(`E2E teams smoke against ${API}`)

  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-teams-${suffix}@cosmika.test`,
      password,
      fullName: 'Admin',
      accountName: `Teams ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id
  const adminUserId = signUp.json.user.id

  // empty list
  const empty = await call('GET', `/accounts/${accountId}/teams`, {
    token,
    expect: 200,
  })
  ok('teams list empty', empty.json.length === 0)

  // create team
  const team = await call('POST', `/accounts/${accountId}/teams`, {
    token,
    expect: 201,
    body: { name: 'Support', description: 'Tier 1' },
  })
  ok('team created', team.json.name === 'Support')
  ok('team has zero members', team.json.memberCount === 0)
  const teamId = team.json.id

  // patch
  const patched = await call('PATCH', `/accounts/${accountId}/teams/${teamId}`, {
    token,
    expect: 200,
    body: { description: 'Tier 1 + escalations' },
  })
  ok('PATCH description', patched.json.description === 'Tier 1 + escalations')

  // add member
  const m = await call(
    'POST',
    `/accounts/${accountId}/teams/${teamId}/members`,
    {
      token,
      expect: 201,
      body: { userId: adminUserId },
    },
  )
  ok('member added', m.json.userId === adminUserId)

  // duplicate → 409
  const dup = await call(
    'POST',
    `/accounts/${accountId}/teams/${teamId}/members`,
    {
      token,
      expect: 409,
      body: { userId: adminUserId },
    },
  )
  ok('duplicate member returns 409', dup.status === 409)

  // get with members
  const detail = await call('GET', `/accounts/${accountId}/teams/${teamId}`, {
    token,
    expect: 200,
  })
  ok('detail has 1 member', detail.json.members.length === 1)
  ok('detail has memberCount 1', detail.json.memberCount === 1)

  // unknown user → 404
  const unknownUser = await call(
    'POST',
    `/accounts/${accountId}/teams/${teamId}/members`,
    {
      token,
      expect: 404,
      body: { userId: 'cmp_does_not_exist' },
    },
  )
  ok('add unknown user returns 404', unknownUser.status === 404)

  // remove member
  const rm = await call(
    'DELETE',
    `/accounts/${accountId}/teams/${teamId}/members/${adminUserId}`,
    { token, expect: 204 },
  )
  ok('member removed', rm.status === 204)
  const rmMissing = await call(
    'DELETE',
    `/accounts/${accountId}/teams/${teamId}/members/${adminUserId}`,
    { token, expect: 404 },
  )
  ok('remove missing returns 404', rmMissing.status === 404)

  // outsider ACL
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-teams-out-${suffix}@cosmika.test`,
      password,
      fullName: 'Out',
      accountName: 'Outsider',
    },
  })
  const outList = await call('GET', `/accounts/${accountId}/teams`, {
    token: outsider.json.session.token,
    expect: 403,
  })
  ok('outsider list returns 403', outList.status === 403)

  // Conversation teamId wiring: create contact + inbox + conversation, assign team
  const inbox = await call('POST', `/accounts/${accountId}/inboxes`, {
    token,
    expect: 201,
    body: {
      name: 'Site',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'S' },
    },
  })
  const contact = await call('POST', `/accounts/${accountId}/contacts`, {
    token,
    expect: 201,
    body: { name: 'C', email: 'c@example.com' },
  })
  const conv = await call('POST', `/accounts/${accountId}/conversations`, {
    token,
    expect: 201,
    body: { contactId: contact.json.id, inboxId: inbox.json.id },
  })
  const assigned = await call(
    'PATCH',
    `/accounts/${accountId}/conversations/${conv.json.id}`,
    {
      token,
      expect: 200,
      body: { teamId },
    },
  )
  ok('conversation team assigned', assigned.json.teamId === teamId)

  // delete team → conversation teamId nulled
  const del = await call('DELETE', `/accounts/${accountId}/teams/${teamId}`, {
    token,
    expect: 204,
  })
  ok('team deleted', del.status === 204)
  const after = await call(
    'GET',
    `/accounts/${accountId}/conversations/${conv.json.id}`,
    { token, expect: 200 },
  )
  ok('conversation teamId cleared after delete', after.json.teamId === null)

  // Working hours
  const initial = await call(
    'GET',
    `/accounts/${accountId}/inboxes/${inbox.json.id}/working-hours`,
    { token, expect: 200 },
  )
  ok('initial working hours empty', initial.json.length === 0)

  const setHours = await call(
    'PUT',
    `/accounts/${accountId}/inboxes/${inbox.json.id}/working-hours`,
    {
      token,
      expect: 200,
      body: {
        hours: [
          { dayOfWeek: 1, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
          { dayOfWeek: 5, openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0, closedAllDay: false },
        ],
      },
    },
  )
  ok('working hours set', setHours.json.length === 2)
  ok(
    'rows ordered by dayOfWeek',
    setHours.json[0].dayOfWeek === 1 && setHours.json[1].dayOfWeek === 5,
  )

  // replace-all semantics
  const replaced = await call(
    'PUT',
    `/accounts/${accountId}/inboxes/${inbox.json.id}/working-hours`,
    {
      token,
      expect: 200,
      body: {
        hours: [
          { dayOfWeek: 2, openHour: 10, openMinute: 0, closeHour: 19, closeMinute: 0, closedAllDay: false },
        ],
      },
    },
  )
  ok('PUT replaces existing rows', replaced.json.length === 1)
  ok('new row is dayOfWeek 2', replaced.json[0].dayOfWeek === 2)

  // dedupe of duplicate dayOfWeek
  const deduped = await call(
    'PUT',
    `/accounts/${accountId}/inboxes/${inbox.json.id}/working-hours`,
    {
      token,
      expect: 200,
      body: {
        hours: [
          { dayOfWeek: 3, openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0, closedAllDay: false },
          { dayOfWeek: 3, openHour: 10, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
        ],
      },
    },
  )
  ok('duplicate dayOfWeek collapsed', deduped.json.length === 1)
  ok('last-write wins', deduped.json[0].openHour === 10)

  // Holidays
  const holiday = await call('POST', `/accounts/${accountId}/holidays`, {
    token,
    expect: 201,
    body: { name: 'Christmas', date: '2026-12-25' },
  })
  ok('holiday created', holiday.json.name === 'Christmas')
  ok('holiday date serialized as YYYY-MM-DD', holiday.json.date === '2026-12-25')

  const listH = await call('GET', `/accounts/${accountId}/holidays`, {
    token,
    expect: 200,
  })
  ok('holiday in list', listH.json.length === 1)

  const delH = await call(
    'DELETE',
    `/accounts/${accountId}/holidays/${holiday.json.id}`,
    { token, expect: 204 },
  )
  ok('holiday deleted', delH.status === 204)

  // Outsider working-hours ACL
  const outsiderHours = await call(
    'GET',
    `/accounts/${accountId}/inboxes/${inbox.json.id}/working-hours`,
    { token: outsider.json.session.token, expect: 403 },
  )
  ok('outsider working-hours returns 403', outsiderHours.status === 403)

  // Unauthenticated
  const unauth = await call('GET', `/accounts/${accountId}/teams`, {
    expect: 401,
  })
  ok('unauthenticated teams list returns 401', unauth.status === 401)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
