#!/usr/bin/env node
// E2E smoke for attachments: upload, attach-to-message, retrieve.
// Runs against local filesystem storage (no S3 env set).

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

async function call(method, path, { token, body, expect, headers, raw } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
  const text = await res.text()
  let json = null
  if (text) {
    try { json = JSON.parse(text) } catch { /* keep raw */ }
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status}: ${text}`)
  }
  return { status: res.status, json, text }
}

async function uploadFile(token, accountId, filename, mimeType, buffer) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), filename)
  const res = await fetch(`${API}/accounts/${accountId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep raw */ }
  return { status: res.status, json, text }
}

async function main() {
  console.log(`E2E attachments smoke against ${API}`)

  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-attach-${suffix}@cosmika.test`,
      password,
      fullName: 'Admin',
      accountName: `Attach ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id

  // Upload a small text file
  const buf = Buffer.from('Hello, attachments!')
  const up = await uploadFile(token, accountId, 'hello.txt', 'text/plain', buf)
  ok('upload status 201', up.status === 201)
  ok('attachment has id', !!up.json?.id)
  ok('mimeType set', up.json?.mimeType === 'text/plain')
  ok('fileSize set', up.json?.fileSize === buf.length)
  ok('messageId null (draft)', up.json?.messageId === null)
  ok('fileType detected', up.json?.fileType === 'FILE')

  const attId = up.json.id

  // Upload an image
  const imgBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG magic bytes
  const imgUp = await uploadFile(token, accountId, 'pic.png', 'image/png', imgBuf)
  ok('image upload 201', imgUp.status === 201)
  ok('image fileType IMAGE', imgUp.json?.fileType === 'IMAGE')

  // Empty file → 400
  const emptyUp = await uploadFile(token, accountId, 'e.txt', 'text/plain', Buffer.alloc(0))
  ok('empty file returns 400', emptyUp.status === 400)

  // Set up inbox + contact + conversation
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

  // Send a message with the uploaded attachment
  const msg = await call(
    'POST',
    `/accounts/${accountId}/conversations/${conv.json.id}/messages`,
    {
      token,
      expect: 201,
      body: { content: 'See attached', attachmentIds: [attId] },
    },
  )
  ok('message sent w/ attachment', msg.status === 201)

  // List messages, attachment is hydrated
  const list = await call(
    'GET',
    `/accounts/${accountId}/conversations/${conv.json.id}/messages`,
    { token, expect: 200 },
  )
  const sent = list.json.data.find((m) => m.id === msg.json.id)
  ok('attachments array present on listed message', Array.isArray(sent?.attachments))
  ok('attachment hydrated', sent?.attachments.length === 1)
  ok('attachment id matches', sent?.attachments[0]?.id === attId)
  ok('attachment fileName matches', sent?.attachments[0]?.fileName === 'hello.txt')

  // Re-attaching a now-linked attachment to another message → 400
  const conv2 = await call('POST', `/accounts/${accountId}/conversations`, {
    token,
    expect: 201,
    body: { contactId: contact.json.id, inboxId: inbox.json.id },
  })
  const reAttach = await call(
    'POST',
    `/accounts/${accountId}/conversations/${conv2.json.id}/messages`,
    {
      token,
      expect: 400,
      body: { content: 'try again', attachmentIds: [attId] },
    },
  )
  ok('attachment cannot be linked twice', reAttach.status === 400)

  // Download URL (local mode → /attachments-files/:id)
  const dl = await fetch(
    `${API}/accounts/${accountId}/attachments/${attId}/download`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
    },
  )
  // Must be a real 302 — a 200 carrying `location` is what shipped to prod
  // once, and browsers render it as an empty page instead of following the
  // link. Accepting 200 here is why that reached production.
  ok('download endpoint answers 302', dl.status === 302)
  ok('download redirect carries a location header', Boolean(dl.headers.get('location')))

  // Outsider ACL — different account user can't upload to mine
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-attach-out-${suffix}@cosmika.test`,
      password,
      fullName: 'Out',
      accountName: 'Out',
    },
  })
  const outUp = await uploadFile(
    outsider.json.session.token,
    accountId,
    'evil.txt',
    'text/plain',
    Buffer.from('haha'),
  )
  ok('outsider upload returns 403', outUp.status === 403)

  // Unauthenticated upload → 401
  const unauthRes = await fetch(`${API}/accounts/${accountId}/attachments`, {
    method: 'POST',
    body: new FormData(),
  })
  ok('unauthenticated upload returns 401', unauthRes.status === 401)

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
