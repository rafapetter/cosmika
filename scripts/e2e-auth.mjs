#!/usr/bin/env node
// E2E smoke test for Module 1 (Auth + Accounts).
// Drives the api directly via fetch. Requires the api to be running on $API_URL (default http://localhost:3110).
// Run: pnpm e2e:auth

const API = process.env.API_URL ?? 'http://localhost:3110'
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const founderEmail = `e2e-${suffix}@cosmika.test`
const agentEmail = `e2e-agent-${suffix}@cosmika.test`
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
    try { json = JSON.parse(text) } catch { /* keep as text */ }
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status} body=${text}`)
  }
  return { status: res.status, json }
}

async function main() {
  console.log(`E2E auth smoke against ${API}`)

  // health
  const health = await call('GET', '/health', { expect: 200 })
  ok('GET /health', health.json?.status === 'ok')

  // sign-up
  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: founderEmail,
      password,
      fullName: 'E2E Founder',
      accountName: `E2E Co ${suffix}`,
    },
  })
  const envelope = signUp.json
  ok('sign-up returns session token', typeof envelope.session?.token === 'string')
  ok('sign-up returns user', envelope.user?.email === founderEmail)
  ok('sign-up returns account on the ROCKET plan', envelope.account?.plan === 'ROCKET')
  ok('sign-up membership is ADMINISTRATOR', envelope.membership?.role === 'ADMINISTRATOR')

  const token = envelope.session.token
  const accountId = envelope.account.id

  // duplicate sign-up rejected
  const dup = await call('POST', '/auth/sign-up', {
    expect: 409,
    body: {
      email: founderEmail,
      password,
      fullName: 'Dup',
      accountName: 'Dup',
    },
  })
  ok('duplicate sign-up returns 409', dup.status === 409)

  // /auth/me with bad token → 401
  const meBad = await call('GET', '/auth/me', { token: 'invalid', expect: 401 })
  ok('me with bad token returns 401', meBad.status === 401)

  // /auth/me with good token
  const me = await call('GET', '/auth/me', { token, expect: 200 })
  ok('me returns user', me.json?.user?.email === founderEmail)
  ok('me returns account', me.json?.account?.id === accountId)

  // GET /accounts/:id (admin)
  const acct = await call('GET', `/accounts/${accountId}`, { token, expect: 200 })
  ok('account get returns name', acct.json?.name === `E2E Co ${suffix}`)
  ok('account has 1 member', Array.isArray(acct.json?.members) && acct.json.members.length === 1)

  // PATCH /accounts/:id
  const patched = await call('PATCH', `/accounts/${accountId}`, {
    token,
    expect: 200,
    body: { defaultTimezone: 'America/New_York', domain: `e2e-${suffix}.example` },
  })
  ok('PATCH timezone applied', patched.json?.defaultTimezone === 'America/New_York')
  ok('PATCH domain applied', patched.json?.domain === `e2e-${suffix}.example`)

  // POST /accounts/:id/members
  const invite = await call('POST', `/accounts/${accountId}/members`, {
    token,
    expect: 201,
    body: { email: agentEmail, role: 'AGENT', fullName: 'E2E Agent' },
  })
  ok('invite returns agent role', invite.json?.role === 'AGENT')

  // sign-out
  const signOut = await call('POST', '/auth/sign-out', { token, expect: 204 })
  ok('sign-out returns 204', signOut.status === 204)

  // me after sign-out → 401
  const meAfter = await call('GET', '/auth/me', { token, expect: 401 })
  ok('me after sign-out returns 401', meAfter.status === 401)

  // sign-in with right creds
  const signIn = await call('POST', '/auth/sign-in', {
    expect: 200,
    body: { email: founderEmail, password },
  })
  ok('sign-in returns user', signIn.json?.user?.email === founderEmail)
  ok('sign-in returns a new session token', signIn.json?.session?.token !== token)

  // sign-in with wrong password
  const signInBad = await call('POST', '/auth/sign-in', {
    expect: 401,
    body: { email: founderEmail, password: 'WRONG-PASSWORD' },
  })
  ok('wrong password returns 401', signInBad.status === 401)

  // Zod validation: missing required field
  const bad = await call('POST', '/auth/sign-up', {
    expect: 400,
    body: { email: 'no-password@example.com', fullName: 'X', accountName: 'X' },
  })
  ok('missing password returns 400', bad.status === 400)

  // Forgot/reset password: forgot never reveals account existence; reset
  // rejects bogus tokens. (Happy-path reset needs the emailed token, which
  // e2e can't read — covered by unit tests.)
  const forgotKnown = await call('POST', '/auth/forgot-password', {
    body: { email: founderEmail },
  })
  ok('forgot-password for existing email returns 204', forgotKnown.status === 204)
  const forgotUnknown = await call('POST', '/auth/forgot-password', {
    body: { email: `nobody-${suffix}@cosmika.test` },
  })
  ok('forgot-password for unknown email also returns 204', forgotUnknown.status === 204)
  const resetBad = await call('POST', '/auth/reset-password', {
    body: { token: 'bogus-token', password: 'newpass123' },
  })
  ok('reset-password with bogus token returns 401', resetBad.status === 401)
  const resetShort = await call('POST', '/auth/reset-password', {
    body: { token: 'bogus-token', password: 'short' },
  })
  ok('reset-password with short password returns 400', resetShort.status === 400)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
