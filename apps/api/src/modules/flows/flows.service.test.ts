import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FlowsService, previewAgentReply } from './flows.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    account: { findUnique: vi.fn().mockResolvedValue({ defaultTimezone: 'America/Sao_Paulo', defaultLocale: 'pt-BR' }) },
    flow: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma) {
  return new FlowsService(prisma as never)
}

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const AGENT = { ...ADMIN, role: 'AGENT' }
const DEF = {
  groups: [{ id: 'g1', blocks: [{ id: 'b1', type: 'text' }] }],
  edges: [],
  variables: [],
}
const FLOW = {
  id: 'f1',
  accountId: 'acc1',
  name: 'Welcome',
  status: 'DRAFT',
  definition: DEF,
  published: null,
  createdAt: new Date('2026-06-26T00:00:00Z'),
  updatedAt: new Date('2026-06-26T01:00:00Z'),
}

describe('FlowsService — access', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 when not an active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403 when membership inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, isActive: false })
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403 AGENT cannot create/update/publish/archive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const svc = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', { name: 'x', definition: DEF } as never),
    ).rejects.toThrow(ForbiddenException)
    await expect(svc.update('u1', 'acc1', 'f1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
    await expect(svc.publish('u1', 'acc1', 'f1')).rejects.toThrow(
      ForbiddenException,
    )
    await expect(svc.archive('u1', 'acc1', 'f1')).rejects.toThrow(
      ForbiddenException,
    )
  })
})

describe('FlowsService — CRUD', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('list filters out ARCHIVED, newest first', async () => {
    prisma.flow.findMany.mockResolvedValue([FLOW])
    const r = await makeService(prisma).list('u1', 'acc1')
    expect(r).toEqual([FLOW])
    expect(prisma.flow.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', status: { not: 'ARCHIVED' } },
      orderBy: { updatedAt: 'desc' },
    })
  })

  it('get returns the owned flow', async () => {
    prisma.flow.findUnique.mockResolvedValue(FLOW)
    expect(await makeService(prisma).get('u1', 'acc1', 'f1')).toEqual(FLOW)
  })

  it('get 404 for unknown / cross-account', async () => {
    prisma.flow.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).get('u1', 'acc1', 'f1')).rejects.toThrow(
      NotFoundException,
    )
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, accountId: 'other' })
    await expect(makeService(prisma).get('u1', 'acc1', 'f1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('create makes a DRAFT', async () => {
    prisma.flow.create.mockResolvedValue(FLOW)
    await makeService(prisma).create('u1', 'acc1', { name: 'Welcome', definition: DEF } as never)
    expect(prisma.flow.create).toHaveBeenCalledWith({
      data: { accountId: 'acc1', name: 'Welcome', status: 'DRAFT', definition: DEF },
    })
  })

  it('update sets only provided fields (name + definition)', async () => {
    prisma.flow.findUnique.mockResolvedValue(FLOW)
    prisma.flow.update.mockResolvedValue(FLOW)
    await makeService(prisma).update('u1', 'acc1', 'f1', { name: 'New', definition: DEF } as never)
    expect(prisma.flow.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { name: 'New', definition: DEF },
    })
  })

  it('update with empty input sends empty data', async () => {
    prisma.flow.findUnique.mockResolvedValue(FLOW)
    prisma.flow.update.mockResolvedValue(FLOW)
    await makeService(prisma).update('u1', 'acc1', 'f1', {} as never)
    expect(prisma.flow.update).toHaveBeenCalledWith({ where: { id: 'f1' }, data: {} })
  })

  it('publish snapshots definition → published + PUBLISHED', async () => {
    prisma.flow.findUnique.mockResolvedValue(FLOW)
    prisma.flow.update.mockResolvedValue({ ...FLOW, published: DEF, status: 'PUBLISHED' })
    prisma.flow.findMany.mockResolvedValue([])
    const r = await makeService(prisma).publish('u1', 'acc1', 'f1')
    expect(prisma.flow.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { published: DEF, status: 'PUBLISHED' },
    })
    expect(r.checks).toEqual([])
  })

  it('archive sets status ARCHIVED', async () => {
    prisma.flow.findUnique.mockResolvedValue(FLOW)
    prisma.flow.update.mockResolvedValue({ ...FLOW, status: 'ARCHIVED' })
    await makeService(prisma).archive('u1', 'acc1', 'f1')
    expect(prisma.flow.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { status: 'ARCHIVED' },
    })
  })
})

describe('FlowsService — DTOs', () => {
  const svc = makeService(makePrisma())

  it('toDTO parses the definition + reflects hasPublished', () => {
    expect(svc.toDTO(FLOW as never)).toEqual({
      id: 'f1',
      accountId: 'acc1',
      name: 'Welcome',
      status: 'DRAFT',
      definition: { ...DEF, variables: [] },
      hasPublished: false,
      createdAt: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T01:00:00.000Z',
    })
    expect(svc.toDTO({ ...FLOW, published: DEF } as never).hasPublished).toBe(true)
  })

  it('toSummaryDTO is the lightweight shape (externalId null-fallback + passthrough)', () => {
    expect(svc.toSummaryDTO(FLOW as never)).toEqual({
      id: 'f1',
      name: 'Welcome',
      status: 'DRAFT',
      hasPublished: false,
      updatedAt: '2026-06-26T01:00:00.000Z',
      externalId: null,
    })
    expect(svc.toSummaryDTO({ ...FLOW, externalId: 'tb1' } as never).externalId).toBe('tb1')
  })
})

describe('FlowsService — preview (stateless test-bot run)', () => {
  let prisma: Prisma
  let svc: FlowsService
  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.flow.findMany.mockResolvedValue([])
  })

  const TEXT_DEF = {
    groups: [
      { id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: 'Olá {{contact.name}}!' } }] },
    ],
    edges: [],
    variables: [],
  }
  const INPUT_DEF = {
    groups: [
      { id: 'g1', blocks: [
        { id: 'q', type: 'text input', options: { variableId: 'nome' }, outgoingEdgeId: null },
        { id: 't', type: 'text', options: { content: 'Prazer, {{nome}}!' } },
      ] },
    ],
    edges: [],
    variables: [],
  }

  it('start (no state): runs the draft def and emits with the preview contact', async () => {
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: TEXT_DEF })
    const r = await svc.preview('u1', 'acc1', 'f1', {})
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Olá Visitante (teste)!' }])
  })

  it('runs Code blocks through the sandbox effect (degrades to no-op under test)', async () => {
    // Regression: the preview engine used to get NO runCode effect, so flows
    // with Code blocks took different branches than production (found live
    // 2026-08-05 on "Boas Vindas"). Under vitest the sandbox is a no-op, but
    // the effect must be wired and the flow must still complete.
    const CODE_DEF = {
      groups: [
        { id: 'g1', blocks: [
          { id: 'c', type: 'Code', options: { content: 'context.x = 1' }, outgoingEdgeId: null },
          { id: 't', type: 'text', options: { content: 'depois do code' } },
        ] },
      ],
      edges: [],
      variables: [],
    }
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: CODE_DEF })
    const r = await svc.preview('u1', 'acc1', 'f1', {})
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'depois do code' }])
  })

  it('resume: posts the client-held state back with the reply text', async () => {
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: INPUT_DEF })
    const first = await svc.preview('u1', 'acc1', 'f1', {})
    expect(first.status).toBe('waiting')
    const second = await svc.preview('u1', 'acc1', 'f1', {
      state: first.state as never,
      input: { text: 'Rafael' },
    })
    expect(second.status).toBe('completed')
    expect(second.emissions).toEqual([{ kind: 'text', text: 'Prazer, Rafael!' }])
  })

  it('resume defaults: missing input text/interactiveReplyId become empty/null', async () => {
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: INPUT_DEF })
    const first = await svc.preview('u1', 'acc1', 'f1', {})
    const second = await svc.preview('u1', 'acc1', 'f1', { state: first.state as never })
    // a blank reply does not satisfy the text input → still waiting (no crash)
    expect(second.status).toBe('waiting')
  })

  it('date conditions read the account timezone, UTC when the account has none', async () => {
    const NOW_DEF = {
      groups: [{ id: 'g1', blocks: [{ id: 't', type: 'text', options: { content: '{{now}}' } }] }],
      edges: [],
      variables: [],
    }
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: NOW_DEF })
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 20, 12, 0)) })
    try {
      const sp = await svc.preview('u1', 'acc1', 'f1', {})
      expect(sp.emissions).toEqual([{ kind: 'text', text: '2026-10-20 09:00' }])
      prisma.account.findUnique.mockResolvedValueOnce(null)
      const utc = await svc.preview('u1', 'acc1', 'f1', {})
      expect(utc.emissions).toEqual([{ kind: 'text', text: '2026-10-20 12:00' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an AI agent block answers with a stand-in and still counts toward its limit', async () => {
    const AGENT_DEF = {
      groups: [
        { id: 'g1', blocks: [{ id: 'ag', type: 'AI agent', options: { agentBotId: 'b1', maxAiTurns: 1 } }] },
      ],
      edges: [],
      variables: [],
    }
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: AGENT_DEF })
    const first = await svc.preview('u1', 'acc1', 'f1', {})
    expect(first.status).toBe('waiting')
    expect(first.emissions).toEqual([{ kind: 'text', text: previewAgentReply('pt-BR'), ai: true }])
    const second = await svc.preview('u1', 'acc1', 'f1', { state: first.state as never, input: { text: 'oi' } })
    expect(second.status).toBe('handoff')
  })

  it('the stand-in speaks the account language', () => {
    expect(previewAgentReply('en')).toContain('AI agent')
    expect(previewAgentReply('es')).toContain('agente de IA')
    expect(previewAgentReply('pt-BR')).toContain('agente de IA')
  })

  it('422 when the draft definition is invalid', async () => {
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: { nope: true } })
    await expect(svc.preview('u1', 'acc1', 'f1', {})).rejects.toThrow(
      'Flow definition is invalid',
    )
  })

  it('403 for non-members; 404 for cross-account flows', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc.preview('u1', 'acc1', 'f1', {})).rejects.toThrow(ForbiddenException)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, accountId: 'OTHER' })
    await expect(svc.preview('u1', 'acc1', 'f1', {})).rejects.toThrow(NotFoundException)
  })

  it('loads linked sub-flows by externalId and composes them (skipping invalid/null rows, breaking on cycles)', async () => {
    const ROOT = {
      groups: [
        { id: 'g1', blocks: [
          { id: 'l1', type: 'Cosmoflow link', options: { cosmoflowId: '77' }, outgoingEdgeId: 'e1' },
          { id: 'l2', type: 'Cosmoflow link', options: { cosmoflowId: 'bad' } },
          { id: 'l3', type: 'Cosmoflow link', options: { cosmoflowId: 'nullext' } },
        ] },
        { id: 'g2', blocks: [{ id: 'after', type: 'text', options: { content: 'de volta' } }] },
      ],
      edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
      variables: [],
    }
    prisma.flow.findUnique.mockResolvedValue({ ...FLOW, definition: ROOT })
    prisma.flow.findMany.mockResolvedValue([
      { id: 's1', accountId: 'acc1', externalId: '77', published: {
        groups: [{ id: 'sg', blocks: [
          { id: 'sb', type: 'text', options: { content: 'do sub-flow' } },
          { id: 'cyc', type: 'Cosmoflow link', options: { cosmoflowId: '77' }, outgoingEdgeId: null },
        ] }], edges: [], variables: [],
      } },
      { id: 's2', accountId: 'acc1', externalId: 'bad', published: { nope: true } },
      { id: 's3', accountId: 'acc1', externalId: null, published: { groups: [], edges: [], variables: [] } },
    ])
    const r = await svc.preview('u1', 'acc1', 'f1', {})
    const texts = r.emissions.map((e) => (e as { text?: string }).text)
    expect(texts).toContain('do sub-flow')
    expect(texts).toContain('de volta')
    expect(prisma.flow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accountId: 'acc1', externalId: { in: ['77', 'bad', 'nullext'] } }),
      }),
    )
  })
})

// A publish that says nothing is how the commercial menu stayed dead from its
// import in April 2026 until a lead hit it in September.
describe('FlowsService — checks reported on publish', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.flow.findMany.mockResolvedValue([])
  })

  const BROKEN = {
    groups: [
      { id: 'g1', title: 'Início', blocks: [{ id: 'b1', type: 'text', options: { content: 'oi' } }] },
      { id: 'g2', title: 'Falar com consultor', blocks: [{ id: 'b2', type: 'text', options: { content: 'x' } }] },
    ],
    edges: [],
    variables: [],
  }

  function publishing(def: unknown, over: Record<string, unknown> = {}) {
    const flow = { ...FLOW, definition: def, ...over }
    prisma.flow.findUnique.mockResolvedValue(flow)
    prisma.flow.update.mockResolvedValue({ ...flow, published: def, status: 'PUBLISHED' })
    return makeService(prisma)
  }

  it('names the group nothing leads to, so the author can find it', async () => {
    const r = await publishing(BROKEN).publish('u1', 'acc1', 'f1')
    expect(r.flow.status).toBe('PUBLISHED')
    expect(r.checks).toEqual([
      { code: 'unreachable_group', groupId: 'g2', groupTitle: 'Falar com consultor' },
    ])
  })

  it('publishes anyway — the checks warn, they never block', async () => {
    const r = await publishing(BROKEN).publish('u1', 'acc1', 'f1')
    expect(prisma.flow.update).toHaveBeenCalled()
    expect(r.checks.length).toBeGreaterThan(0)
  })

  it('tells a link to a missing flow apart from one that resolves', async () => {
    const linking = {
      groups: [{ id: 'g1', title: 'Passo', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: '3339' } }] }],
      edges: [],
      variables: [],
    }
    const missing = await publishing(linking).publish('u1', 'acc1', 'f1')
    expect(missing.checks.map((c) => c.code)).toEqual(['link_to_missing_flow'])

    prisma.flow.findMany.mockResolvedValue([{ externalId: '3339' }])
    const resolved = await publishing(linking).publish('u1', 'acc1', 'f1')
    expect(resolved.checks).toEqual([])
  })

  it('reads a flow that links to itself as a cycle', async () => {
    prisma.flow.findMany.mockResolvedValue([{ externalId: '3331' }])
    const r = await publishing(
      {
        groups: [{ id: 'g1', title: 'Passo', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: '3331' } }] }],
        edges: [],
        variables: [],
      },
      { externalId: '3331' },
    ).publish('u1', 'acc1', 'f1')
    expect(r.checks.map((c) => c.code)).toEqual(['link_cycle'])
  })

  it('reports nothing for a definition it cannot parse', async () => {
    const r = await publishing({ nonsense: true }).publish('u1', 'acc1', 'f1')
    expect(r.checks).toEqual([])
  })

  it('a publish that worked is never undone by a failing report', async () => {
    prisma.flow.findMany.mockRejectedValue(new Error('db down'))
    const r = await publishing(BROKEN).publish('u1', 'acc1', 'f1')
    expect(r.flow.status).toBe('PUBLISHED')
    expect(r.checks).toEqual([])

    prisma.flow.findMany.mockRejectedValue('uma string')
    const r2 = await publishing(BROKEN).publish('u1', 'acc1', 'f1')
    expect(r2.checks).toEqual([])
  })
})
