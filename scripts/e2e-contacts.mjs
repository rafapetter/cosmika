#!/usr/bin/env node
// E2E smoke test for Module 3 (Contacts).
// Drives the api via fetch. Requires api running on $API_URL (default http://localhost:3110).
// Run: pnpm e2e:contacts

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const adminEmail = `e2e-c-${suffix}@cosmika.test`
const agentEmail = `e2e-c-agent-${suffix}@cosmika.test`
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
  console.log(`E2E contacts smoke against ${API}`)

  // sign-up admin
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: adminEmail,
      password,
      fullName: 'Contacts Admin',
      accountName: `Contacts E2E ${suffix}`,
    },
  })
  const adminToken = signUp.json.session.token
  const accountId = signUp.json.account.id

  // empty list
  const empty = await call('GET', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 200,
  })
  ok('empty contact list', Array.isArray(empty.json.data) && empty.json.data.length === 0)
  ok('empty list nextCursor null', empty.json.nextCursor === null)

  // create contact with no identifier → 400
  const noId = await call('POST', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 400,
    body: { name: 'Anon' },
  })
  ok('create without identifier returns 400', noId.status === 400)

  // create Alice
  const alice = await call('POST', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 201,
    body: {
      name: 'Alice Anderson',
      email: 'alice@example.com',
      phoneNumber: '+5511999990001',
      customAttributes: { plan: 'pro' },
    },
  })
  ok('alice created', alice.json.email === 'alice@example.com')
  ok('alice customAttributes', alice.json.customAttributes.plan === 'pro')
  const aliceId = alice.json.id

  // create Alice (work)
  const alice2 = await call('POST', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 201,
    body: {
      name: 'Alice (work)',
      email: 'alice@work.example',
      customAttributes: { team: 'sales' },
    },
  })
  const alice2Id = alice2.json.id

  // create Bob
  const bob = await call('POST', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 201,
    body: { name: 'Bob', email: 'bob@example.com' },
  })
  const bobId = bob.json.id

  // list returns 3
  const list = await call('GET', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 200,
  })
  ok('list returns 3 contacts', list.json.data.length === 3)

  // search alice → 2
  const searchAlice = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=alice`,
    { token: adminToken, expect: 200 },
  )
  ok('search alice returns 2', searchAlice.json.data.length === 2)

  // search by phone fragment
  const searchPhone = await call(
    'GET',
    `/accounts/${accountId}/contacts?q=999990001`,
    { token: adminToken, expect: 200 },
  )
  ok(
    'search by phone matches',
    searchPhone.json.data.length === 1 &&
      searchPhone.json.data[0].id === aliceId,
  )

  // pagination — limit=1
  const page1 = await call(
    'GET',
    `/accounts/${accountId}/contacts?limit=1`,
    { token: adminToken, expect: 200 },
  )
  ok('page1 has 1 item', page1.json.data.length === 1)
  ok('page1 has nextCursor', typeof page1.json.nextCursor === 'string')
  const page2 = await call(
    'GET',
    `/accounts/${accountId}/contacts?limit=1&cursor=${page1.json.nextCursor}`,
    { token: adminToken, expect: 200 },
  )
  ok('page2 has 1 item', page2.json.data.length === 1)
  ok(
    'page2 item differs from page1',
    page2.json.data[0].id !== page1.json.data[0].id,
  )

  // GET single — with empty contactInboxes
  const detail = await call(
    'GET',
    `/accounts/${accountId}/contacts/${aliceId}`,
    { token: adminToken, expect: 200 },
  )
  ok(
    'detail returns contactInboxes array',
    Array.isArray(detail.json.contactInboxes),
  )
  ok(
    'detail contactInboxes empty',
    detail.json.contactInboxes.length === 0,
  )

  // PATCH — set phone to null + update customAttributes
  const patched = await call(
    'PATCH',
    `/accounts/${accountId}/contacts/${aliceId}`,
    {
      token: adminToken,
      expect: 200,
      body: {
        phoneNumber: null,
        customAttributes: { plan: 'enterprise', tags: ['vip'] },
      },
    },
  )
  ok('PATCH nullifies phone', patched.json.phoneNumber === null)
  ok(
    'PATCH overwrites customAttributes',
    patched.json.customAttributes.plan === 'enterprise' &&
      Array.isArray(patched.json.customAttributes.tags),
  )

  // PATCH with invalid email → 400
  const patchBad = await call(
    'PATCH',
    `/accounts/${accountId}/contacts/${aliceId}`,
    {
      token: adminToken,
      expect: 400,
      body: { email: 'not-an-email' },
    },
  )
  ok('PATCH invalid email returns 400', patchBad.status === 400)

  // Merge alice2 into alice
  const merged = await call(
    'POST',
    `/accounts/${accountId}/contacts/${aliceId}/merge`,
    {
      token: adminToken,
      expect: 201,
      body: { sourceContactIds: [alice2Id] },
    },
  )
  ok('merge keeps target id', merged.json.id === aliceId)
  ok(
    'merge backfills nothing because target had values',
    merged.json.email === 'alice@example.com',
  )
  ok(
    'merge unions customAttributes (target wins on conflict)',
    merged.json.customAttributes.plan === 'enterprise' &&
      merged.json.customAttributes.team === 'sales',
  )

  // alice2 is gone
  const afterMerge = await call(
    'GET',
    `/accounts/${accountId}/contacts/${alice2Id}`,
    { token: adminToken, expect: 404 },
  )
  ok('source contact deleted after merge', afterMerge.status === 404)

  // List now 2
  const list2 = await call('GET', `/accounts/${accountId}/contacts`, {
    token: adminToken,
    expect: 200,
  })
  ok('list after merge has 2 contacts', list2.json.data.length === 2)

  // Merge with target in source list → 409
  const mergeSelf = await call(
    'POST',
    `/accounts/${accountId}/contacts/${aliceId}/merge`,
    {
      token: adminToken,
      expect: 409,
      body: { sourceContactIds: [aliceId] },
    },
  )
  ok('merge with self returns 409', mergeSelf.status === 409)

  // Merge with non-existent source → 404
  const mergeMissing = await call(
    'POST',
    `/accounts/${accountId}/contacts/${aliceId}/merge`,
    {
      token: adminToken,
      expect: 404,
      body: { sourceContactIds: ['cmp_does_not_exist'] },
    },
  )
  ok('merge with missing source returns 404', mergeMissing.status === 404)

  // Outsider cannot access this account's contacts
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-c-out-${suffix}@cosmika.test`,
      password,
      fullName: 'Outsider',
      accountName: 'Outsider Co',
    },
  })
  const outsiderToken = outsider.json.session.token
  const outsiderList = await call(
    'GET',
    `/accounts/${accountId}/contacts`,
    { token: outsiderToken, expect: 403 },
  )
  ok('outsider list returns 403', outsiderList.status === 403)
  const outsiderCreate = await call(
    'POST',
    `/accounts/${accountId}/contacts`,
    {
      token: outsiderToken,
      expect: 403,
      body: { email: 'evil@example.com' },
    },
  )
  ok('outsider create returns 403', outsiderCreate.status === 403)

  // Agent member: can read, cannot mutate
  const agentInvite = await call('POST', `/accounts/${accountId}/members`, {
    token: adminToken,
    expect: 201,
    body: { email: agentEmail, role: 'AGENT', fullName: 'Agent X' },
  })
  ok('agent invited', agentInvite.json.role === 'AGENT')
  // The invite path does not set a password — to test agent mutations we'd
  // need a password-set flow which is post-P0. Skip agent token testing for
  // now; the outsider 403 case already covers the ACL guard.

  // Delete Bob
  const del = await call(
    'DELETE',
    `/accounts/${accountId}/contacts/${bobId}`,
    { token: adminToken, expect: 204 },
  )
  ok('delete returns 204', del.status === 204)

  // Bob is gone
  const afterDelete = await call(
    'GET',
    `/accounts/${accountId}/contacts/${bobId}`,
    { token: adminToken, expect: 404 },
  )
  ok('deleted contact returns 404 on get', afterDelete.status === 404)

  // Unauthenticated
  const unauth = await call('GET', `/accounts/${accountId}/contacts`, {
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
