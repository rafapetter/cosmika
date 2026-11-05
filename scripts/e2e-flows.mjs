#!/usr/bin/env node
// E2E smoke for deterministic flows: CRUD + publish + the stateless preview
// runner, exercising BOTH definition shapes the engine must support — the
// builder shape (edges[].from.itemId) and the V1-import shape (item-owned
// edges via item.outgoingEdgeId + Condition rules nested at
// item.content.comparisons). See memory: cosmika-flow-v1-import-shapes.

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

// One graph, both edge shapes:
//   start ── text "Oi {{contact.name|amigo}}"
//         └─ choice "Escolha:" [Sim → g_yes (builder shape), Não → g_no (item-owned edge)]
//   g_yes ── Set variable resposta="sim-branch"
//         └─ Condition (NESTED content.comparisons, item-owned edge) → g_final
//         └─ text "else-path" (must be skipped when the condition matches)
//   g_no  ── text "não-branch" ── end-session "tchau"
//   g_final ─ text "final {{resposta}}" ── text input → nome ── text "ola {{nome}}"
const definition = {
  startGroupId: 'g_start',
  variables: [
    { id: 'resposta', name: 'resposta' },
    { id: 'nome', name: 'nome' },
  ],
  groups: [
    {
      id: 'g_start',
      title: 'Start',
      blocks: [
        { id: 't1', type: 'text', options: { content: 'Oi {{contact.name|amigo}}' } },
        {
          id: 'c1',
          type: 'choice input',
          options: {
            message: 'Escolha:',
            items: [
              { id: 'i_yes', content: 'Sim' },
              { id: 'i_no', content: 'Não', outgoingEdgeId: 'eNo' },
            ],
          },
        },
      ],
    },
    {
      id: 'g_yes',
      title: 'Yes branch',
      blocks: [
        { id: 'sv1', type: 'Set variable', options: { variableId: 'resposta', value: 'sim-branch' } },
        {
          id: 'cond1',
          type: 'Condition',
          options: {
            items: [
              {
                id: 'ci1',
                outgoingEdgeId: 'eCond',
                content: {
                  comparisons: [
                    { id: 'cmp1', variableId: 'resposta', comparisonOperator: 'Equal', value: 'sim-branch' },
                  ],
                  logicalOperator: 'AND',
                },
              },
            ],
          },
        },
        { id: 't_else', type: 'text', options: { content: 'else-path' } },
      ],
    },
    {
      id: 'g_no',
      title: 'No branch',
      blocks: [
        { id: 't_no', type: 'text', options: { content: 'não-branch' } },
        { id: 'end1', type: 'end-session', options: { message: 'tchau' } },
      ],
    },
    {
      id: 'g_final',
      title: 'Final',
      blocks: [
        { id: 't_fin', type: 'text', options: { content: 'final {{resposta}}' } },
        { id: 'ti1', type: 'text input', options: { variableId: 'nome' } },
        { id: 't_hello', type: 'text', options: { content: 'ola {{nome}}' } },
      ],
    },
  ],
  edges: [
    // Builder shape: branch anchored on the edge itself.
    { id: 'eYes', from: { blockId: 'c1', itemId: 'i_yes' }, to: { groupId: 'g_yes' } },
    // V1-import shape: from has ONLY blockId; the item points at the edge.
    { id: 'eNo', from: { blockId: 'c1' }, to: { groupId: 'g_no' } },
    { id: 'eCond', from: { blockId: 'cond1' }, to: { groupId: 'g_final' } },
  ],
}

const texts = (r) => r.json.emissions.filter((e) => e.kind === 'text').map((e) => e.text)

async function main() {
  console.log(`E2E flows smoke against ${API}`)

  const signUp = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-flows-${suffix}@cosmika.test`,
      password,
      fullName: 'Admin',
      accountName: `Flows ${suffix}`,
    },
  })
  const token = signUp.json.session.token
  const accountId = signUp.json.account.id

  // ── CRUD ──
  const empty = await call('GET', `/accounts/${accountId}/flows`, { token, expect: 200 })
  ok('flows list starts empty', empty.json.length === 0)

  const created = await call('POST', `/accounts/${accountId}/flows`, {
    token,
    expect: 201,
    body: { name: 'E2E flow', definition },
  })
  const flowId = created.json.id
  ok('flow created as draft', created.json.status === 'DRAFT' && !created.json.hasPublished)

  const fetched = await call('GET', `/accounts/${accountId}/flows/${flowId}`, { token, expect: 200 })
  ok('flow fetched with definition', fetched.json.definition.groups.length === 4)

  const renamed = await call('PATCH', `/accounts/${accountId}/flows/${flowId}`, {
    token,
    expect: 200,
    body: { name: 'E2E flow v2' },
  })
  ok('flow renamed', renamed.json.name === 'E2E flow v2')

  const listed = await call('GET', `/accounts/${accountId}/flows`, { token, expect: 200 })
  ok('flow summary exposes externalId (null here)', listed.json[0].externalId === null)

  const published = await call('POST', `/accounts/${accountId}/flows/${flowId}/publish`, {
    token,
    expect: 201,
  })
  // Publish answers with the flow plus what the static check found in it.
  ok(
    'flow published',
    published.json.flow?.status === 'PUBLISHED' && published.json.flow?.hasPublished === true,
    JSON.stringify(published.json.flow ?? published.json),
  )
  ok(
    'publish reports no problems for a sound flow',
    Array.isArray(published.json.checks) && published.json.checks.length === 0,
    JSON.stringify(published.json.checks),
  )

  // A group nothing leads to is published all the same, and reported.
  const broken = await call('POST', `/accounts/${accountId}/flows`, {
    token,
    expect: 201,
    body: {
      name: 'E2E broken flow',
      definition: {
        startGroupId: 'g_a',
        variables: [],
        groups: [
          { id: 'g_a', title: 'Start', blocks: [{ id: 'a1', type: 'text', options: { content: 'oi' } }] },
          { id: 'g_orphan', title: 'Orphan', blocks: [{ id: 'o1', type: 'text', options: { content: 'nunca' } }] },
        ],
        edges: [],
      },
    },
  })
  const brokenPublished = await call(
    'POST',
    `/accounts/${accountId}/flows/${broken.json.id}/publish`,
    { token, expect: 201 },
  )
  ok(
    'publish reports the unreachable group, without blocking',
    brokenPublished.json.flow?.status === 'PUBLISHED' &&
      brokenPublished.json.checks?.length === 1 &&
      brokenPublished.json.checks[0].code === 'unreachable_group' &&
      brokenPublished.json.checks[0].groupId === 'g_orphan',
    JSON.stringify(brokenPublished.json.checks),
  )
  await call('DELETE', `/accounts/${accountId}/flows/${broken.json.id}`, { token, expect: 204 })

  // ── preview: start ──
  const start = await call('POST', `/accounts/${accountId}/flows/${flowId}/preview`, {
    token,
    expect: 201,
    body: {},
  })
  // Preview seeds a synthetic contact, so the |default is NOT used here.
  ok('start interpolates {{contact.name|amigo}} with preview persona', texts(start).includes('Oi Visitante (teste)'))
  const buttons = start.json.emissions.find((e) => e.kind === 'interactive')
  ok(
    'choice renders buttons Sim/Não',
    buttons && buttons.content.buttons.map((b) => b.label).join(',') === 'Sim,Não',
    JSON.stringify(buttons ?? null),
  )
  ok('start is waiting for input', start.json.status === 'waiting')

  // ── preview: Sim → builder-shape branch, nested Condition, capture ──
  const yes = await call('POST', `/accounts/${accountId}/flows/${flowId}/preview`, {
    token,
    expect: 201,
    body: { state: start.json.state, input: { text: 'Sim', interactiveReplyId: 'i_yes' } },
  })
  ok('Sim routes via from.itemId edge + nested condition to g_final', texts(yes).includes('final sim-branch'))
  ok('condition else-path was skipped', !texts(yes).includes('else-path'))
  ok('waits at typed input', yes.json.status === 'waiting')

  const name = await call('POST', `/accounts/${accountId}/flows/${flowId}/preview`, {
    token,
    expect: 201,
    body: { state: yes.json.state, input: { text: 'Rafael' } },
  })
  ok('typed input captured into {{nome}}', texts(name).includes('ola Rafael'))
  ok('flow completes after last block', name.json.status === 'completed')

  // ── preview: Não → item-owned-edge branch, matched by typed label ──
  const start2 = await call('POST', `/accounts/${accountId}/flows/${flowId}/preview`, {
    token,
    expect: 201,
    body: {},
  })
  const no = await call('POST', `/accounts/${accountId}/flows/${flowId}/preview`, {
    token,
    expect: 201,
    body: { state: start2.json.state, input: { text: 'não' } },
  })
  ok('Não (typed, case-insensitive) routes via item.outgoingEdgeId', texts(no).includes('não-branch'))
  ok('end-session emits goodbye', texts(no).includes('tchau'))
  ok('end-session completes the flow', no.json.status === 'completed')

  // ── preview: unmatched reply retries (STRICT), state stays put ──
  const start3 = await call('POST', `/accounts/${accountId}/flows/${flowId}/preview`, {
    token,
    expect: 201,
    body: {},
  })
  const bad = await call('POST', `/accounts/${accountId}/flows/${flowId}/preview`, {
    token,
    expect: 201,
    body: { state: start3.json.state, input: { text: 'xyzzy' } },
  })
  ok('unmatched choice reply keeps waiting', bad.json.status === 'waiting')

  // ── ACL ──
  const outsider = await call('POST', '/auth/sign-up', {
    expect: 201,
    body: {
      email: `e2e-flows-out-${suffix}@cosmika.test`,
      password,
      fullName: 'Outsider',
      accountName: `Out ${suffix}`,
    },
  })
  const forbidden = await call('GET', `/accounts/${accountId}/flows/${flowId}`, {
    token: outsider.json.session.token,
  })
  ok('outsider gets 403/404', forbidden.status === 403 || forbidden.status === 404)
  const unauth = await call('GET', `/accounts/${accountId}/flows`, { expect: 401 })
  ok('unauthenticated list returns 401', unauth.status === 401)

  // ── delete (soft: archives the flow) ──
  const del = await call('DELETE', `/accounts/${accountId}/flows/${flowId}`, { token })
  ok('flow deleted', del.status === 204)
  const archived = await call('GET', `/accounts/${accountId}/flows/${flowId}`, { token, expect: 200 })
  ok('deleted flow is archived, still fetchable by id', archived.json.status === 'ARCHIVED')
  const listAfter = await call('GET', `/accounts/${accountId}/flows`, { token, expect: 200 })
  ok('archived flow left the list', !listAfter.json.some((f) => f.id === flowId))

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
