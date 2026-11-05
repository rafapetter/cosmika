import { describe, expect, it, vi } from 'vitest'

import {
  FlowEngine,
  emptyFlowState,
  type FlowEffects,
} from './flow-engine'

// Helper: build a flow definition. Blocks use Typebot-ish `options`.
function def(groups: unknown[], edges: unknown[] = [], extra: object = {}) {
  return { groups, edges, variables: [], ...extra } as never
}
function textBlock(id: string, content: string, edge?: string) {
  return { id, type: 'text', options: { content }, outgoingEdgeId: edge ?? null }
}
function edge(id: string, toGroupId: string, toBlockId?: string) {
  return { id, from: {}, to: { groupId: toGroupId, blockId: toBlockId ?? null } }
}
function engine(
  d: unknown,
  mode: 'STRICT' | 'GUIDED' = 'STRICT',
  effects?: Partial<FlowEffects>,
  subFlows?: Map<string, unknown>,
) {
  return new FlowEngine(d as never, mode, effects, subFlows as never)
}

describe('FlowEngine.start', () => {
  it('completes immediately when there are no groups', async () => {
    const r = await engine(def([])).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([])
  })

  it('emits a text bubble then completes at end of group', async () => {
    const r = await engine(def([{ id: 'g1', blocks: [textBlock('b1', 'Hello')] }])).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Hello' }])
  })

  it('skips an empty text bubble (no emission)', async () => {
    const r = await engine(def([{ id: 'g1', blocks: [textBlock('b1', '')] }])).start()
    expect(r.emissions).toEqual([])
  })

  it('honors an explicit startGroupId', async () => {
    const r = await engine(
      def(
        [
          { id: 'g1', blocks: [textBlock('b1', 'first')] },
          { id: 'g2', blocks: [textBlock('b2', 'second')] },
        ],
        [],
        { startGroupId: 'g2' },
      ),
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'second' }])
  })

  it('interpolates {{var}}, {{var|default}}, and contact fields', async () => {
    const r = await engine(
      def([
        { id: 'g1', blocks: [textBlock('b1', 'Hi {{contact.name}} ({{missing|none}}) {{seed}}')] },
      ]),
    ).start({ contact: { name: 'Ana' } }, { seed: 'X' })
    expect(r.emissions[0]).toEqual({ kind: 'text', text: 'Hi Ana (none) X' })
  })

  it('resolves a missing var to empty string', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [textBlock('b1', 'v={{nope}}')] }]),
    ).start()
    expect(r.emissions[0]).toEqual({ kind: 'text', text: 'v=' })
  })
})

describe('FlowEngine edges + jumps', () => {
  it('follows a block outgoing edge to another group (with target blockId)', async () => {
    const r = await engine(
      def(
        [
          { id: 'g1', blocks: [textBlock('b1', 'one', 'e1')] },
          { id: 'g2', blocks: [textBlock('bX', 'skip'), textBlock('b2', 'two')] },
        ],
        [edge('e1', 'g2', 'b2')],
      ),
    ).start()
    expect(r.emissions).toEqual([
      { kind: 'text', text: 'one' },
      { kind: 'text', text: 'two' },
    ])
  })

  it('completes when an edge points to an unknown group', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [textBlock('b1', 'one', 'eX')] }], [edge('eX', 'gnone')]),
    ).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'one' }])
  })

  it('completes when a referenced edge id does not exist', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [textBlock('b1', 'one', 'ghost')] }], []),
    ).start()
    expect(r.status).toBe('completed')
  })

  it('Jump block jumps to a group; missing groupId is a no-op (continue)', async () => {
    const jumped = await engine(
      def([
        { id: 'g1', blocks: [{ id: 'j', type: 'Jump', options: { groupId: 'g2' } }] },
        { id: 'g2', blocks: [textBlock('b2', 'landed')] },
      ]),
    ).start()
    expect(jumped.emissions).toEqual([{ kind: 'text', text: 'landed' }])

    const noop = await engine(
      def([{ id: 'g1', blocks: [{ id: 'j', type: 'Jump', options: {} }, textBlock('b', 'after')] }]),
    ).start()
    expect(noop.emissions).toEqual([{ kind: 'text', text: 'after' }])
  })

  it('guards against infinite group loops (MAX_GROUP_VISITS)', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'j', type: 'Jump', options: { groupId: 'g1' } }] }]),
    ).start()
    expect(r.status).toBe('completed')
  })

  it('guards against runaway block counts (MAX_BLOCKS_PER_RUN)', async () => {
    const blocks = Array.from({ length: 205 }, (_v, i) => textBlock(`b${i}`, `t${i}`))
    const r = await engine(def([{ id: 'g1', blocks }])).start()
    expect(r.status).toBe('completed')
    expect(r.emissions.length).toBeLessThanOrEqual(201)
  })
})

describe('FlowEngine Set variable + Condition', () => {
  it('Set variable stores an interpolated value used downstream', async () => {
    const r = await engine(
      def([
        {
          id: 'g1',
          blocks: [
            { id: 'sv', type: 'Set variable', options: { variableId: 'greeting', value: 'Hi {{contact.name}}' } },
            textBlock('b', '{{greeting}}!'),
          ],
        },
      ]),
    ).start({ contact: { name: 'Bo' } })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Hi Bo!' }])
  })

  it('Set variable with no variableId is a no-op', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'sv', type: 'Set variable', options: {} }, textBlock('b', 'ok')] }]),
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'ok' }])
  })

  it('Condition routes to the matching item edge (AND), else continues', async () => {
    const cond = {
      id: 'c',
      type: 'Condition',
      options: {
        items: [
          {
            outgoingEdgeId: 'e1',
            logicalOperator: 'AND',
            comparisons: [
              { variableId: 'plan', comparisonOperator: 'Equal', value: 'pro' },
              { variableId: 'plan', comparisonOperator: 'Is set', value: '' },
            ],
          },
        ],
      },
    }
    const flow = def(
      [
        { id: 'g1', blocks: [cond, textBlock('fallthrough', 'no-match')] },
        { id: 'g2', blocks: [textBlock('b2', 'matched')] },
      ],
      [edge('e1', 'g2')],
    )
    const matched = await engine(flow).start({}, { plan: 'pro' })
    expect(matched.emissions).toEqual([{ kind: 'text', text: 'matched' }])

    const notMatched = await engine(flow).start({}, { plan: 'free' })
    expect(notMatched.emissions).toEqual([{ kind: 'text', text: 'no-match' }])
  })

  it('Condition OR + matched item without an edge falls through', async () => {
    const cond = {
      id: 'c',
      type: 'Condition',
      options: {
        items: [
          { logicalOperator: 'OR', comparisons: [{ variableId: 'x', comparisonOperator: 'Equal', value: 'no' }] },
          {
            outgoingEdgeId: 'e1',
            logicalOperator: 'OR',
            comparisons: [
              { variableId: 'x', comparisonOperator: 'Equal', value: 'no' },
              { variableId: 'x', comparisonOperator: 'Equal', value: 'yes' },
            ],
          },
        ],
      },
    }
    const r = await engine(
      def([
        { id: 'g1', blocks: [cond, textBlock('f', 'fall')] },
        { id: 'g2', blocks: [textBlock('b2', 'edged')] },
      ], [edge('e1', 'g2')]),
    ).start({}, { x: 'yes' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'edged' }])
  })

  it('covers comparison operators', async () => {
    const cases: Array<[string, string, string, boolean]> = [
      ['Equal', 'a', 'A', true],
      ['Not equal', 'a', 'b', true],
      ['Contains', 'abc', 'b', true],
      ['Does not contain', 'abc', 'z', true],
      ['Not contains', 'abc', 'z', true],
      ['Starts with', 'abc', 'ab', true],
      ['Does not start with', 'abc', 'z', true],
      ['Ends with', 'abc', 'bc', true],
      ['Does not end with', 'abc', 'z', true],
      ['Equal to', 'a', 'a', true],
      ['Is set', 'x', '', true],
      ['Is empty', '', '', true],
      ['Is not set', '', '', true],
      ['Is not set', 'x', '', false],
      ['Greater than', '5', '3', true],
      ['Less than', '2', '3', true],
      ['Greater than or equal', '3', '3', true],
      ['Greater than or equal', '2', '3', false],
      ['Less than or equal', '3', '3', true],
      ['Less than or equal', '4', '3', false],
      ['Is a number', '4.2', '', true],
      ['Is a number', 'abc', '', false],
      ['Is not a number', 'abc', '', true],
      ['Not a number', '12', '', false],
      ['Unknown op', 'a', 'a', false],
    ]
    for (const [op, val, cmp, expected] of cases) {
      const cond = {
        id: 'c',
        type: 'Condition',
        options: { items: [{ outgoingEdgeId: 'e1', comparisons: [{ variableId: 'v', comparisonOperator: op, value: cmp }] }] },
      }
      const r = await engine(
        def([
          { id: 'g1', blocks: [cond, textBlock('f', 'fall')] },
          { id: 'g2', blocks: [textBlock('b2', 'hit')] },
        ], [edge('e1', 'g2')]),
      ).start({}, { v: val })
      const hit = r.emissions[0]?.kind === 'text' && r.emissions[0].text === 'hit'
      expect(hit).toBe(expected)
    }
  })

  // Rails blank? parity: Nebula treats boolean false as blank, and V1 Code
  // blocks set flags to false expecting "Is not set" to match (bloqueio_numero
  // on "Boas Vindas" 3351 routes every unblocked contact through this).
  it('Is not set / Is set treat boolean false as blank (Nebula parity)', async () => {
    const mk = (op: string) => def([
      { id: 'g1', blocks: [
        { id: 'c', type: 'Condition', options: { items: [{ outgoingEdgeId: 'e1', comparisons: [{ variableId: 'flag', comparisonOperator: op, value: null }] }] } },
        textBlock('f', 'fall'),
      ] },
      { id: 'g2', blocks: [textBlock('b2', 'hit')] },
    ], [edge('e1', 'g2')])
    const notSet = await engine(mk('Is not set')).start({}, { flag: false })
    expect(notSet.emissions).toEqual([{ kind: 'text', text: 'hit' }])
    const isSet = await engine(mk('Is set')).start({}, { flag: false })
    expect(isSet.emissions).toEqual([{ kind: 'text', text: 'fall' }])
  })

  it('array comparison values match ANY element (builder persists arrays)', async () => {
    const mk = (value: unknown, v: string) => def([
      { id: 'g1', blocks: [
        { id: 'c', type: 'Condition', options: { items: [{ outgoingEdgeId: 'e1', comparisons: [{ variableId: 'v', comparisonOperator: 'Equal', value }] }] } },
        textBlock('f', 'fall'),
      ] },
      { id: 'g2', blocks: [textBlock('b2', 'hit')] },
    ], [edge('e1', 'g2')])
    const r1 = await engine(mk(['Não Respondeu', 'Outro'], 'não respondeu')).start({}, { v: 'não respondeu' })
    expect(r1.emissions).toEqual([{ kind: 'text', text: 'hit' }])
    // non-string array entries are stringified; null entries become ''
    const r2 = await engine(mk([1, null], '1')).start({}, { v: '1' })
    expect(r2.emissions).toEqual([{ kind: 'text', text: 'hit' }])
    const r3 = await engine(mk(['zzz'], 'abc')).start({}, { v: 'abc' })
    expect(r3.emissions).toEqual([{ kind: 'text', text: 'fall' }])
    // an EMPTY array value can never match
    const r4 = await engine(mk([], '')).start({}, { v: '' })
    expect(r4.emissions).toEqual([{ kind: 'text', text: 'fall' }])
  })

  it('variableId "context" matches ANY session variable (V1 cosmo-brain compat)', async () => {
    const mk = () => def([
      { id: 'g1', blocks: [
        { id: 'c', type: 'Condition', options: { items: [{ outgoingEdgeId: 'e1', comparisons: [{ variableId: 'context', comparisonOperator: 'Equal', value: 'OK' }] }] } },
        textBlock('f', 'fall'),
      ] },
      { id: 'g2', blocks: [textBlock('b2', 'hit')] },
    ], [edge('e1', 'g2')])
    // null-valued session vars stringify to '' rather than crashing
    const hit = await engine(mk()).start({}, { a: null, b: 'ok' })
    expect(hit.emissions).toEqual([{ kind: 'text', text: 'hit' }])
    const miss = await engine(mk()).start({}, { a: 'nope' })
    expect(miss.emissions).toEqual([{ kind: 'text', text: 'fall' }])
  })

  it('an item with no comparisons matches unconditionally (Nebula parity)', async () => {
    const r = await engine(def([
      { id: 'g1', blocks: [
        { id: 'c', type: 'Condition', options: { items: [{ outgoingEdgeId: 'e1', comparisons: [] }] } },
        textBlock('f', 'fall'),
      ] },
      { id: 'g2', blocks: [textBlock('b2', 'hit')] },
    ], [edge('e1', 'g2')])).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'hit' }])
  })

  it('an empty-comparisons item gates on options.businessHours when present', async () => {
    const WEEK = { tue_1: '09:00', tue_2: '18:00' }
    const mk = (businessHours: unknown) => def([
      { id: 'g1', blocks: [
        { id: 'c', type: 'Condition', options: { businessHours, items: [{ outgoingEdgeId: 'e1', comparisons: [] }] } },
        textBlock('f', 'fall'),
      ] },
      { id: 'g2', blocks: [textBlock('b2', 'open')] },
    ], [edge('e1', 'g2')])
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-04T15:00:00Z')) // Tuesday 15:00 UTC (no timezone on block → UTC)
      const open = await engine(mk(WEEK)).start()
      expect(open.emissions).toEqual([{ kind: 'text', text: 'open' }])
      vi.setSystemTime(new Date('2026-08-04T23:30:00Z')) // Tuesday 23:30 UTC — outside 09-18
      const closed = await engine(mk(WEEK)).start()
      expect(closed.emissions).toEqual([{ kind: 'text', text: 'fall' }])
      // a non-object businessHours value is ignored → unconditional match
      const junk = await engine(mk('not-a-schedule')).start()
      expect(junk.emissions).toEqual([{ kind: 'text', text: 'open' }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('FlowEngine handoff / note / end-session', () => {
  it('Cosmodesk (V3 keys) emits a handoff intent and stops', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'cd', type: 'Cosmodesk', options: { assigningMessage: 'Hold {{contact.name}}', teamId: 't1' } }] }]),
    ).start({ contact: { name: 'Zoe' } })
    expect(r.status).toBe('handoff')
    expect(r.intents).toEqual([{ type: 'handoff', message: 'Hold Zoe', teamId: 't1' }])
  })

  it('cosmodesk (V1 dual-form keys: message/team) still resolves', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'cd', type: 'cosmodesk', options: { message: 'transfer', team: 'legacy-team' } }] }]),
    ).start()
    expect(r.intents).toEqual([{ type: 'handoff', message: 'transfer', teamId: 'legacy-team' }])
  })

  it('Cosmodesk with no message yields null message', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'cd', type: 'Cosmodesk', options: {} }] }]),
    ).start()
    expect(r.intents[0]).toEqual({ type: 'handoff', message: null, teamId: null })
  })

  it('note adds a note intent and continues; empty note is skipped', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [
        { id: 'n1', type: 'note', options: { content: 'VIP {{contact.name}}' } },
        { id: 'n2', type: 'note', options: { content: '' } },
        textBlock('b', 'done'),
      ] }]),
    ).start({ contact: { name: 'Q' } })
    expect(r.intents).toEqual([{ type: 'note', body: 'VIP Q' }])
    expect(r.emissions).toEqual([{ kind: 'text', text: 'done' }])
  })

  it('end-session emits its message and completes', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'e', type: 'end-session', options: { message: 'Bye' } }, textBlock('after', 'never')] }]),
    ).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Bye' }])
  })

  it('end-session with no message just completes', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'e', type: 'end-session', options: {} }] }]),
    ).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([])
  })

  it('unknown block types are skipped', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'x', type: 'totally-unknown', options: {} }, textBlock('b', 'next')] }]),
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'next' }])
  })

  it('Code block runs via the sandbox (runCode), mutated vars flow downstream', async () => {
    const runCode = vi.fn(async (_code: string, vars: Record<string, unknown>) => ({
      ...vars,
      counter: 1,
    }))
    const eng = engine(
      def([{ id: 'g1', blocks: [
        { id: 'c', type: 'Code', options: { content: 'user.counter = 1' } },
        textBlock('b', 'c={{counter}}'),
      ] }]),
      'STRICT',
      { runCode },
    )
    const r = await eng.start()
    expect(runCode).toHaveBeenCalledWith('user.counter = 1', expect.any(Object))
    expect(r.emissions).toEqual([{ kind: 'text', text: 'c=1' }])
  })

  it('Code with no content is skipped; sandbox failure is swallowed (vars kept)', async () => {
    const skip = await engine(
      def([{ id: 'g1', blocks: [{ id: 'c', type: 'Script', options: {} }, textBlock('b', 'next')] }]),
    ).start()
    expect(skip.emissions).toEqual([{ kind: 'text', text: 'next' }])

    const runCode = vi.fn().mockRejectedValue(new Error('isolate timeout'))
    const failed = await engine(
      def([{ id: 'g1', blocks: [{ id: 'c', type: 'Code', options: { content: 'while(true){}' } }, textBlock('b', 'kept={{x}}')] }]),
      'STRICT',
      { runCode },
    ).start({}, { x: 'orig' })
    expect(failed.emissions).toEqual([{ kind: 'text', text: 'kept=orig' }])
  })

  it('Code with default (no-op) effects leaves variables unchanged and continues', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'c', type: 'Code', options: { content: 'user.x = 99' } }, textBlock('b', 'x={{x}}')] }]),
    ).start({}, { x: 'orig' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'x=orig' }])
  })
})

describe('FlowEngine webhook / api_call', () => {
  it('calls the effect, stores response + status + mapped var, then continues', async () => {
    const effects: FlowEffects = {
      httpRequest: vi.fn().mockResolvedValue({ status: 200, body: 'PONG' }),
    }
    const eng = engine(
      def([
        { id: 'g1', blocks: [
          { id: 'w', type: 'Webhook', options: { url: 'https://api.x/{{seed}}', method: 'POST', headers: { 'x-k': '{{seed}}' }, body: 'hi {{seed}}', responseMapping: { variableId: 'out' } }, outgoingEdgeId: 'e1' },
        ] },
        { id: 'g2', blocks: [textBlock('b2', 'r={{out}} s={{status_code}}')] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      effects,
    )
    const r = await eng.start({}, { seed: '7' })
    expect(effects.httpRequest).toHaveBeenCalledWith({
      url: 'https://api.x/7',
      method: 'POST',
      headers: { 'x-k': '7' },
      body: 'hi 7',
    })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'r=PONG s=200' }])
  })

  it('no url → skips the call and continues', async () => {
    const effects: FlowEffects = { httpRequest: vi.fn() }
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'w', type: 'Webhook', options: {} }] }]),
      'STRICT',
      effects,
    ).start()
    expect(effects.httpRequest).not.toHaveBeenCalled()
    expect(r.status).toBe('completed')
  })

  it('swallows a failed request (status 0) and continues', async () => {
    const effects: FlowEffects = {
      httpRequest: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const eng = engine(
      def([
        { id: 'g1', blocks: [{ id: 'w', type: 'api_call', options: { url: 'https://api.x' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [textBlock('b2', 's={{status_code}}')] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      effects,
    )
    const r = await eng.start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 's=0' }])
  })

  it('defaults method to POST and ignores non-object headers', async () => {
    const httpRequest = vi.fn().mockResolvedValue({ status: 204, body: null })
    await engine(
      def([{ id: 'g1', blocks: [{ id: 'w', type: 'webhook', options: { url: 'https://x', headers: 'bad' } }] }]),
      'STRICT',
      { httpRequest },
    ).start()
    expect(httpRequest).toHaveBeenCalledWith({ url: 'https://x', method: 'POST', headers: undefined, body: undefined })
  })

  it('with no effects port (default no-op) just continues', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'w', type: 'Webhook', options: { url: 'https://x' } }] }]),
    ).start()
    expect(r.status).toBe('completed')
  })
})

describe('FlowEngine redirect / webview / wait / ab-test / sub-flow / template', () => {
  it('redirect + webview emit the URL as text; empty is skipped', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [
        { id: 'r', type: 'Redirect', options: { url: 'https://go/{{seed}}' } },
        { id: 'w', type: 'Webview', options: {} },
      ] }]),
    ).start({}, { seed: 'p' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'https://go/p' }])
  })

  it('Wait is a no-op (continues immediately)', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'w', type: 'Wait', options: { seconds: 5 } }, textBlock('b', 'after')] }]),
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'after' }])
  })

  it('AB test routes to a weighted edge (deterministic via mocked random)', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.9) // → second bucket
    const flow = def([
      { id: 'g1', blocks: [{ id: 'ab', type: 'AB test', options: { items: [
        { outgoingEdgeId: 'e1', weight: 1 },
        { outgoingEdgeId: 'e2', weight: 1 },
      ] } }] },
      { id: 'g2', blocks: [textBlock('b2', 'A')] },
      { id: 'g3', blocks: [textBlock('b3', 'B')] },
    ], [edge('e1', 'g2'), edge('e2', 'g3')])
    const r = await engine(flow).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'B' }])
    rnd.mockReturnValue(0) // → first bucket
    const r2 = await engine(flow).start()
    expect(r2.emissions).toEqual([{ kind: 'text', text: 'A' }])
    rnd.mockRestore()
  })

  it('AB test with no edges / zero weights', async () => {
    const noEdges = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ab', type: 'AB test', options: { items: [{}] } }, textBlock('b', 'fall')] }]),
    ).start()
    expect(noEdges.emissions).toEqual([{ kind: 'text', text: 'fall' }])

    const zeroWeight = await engine(
      def([
        { id: 'g1', blocks: [{ id: 'ab', type: 'AB test', options: { items: [{ outgoingEdgeId: 'e1', weight: 0 }] } }] },
        { id: 'g2', blocks: [textBlock('b2', 'zw')] },
      ], [edge('e1', 'g2')]),
    ).start()
    expect(zeroWeight.emissions).toEqual([{ kind: 'text', text: 'zw' }])
  })

  it('Cosmoflow link jumps intra-flow; unknown target is a no-op', async () => {
    const intra = await engine(
      def([
        { id: 'g1', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { groupId: 'g2' } }] },
        { id: 'g2', blocks: [textBlock('b2', 'sub')] },
      ]),
    ).start()
    expect(intra.emissions).toEqual([{ kind: 'text', text: 'sub' }])

    const unknown = await engine(
      def([{ id: 'g1', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { groupId: 'elsewhere' } }, textBlock('b', 'here')] }]),
    ).start()
    expect(unknown.emissions).toEqual([{ kind: 'text', text: 'here' }])
  })

  it('Cosmoflow link enters a sub-flow and returns to the parent via the return edge', async () => {
    const sub = def([{ id: 'sg1', blocks: [textBlock('sb', 'from-sub')] }])
    const root = def(
      [
        { id: 'g1', blocks: [
          textBlock('pre', 'before'),
          { id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: '99' }, outgoingEdgeId: 'eret' },
        ] },
        { id: 'g2', blocks: [textBlock('post', 'after')] },
      ],
      [edge('eret', 'g2')],
    )
    const r = await engine(root, 'STRICT', undefined, new Map([['99', sub]])).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'text', text: 'from-sub' },
      { kind: 'text', text: 'after' },
    ])
  })

  it('sub-flow with no return edge unwinds to completion; nested sub-flows compose', async () => {
    const inner = def([{ id: 'i1', blocks: [textBlock('ib', 'inner')] }])
    const mid = def(
      [{ id: 'm1', blocks: [
        textBlock('mb', 'mid'),
        { id: 'ml', type: 'Cosmoflow link', options: { cosmoflowId: 'inner' }, outgoingEdgeId: 'me' },
      ] },
      { id: 'm2', blocks: [textBlock('mb2', 'mid-after')] }],
      [edge('me', 'm2')],
    )
    const root = def([{ id: 'g1', blocks: [
      { id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: 'mid' } }, // no return edge
      textBlock('never', 'unreached'),
    ] }])
    const r = await engine(root, 'STRICT', undefined, new Map<string, unknown>([['mid', mid], ['inner', inner]])).start()
    // root link has no return edge → after mid completes the whole flow ends;
    // mid itself composes inner then continues to mid-after before returning.
    expect(r.emissions).toEqual([
      { kind: 'text', text: 'mid' },
      { kind: 'text', text: 'inner' },
      { kind: 'text', text: 'mid-after' },
    ])
    expect(r.status).toBe('completed')
  })

  it('input inside a sub-flow pauses, then resume continues the parent', async () => {
    const sub = def([{ id: 'sg1', blocks: [
      { id: 'q', type: 'text input', options: { variableId: 'v1' }, outgoingEdgeId: null },
    ] }])
    const root = def(
      [
        { id: 'g1', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: '7' }, outgoingEdgeId: 'eret' }] },
        { id: 'g2', blocks: [textBlock('post', 'done={{v1}}')] },
      ],
      [edge('eret', 'g2')],
    )
    const eng = engine(root, 'STRICT', undefined, new Map([['7', sub]]))
    const first = await eng.start()
    expect(first.status).toBe('waiting')
    expect(first.state.currentFlowId).toBe('7')
    expect(first.state.stack).toHaveLength(1)
    const second = await eng.resume(first.state, { text: 'hi' })
    expect(second.status).toBe('completed')
    expect(second.emissions).toEqual([{ kind: 'text', text: 'done=hi' }])
  })

  it('link to an empty sub-flow (no start group) unwinds immediately via the return edge', async () => {
    const empty = { groups: [] } // no start group, no edges
    const root = def(
      [
        { id: 'g1', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: 'e' }, outgoingEdgeId: 'er' }] },
        { id: 'g2', blocks: [textBlock('post', 'after-empty')] },
      ],
      [edge('er', 'g2')],
    )
    const r = await engine(root, 'STRICT', undefined, new Map<string, unknown>([['e', empty]])).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'after-empty' }])
  })

  it('sub-flow def without an edges array falls back to no edges (block edge → completes)', async () => {
    const noEdges = { groups: [{ id: 'sg', blocks: [
      { id: 'sb', type: 'text', options: { content: 'sub-bubble' }, outgoingEdgeId: 'ghost-edge' },
    ] }] } // note: no `edges` key
    const root = def([{ id: 'g1', blocks: [
      { id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: 'n' }, outgoingEdgeId: null },
    ] }])
    const r = await engine(root, 'STRICT', undefined, new Map<string, unknown>([['n', noEdges]])).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'sub-bubble' }])
    expect(r.status).toBe('completed')
  })

  it('resume on a state pointing at an unknown flow completes safely', async () => {
    const eng = engine(def([{ id: 'g1', blocks: [textBlock('b', 'x')] }]))
    const ghost = emptyFlowState()
    ghost.currentFlowId = 'does-not-exist'
    ghost.currentGroupId = 'g1'
    ghost.currentBlockId = 'b'
    const r = await eng.resume(ghost, { text: 'hi' })
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([])
  })

  it('sub-flow recursion is bounded by MAX_SUBFLOW_DEPTH (deep distinct chain)', async () => {
    // Chain of 30 distinct sub-flows s0→s1→…, each linking the next with no
    // return edge. Distinct group ids dodge the per-group visit cap, so the
    // depth guard (not the visit cap) is what stops the descent.
    const subs = new Map<string, unknown>()
    for (let i = 0; i < 30; i += 1) {
      subs.set(`s${i}`, def([{ id: `gs${i}`, blocks: [
        textBlock(`t${i}`, `x${i}`),
        { id: `lk${i}`, type: 'Cosmoflow link', options: { cosmoflowId: `s${i + 1}` }, outgoingEdgeId: null },
      ] }]))
    }
    const root = def([{ id: 'g1', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: 's0' }, outgoingEdgeId: null }] }])
    const r = await engine(root, 'STRICT', undefined, subs).start()
    expect(r.status).toBe('completed')
    // Descends until the stack hits MAX_SUBFLOW_DEPTH (20), so ~20 levels emit.
    expect(r.emissions.length).toBe(20)
    expect(r.emissions[0]).toEqual({ kind: 'text', text: 'x0' })
  })

  it('WhatsApp Template emits a template intent (interpolated params); no name → skip', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 't', type: 'WhatsApp Template', options: { name: 'reminder', language: 'pt_BR', params: ['{{contact.name}}', '9h'] } }] }]),
    ).start({ contact: { name: 'Lia' } })
    expect(r.intents).toEqual([{ type: 'template', name: 'reminder', language: 'pt_BR', params: ['Lia', '9h'] }])

    const skip = await engine(
      def([{ id: 'g1', blocks: [{ id: 't', type: 'WhatsApp Template', options: {} }, textBlock('b', 'next')] }]),
    ).start()
    expect(skip.intents).toEqual([])
    expect(skip.emissions).toEqual([{ kind: 'text', text: 'next' }])
  })

  it('WhatsApp Template via templateName + variables (default language, non-string param coerced)', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 't', type: 'WhatsApp Template', options: { templateName: 'promo', variables: ['{{contact.name}}', 42, null] } }] }]),
    ).start({ contact: { name: 'Mo' } })
    expect(r.intents).toEqual([{ type: 'template', name: 'promo', language: 'pt_BR', params: ['Mo', '42', ''] }])
  })
})

describe('FlowEngine media bubbles + extra inputs', () => {
  it('image/video/audio/file emit media emissions (interpolated url + caption)', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [
        { id: 'i', type: 'image', options: { url: 'https://x/{{seed}}.png', caption: 'pic {{seed}}' } },
        { id: 'v', type: 'video', options: { src: 'https://x/v.mp4' } },
        { id: 'a', type: 'audio', options: { url: 'https://x/a.mp3' } },
        { id: 'f', type: 'file', options: { url: 'https://x/guia.pdf', caption: 'Guia' } },
      ] }]),
    ).start({}, { seed: '9' })
    expect(r.emissions).toEqual([
      { kind: 'media', mediaType: 'IMAGE', url: 'https://x/9.png', caption: 'pic 9' },
      { kind: 'media', mediaType: 'VIDEO', url: 'https://x/v.mp4', caption: null },
      { kind: 'media', mediaType: 'AUDIO', url: 'https://x/a.mp3', caption: null },
      { kind: 'media', mediaType: 'FILE', url: 'https://x/guia.pdf', caption: 'Guia' },
    ])
  })

  it('media with no url is skipped', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'i', type: 'image', options: {} }, textBlock('b', 'next')] }]),
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'next' }])
  })

  it('embed emits the URL as text; empty embed is skipped', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [
        { id: 'e', type: 'embed', options: { url: 'https://x/embed' } },
        { id: 'e2', type: 'embed', options: {} },
      ] }]),
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'https://x/embed' }])
  })

  it('cards emit each card title as text', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'c', type: 'cards', options: { items: [{ title: 'Card A' }, { imageUrl: 'x' }, { title: 'Card B' }] } }] }]),
    ).start()
    expect(r.emissions).toEqual([
      { kind: 'text', text: 'Card A' },
      { kind: 'text', text: 'Card B' },
    ])
  })

  it('payment input is not an input: the flow runs straight past it', async () => {
    // Cosmika has no payment block. An imported flow that carries one must
    // not park the conversation waiting for a reply that never comes.
    const r = await engine(
      def([
        { id: 'g1', blocks: [
          { id: 'pay', type: 'payment input', options: { variableId: 'v' } },
          textBlock('b2', 'after'),
        ] },
      ]),
    ).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'after' }])
  })

  it('file / rating inputs wait then capture the reply', async () => {
    for (const type of ['file input', 'rating input']) {
      const eng = engine(
        def([
          { id: 'g1', blocks: [{ id: 'in', type, options: { variableId: 'v' }, outgoingEdgeId: 'e1' }] },
          { id: 'g2', blocks: [textBlock('b2', 'got {{v}}')] },
        ], [edge('e1', 'g2')]),
      )
      const started = await eng.start()
      expect(started.status).toBe('waiting')
      const r = await eng.resume(started.state, { text: 'answer' })
      expect(r.emissions).toEqual([{ kind: 'text', text: 'got answer' }])
    }
  })
})

describe('FlowEngine OpenAI + provider integrations', () => {
  it('OpenAI block calls llm, emits the reply, stores it in the mapped var', async () => {
    const llm = vi.fn().mockResolvedValue({ kind: 'text', text: 'AI says hi' })
    const eng = engine(
      def([
        { id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'help {{seed}}', systemPrompt: 'be nice', responseMapping: { variableId: 'a' } }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [textBlock('b2', 'stored={{a}}')] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      { llm },
    )
    const r = await eng.start({}, { seed: 'X' })
    // `silent` rides along so the runner can tell a paid customer-facing
    // reply from an internal classifier before it decides to spend.
    expect(llm).toHaveBeenCalledWith({
      systemPrompt: 'be nice',
      userText: 'help X',
      silent: false,
    })
    expect(r.emissions).toEqual([
      { kind: 'text', text: 'AI says hi', ai: true },
      { kind: 'text', text: 'stored=AI says hi' },
    ])
  })

  // The runner refuses to spend when the account's AI budget is gone. The
  // engine must stop there: continuing would branch the rest of the flow on a
  // variable the model never filled.
  it('a blocked AI call becomes a handoff, with a note, and stops the flow', async () => {
    const llm = vi.fn().mockResolvedValue({
      kind: 'blocked',
      message: 'A colleague will take it from here.',
      note: 'Monthly AI budget spent.',
    })
    const eng = engine(
      def([
        { id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'help', responseMapping: { variableId: 'a' } }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [textBlock('b2', 'never reached')] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      { llm },
    )

    const r = await eng.start()

    expect(r.status).toBe('handoff')
    expect(r.intents).toEqual([
      { type: 'note', body: 'Monthly AI budget spent.' },
      { type: 'handoff', message: 'A colleague will take it from here.', teamId: null },
    ])
    expect(r.emissions).toEqual([])
  })

  it('a silent blocked block still stops rather than storing an empty answer', async () => {
    const llm = vi.fn().mockResolvedValue({
      kind: 'blocked', message: 'm', note: 'n',
    })
    const r = await engine(
      def([
        { id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'p', sendMessage: false, responseVariableId: 'v' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [textBlock('b2', 'v=[{{v}}]')] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      { llm },
    ).start()

    expect(r.status).toBe('handoff')
    expect(r.emissions).toEqual([])
  })

  it('OpenAI with no prompt skips; llm failure is swallowed', async () => {
    const skip = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ai', type: 'openai', options: {} }, textBlock('b', 'next')] }]),
    ).start()
    expect(skip.emissions).toEqual([{ kind: 'text', text: 'next' }])

    const llm = vi.fn().mockRejectedValue(new Error('down'))
    const failed = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'x', responseVariableId: 'r' } }, textBlock('b', 'r=[{{r}}]')] }]),
      'STRICT',
      { llm },
    ).start()
    expect(failed.emissions).toEqual([{ kind: 'text', text: 'r=[]' }])
  })

  it('provider integration merges variables + emits returned text; failure swallowed', async () => {
    const integration = vi.fn().mockResolvedValue({ variables: { rows: 3 }, text: 'Saved!' })
    const eng = engine(
      def([
        { id: 'g1', blocks: [{ id: 's', type: 'Google Sheets', options: { spreadsheetId: 'sid', action: 'Insert' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [textBlock('b2', 'rows={{rows}}')] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      { integration },
    )
    const r = await eng.start()
    expect(integration).toHaveBeenCalledWith('Google Sheets', { spreadsheetId: 'sid', action: 'Insert' }, expect.any(Object))
    expect(r.emissions).toEqual([
      { kind: 'text', text: 'Saved!' },
      { kind: 'text', text: 'rows=3' },
    ])
  })

  it('integration failure is swallowed (block continues)', async () => {
    const integration = vi.fn().mockRejectedValue(new Error('provider down'))
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 't', type: 'Ticket Create', options: {} }, textBlock('b', 'next')] }]),
      'STRICT',
      { integration },
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'next' }])
  })

  it('default no-op effects: OpenAI (empty reply) + integration (no vars/text) just continue', async () => {
    const ai = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'x', responseVariableId: 'r' } }, textBlock('b', 'r=[{{r}}]')] }]),
    ).start()
    expect(ai.emissions).toEqual([{ kind: 'text', text: 'r=[]' }])

    // no `options` wrapper → engine reads fields off the block itself
    const integ = await engine(
      def([{ id: 'g1', blocks: [{ id: 's', type: 'Email', to: 'x@y.com' }, textBlock('b', 'next')] }]),
    ).start()
    expect(integ.emissions).toEqual([{ kind: 'text', text: 'next' }])
  })
})

describe('FlowEngine choice input', () => {
  const choice = {
    id: 'ci',
    type: 'choice input',
    options: {
      message: 'Pick',
      items: [
        { id: 'i1', content: 'Sales', outgoingEdgeId: 'e1' },
        { id: 'i2', content: 'Support', outgoingEdgeId: 'e2' },
        { id: 'i3', content: 'No edge' },
      ],
    },
  }
  const flow = () =>
    def(
      [
        { id: 'g1', blocks: [choice] },
        { id: 'g2', blocks: [textBlock('b2', 'sales!')] },
        { id: 'g3', blocks: [textBlock('b3', 'support!')] },
      ],
      [edge('e1', 'g2'), edge('e2', 'g3')],
    )

  it('emits buttons and waits', async () => {
    const r = await engine(flow()).start()
    expect(r.status).toBe('waiting')
    expect(r.emissions).toEqual([
      {
        kind: 'interactive',
        content: {
          kind: 'buttons',
          body: 'Pick',
          buttons: [
            { id: 'i1', label: 'Sales' },
            { id: 'i2', label: 'Support' },
            { id: 'i3', label: 'No edge' },
          ],
        },
      },
    ])
    expect(r.state.currentBlockId).toBe('ci')
  })

  it('resume routes by selected item id', async () => {
    const eng = engine(flow())
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: '', interactiveReplyId: 'i2' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'support!' }])
  })

  it('resume routes by edge id (WA dual-match)', async () => {
    const eng = engine(flow())
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: '', interactiveReplyId: 'e1' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'sales!' }])
  })

  it('resume routes by label text when no payload id', async () => {
    const eng = engine(flow())
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'support' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'support!' }])
  })

  it('matched item without an edge continues (no next block → completes)', async () => {
    const eng = engine(flow())
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: '', interactiveReplyId: 'i3' })
    expect(r.status).toBe('completed')
  })

  it('no match retries (waiting) then gives up after MAX retries', async () => {
    const eng = engine(flow())
    let s = (await eng.start()).state
    for (let i = 0; i < 3; i += 1) {
      const r = await eng.resume(s, { text: 'nonsense' })
      expect(r.status).toBe('waiting')
      s = r.state
    }
    const final = await eng.resume(s, { text: 'nonsense' })
    expect(final.status).toBe('completed')
  })

  it('choice block with zero items emits no buttons', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: [] } }] }]),
    ).start()
    expect(r.status).toBe('waiting')
    expect(r.emissions).toEqual([])
  })

  it('button label falls back + truncates to 20 chars; id falls back to edge', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: [
        { outgoingEdgeId: 'eX', content: 'this label is definitely longer than twenty chars' },
        { id: 'i2', content: '' },
      ] } }] }]),
    ).start()
    const content = r.emissions[0]!.kind === 'interactive' ? r.emissions[0].content : null
    expect(content?.kind === 'buttons' && content.buttons[0]).toEqual({ id: 'eX', label: 'this label is defini' })
    expect(content?.kind === 'buttons' && content.buttons[1]).toEqual({ id: 'i2', label: '·' })
  })

  it('retry emits a configured retry message', async () => {
    const eng = engine(
      def([{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: [{ id: 'i1', content: 'A', outgoingEdgeId: 'e1' }], retryMessage: 'Please pick A' } }] }]),
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'zzz' })
    expect(r.status).toBe('waiting')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Please pick A' }])
  })
})

describe('FlowEngine typed inputs', () => {
  function inputFlow(type: string, varId = 'v', edgeAfter?: string) {
    return def(
      [
        { id: 'g1', blocks: [{ id: 'in', type, options: { variableId: varId }, outgoingEdgeId: edgeAfter ?? null }] },
        { id: 'g2', blocks: [textBlock('b2', 'after={{v}}')] },
      ],
      edgeAfter ? [edge(edgeAfter, 'g2')] : [],
    )
  }

  it('text input waits (no prompt emission) then captures + advances via edge', async () => {
    const eng = engine(inputFlow('text input', 'v', 'e1'))
    const started = await eng.start()
    expect(started.status).toBe('waiting')
    expect(started.emissions).toEqual([])
    const r = await eng.resume(started.state, { text: 'hello' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'after=hello' }])
  })

  it('captures to no variable when variableId is absent, advances to next block in group', async () => {
    const eng = engine(
      def([{ id: 'g1', blocks: [{ id: 'in', type: 'text input', options: {} }, textBlock('b', 'ok')] }]),
    )
    const r = await eng.resume((await eng.start()).state, { text: 'x' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'ok' }])
  })

  it('email validation: invalid retries, valid advances', async () => {
    const eng = engine(inputFlow('email input', 'v', 'e1'))
    const s = (await eng.start()).state
    const bad = await eng.resume(s, { text: 'not-an-email' })
    expect(bad.status).toBe('waiting')
    const good = await eng.resume(bad.state, { text: 'a@b.com' })
    expect(good.emissions).toEqual([{ kind: 'text', text: 'after=a@b.com' }])
  })

  it('validates number / phone / url / empty', async () => {
    const ok = async (type: string, val: string) =>
      (await engine(inputFlow(type, 'v', 'e1')).resume(
        { ...emptyFlowState(), currentGroupId: 'g1', currentBlockId: 'in' },
        { text: val },
      )).status
    expect(await ok('number input', '42')).toBe('completed')
    expect(await ok('number input', 'abc')).toBe('waiting')
    expect(await ok('phone number input', '+55 11 99999-9999')).toBe('completed')
    expect(await ok('phone input', '12')).toBe('waiting')
    expect(await ok('url input', 'https://x.com')).toBe('completed')
    expect(await ok('url input', 'nope')).toBe('waiting')
    expect(await ok('text input', '')).toBe('waiting')
  })

  it('typed input gives up after MAX retries and follows its edge', async () => {
    const eng = engine(inputFlow('email input', 'v', 'e1'))
    let s = (await eng.start()).state
    for (let i = 0; i < 3; i += 1) s = (await eng.resume(s, { text: 'bad' })).state
    const final = await eng.resume(s, { text: 'still-bad' })
    expect(final.emissions).toEqual([{ kind: 'text', text: 'after=' }])
  })
})

describe('FlowEngine GUIDED mode (deviation signalling)', () => {
  const choiceFlow = () =>
    def(
      [
        { id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { message: 'Pick', items: [{ id: 'i1', content: 'A', outgoingEdgeId: 'e1' }] } }] },
        { id: 'g2', blocks: [textBlock('b2', 'picked A')] },
      ],
      [edge('e1', 'g2')],
    )

  it('choice no-match returns deviation (not retry) + keeps the block position', async () => {
    const eng = engine(choiceFlow(), 'GUIDED')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'something off-script' })
    expect(r.status).toBe('deviation')
    expect(r.state.currentBlockId).toBe('ci')
    expect(r.emissions).toEqual([])
  })

  it('choice still routes deterministically on a match in GUIDED', async () => {
    const eng = engine(choiceFlow(), 'GUIDED')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'A' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'picked A' }])
  })

  it('typed-input invalid returns deviation in GUIDED', async () => {
    const eng = engine(
      def([{ id: 'g1', blocks: [{ id: 'in', type: 'email input', options: { variableId: 'v' } }] }]),
      'GUIDED',
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'not-an-email' })
    expect(r.status).toBe('deviation')
    expect(r.state.currentBlockId).toBe('in')
  })
})

describe('FlowEngine.resume edge cases', () => {
  it('returns completed when there is no pending input', async () => {
    const r = await engine(def([{ id: 'g1', blocks: [] }])).resume(emptyFlowState(), { text: 'x' })
    expect(r.status).toBe('completed')
  })

  it('returns completed when the paused block no longer exists', async () => {
    const r = await engine(def([{ id: 'g1', blocks: [] }])).resume(
      { ...emptyFlowState(), currentGroupId: 'g1', currentBlockId: 'gone' },
      { text: 'x' },
    )
    expect(r.status).toBe('completed')
  })
})

describe('FlowEngine.blockAt', () => {
  const eng = engine(def([{ id: 'g1', blocks: [textBlock('b1', 'x')] }]))
  it('returns null for null group/block ids', () => {
    expect(eng.blockAt(null, 'b1')).toBeNull()
    expect(eng.blockAt('g1', null)).toBeNull()
  })
  it('returns null for a missing block', () => {
    expect(eng.blockAt('g1', 'nope')).toBeNull()
    expect(eng.blockAt('gnone', 'b1')).toBeNull()
  })
  it('returns the block when found', () => {
    expect(eng.blockAt('g1', 'b1')).toMatchObject({ id: 'b1', type: 'text' })
  })
})

describe('FlowEngine coverage edges', () => {
  it('interpolates contact.email / contact.phone (+ aliases) and {{var|default}} with a value', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [textBlock('b1', '{{contact.email}} {{phone}} {{seed|fb}}')] }]),
    ).start({ contact: { email: 'a@b.com', phoneNumber: '+55' } }, { seed: 'S' })
    expect(r.emissions[0]).toEqual({ kind: 'text', text: 'a@b.com +55 S' })
  })

  it('text block reads options.text and a top-level content fallback', async () => {
    const fromText = await engine(
      def([{ id: 'g1', blocks: [{ id: 'b', type: 'text', options: { text: 'via-text' } }] }]),
    ).start()
    expect(fromText.emissions).toEqual([{ kind: 'text', text: 'via-text' }])
    const fromTopLevel = await engine(
      def([{ id: 'g1', blocks: [{ id: 'b', type: 'text', content: 'top-level' }] }]),
    ).start()
    expect(fromTopLevel.emissions).toEqual([{ kind: 'text', text: 'top-level' }])
  })

  it('Set variable with no value stores empty string; note with no content is skipped', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [
        { id: 'sv', type: 'Set variable', options: { variableId: 'x' } },
        { id: 'n', type: 'note', options: {} },
        textBlock('b', 'x=[{{x}}]'),
      ] }]),
    ).start()
    expect(r.intents).toEqual([])
    expect(r.emissions).toEqual([{ kind: 'text', text: 'x=[]' }])
  })

  it('Condition reads the `operator` key and defaults to Equal when absent', async () => {
    const cond = (cmp: Record<string, unknown>) => ({
      id: 'c', type: 'Condition', options: { items: [{ outgoingEdgeId: 'e1', comparisons: [cmp] }] },
    })
    const flow = (cmp: Record<string, unknown>) =>
      def([
        { id: 'g1', blocks: [cond(cmp), textBlock('f', 'fall')] },
        { id: 'g2', blocks: [textBlock('b2', 'hit')] },
      ], [edge('e1', 'g2')])
    // `operator` (not comparisonOperator)
    const viaOperator = await engine(flow({ variableId: 'v', operator: 'Equal', value: 'yes' })).start({}, { v: 'yes' })
    expect(viaOperator.emissions).toEqual([{ kind: 'text', text: 'hit' }])
    // neither key → defaults to Equal
    const viaDefault = await engine(flow({ variableId: 'v', value: 'yes' })).start({}, { v: 'yes' })
    expect(viaDefault.emissions).toEqual([{ kind: 'text', text: 'hit' }])
  })

  it('choice item with neither id nor edge gets an empty id; non-array items → no buttons', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: [{ content: 'Solo' }] } }] }]),
    ).start()
    const content = r.emissions[0]!.kind === 'interactive' ? r.emissions[0].content : null
    expect(content?.kind === 'buttons' && content.buttons[0]).toEqual({ id: '', label: 'Solo' })

    const nonArray = await engine(
      def([{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: 'nope' } }] }]),
    ).start()
    expect(nonArray.emissions).toEqual([])
  })

  it('webhook headers map with no string values resolves to undefined headers', async () => {
    const httpRequest = vi.fn().mockResolvedValue({ status: 200, body: null })
    await engine(
      def([{ id: 'g1', blocks: [{ id: 'w', type: 'Webhook', options: { url: 'https://x', headers: { n: 123 } } }] }]),
      'STRICT',
      { httpRequest },
    ).start()
    expect(httpRequest.mock.calls[0]![0].headers).toBeUndefined()
  })

  it('resolves absent contact fields to empty; fully-empty text block emits nothing', async () => {
    const r = await engine(
      def([{ id: 'g1', blocks: [
        textBlock('b1', '[{{contact.email}}][{{contact.phone}}]'),
        { id: 'empty', type: 'text', options: {} },
      ] }]),
    ).start({ contact: {} })
    expect(r.emissions).toEqual([{ kind: 'text', text: '[][]' }])
  })

  it('choice item without a content key + a bare condition comparison', async () => {
    // label-match resume iterates items, exercising the content `?? ''` fallback
    const eng = engine(
      def([
        { id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: [
          { id: 'i1', content: 'Yes', outgoingEdgeId: 'e1' },
          { id: 'i2' }, // no content
        ] } }] },
        { id: 'g2', blocks: [textBlock('b2', 'yes!')] },
      ], [edge('e1', 'g2')]),
    )
    const s = (await eng.start()).state
    // a non-matching reply forces the find to scan the content-less item too
    const miss = await eng.resume(s, { text: 'zzz' })
    expect(miss.status).toBe('waiting')
    const r = await eng.resume(miss.state, { text: 'yes' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'yes!' }])

    // comparison with neither variableId nor value → both resolve to ''
    const condR = await engine(
      def([
        { id: 'g1', blocks: [{ id: 'c', type: 'Condition', options: { items: [{ outgoingEdgeId: 'e1', comparisons: [{ comparisonOperator: 'Is empty' }] }] } }, textBlock('f', 'fall')] },
        { id: 'g2', blocks: [textBlock('b2', 'empty-hit')] },
      ], [edge('e1', 'g2')]),
    ).start()
    expect(condR.emissions).toEqual([{ kind: 'text', text: 'empty-hit' }])
  })

  it('webhook responseVariableId (no responseMapping) maps the response', async () => {
    const httpRequest = vi.fn().mockResolvedValue({ status: 200, body: 'X' })
    const eng = engine(
      def([
        { id: 'g1', blocks: [{ id: 'w', type: 'Webhook', options: { url: 'https://x', responseVariableId: 'out' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [textBlock('b2', 'r={{out}}')] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      { httpRequest },
    )
    const r = await eng.start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'r=X' }])
  })
})

describe('emptyFlowState', () => {
  it('is a clean zero state', () => {
    expect(emptyFlowState()).toEqual({
      currentFlowId: '$root',
      stack: [],
      currentGroupId: null,
      currentBlockId: null,
      variables: {},
      retryCounts: {},
      visitCounts: {},
    })
  })
})

describe('FlowEngine item-edge fallback (migrated from.itemId branches)', () => {
  it('choice branch resolves via edges[].from.itemId when the item has no outgoingEdgeId', async () => {
    // Item carries NO outgoingEdgeId — the branch lives only on the edge.
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'c', type: 'choice input', options: { items: [
            { id: 'i_yes', content: 'Sim' },
            { id: 'i_no', content: 'Não' },
          ] } },
        ] },
        { id: 'gYes', blocks: [textBlock('ty', 'você disse sim')] },
        { id: 'gNo', blocks: [textBlock('tn', 'você disse não')] },
      ],
      [
        { id: 'eYes', from: { blockId: 'c', itemId: 'i_yes' }, to: { groupId: 'gYes' } },
        { id: 'eNo', from: { blockId: 'c', itemId: 'i_no' }, to: { groupId: 'gNo' } },
      ],
    )
    const eng = engine(d)
    const first = await eng.start()
    expect(first.status).toBe('waiting')
    const yes = await eng.resume(first.state, { text: 'Sim' })
    expect(yes.emissions).toEqual([{ kind: 'text', text: 'você disse sim' }])

    const eng2 = engine(d)
    const s2 = await eng2.start()
    const no = await eng2.resume(s2.state, { text: '', interactiveReplyId: 'i_no' })
    expect(no.emissions).toEqual([{ kind: 'text', text: 'você disse não' }])
  })

  it("item's own outgoingEdgeId still wins over the edges[] fallback", async () => {
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'c', type: 'choice input', options: { items: [
            { id: 'i1', content: 'A', outgoingEdgeId: 'eDirect' },
          ] } },
        ] },
        { id: 'gDirect', blocks: [textBlock('td', 'direct')] },
        { id: 'gFallback', blocks: [textBlock('tf', 'fallback')] },
      ],
      [
        { id: 'eDirect', from: { blockId: 'c' }, to: { groupId: 'gDirect' } },
        { id: 'eFb', from: { blockId: 'c', itemId: 'i1' }, to: { groupId: 'gFallback' } },
      ],
    )
    const eng = engine(d)
    const s = await eng.start()
    const r = await eng.resume(s.state, { text: 'A' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'direct' }])
  })

  it('Condition branch resolves via edges[].from.itemId fallback', async () => {
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'set', type: 'Set variable', options: { variableId: 'plan', value: 'pro' } },
          { id: 'cond', type: 'Condition', options: { items: [
            { id: 'ci', comparisons: [{ variableId: 'plan', comparisonOperator: 'Equal', value: 'pro' }] },
          ] } },
        ] },
        { id: 'gPro', blocks: [textBlock('tp', 'plano pro')] },
      ],
      [{ id: 'ec', from: { blockId: 'cond', itemId: 'ci' }, to: { groupId: 'gPro' } }],
    )
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'plano pro' }])
  })

  it('AB-test weighted pick resolves item edges via the fallback', async () => {
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'ab', type: 'AB test', options: { items: [
            { id: 'a1', weight: 100 }, // 100% → deterministic
            { id: 'a2', weight: 0 },
          ] } },
        ] },
        { id: 'gA', blocks: [textBlock('ta', 'bucket A')] },
        { id: 'gB', blocks: [textBlock('tb', 'bucket B')] },
      ],
      [
        { id: 'ea', from: { blockId: 'ab', itemId: 'a1' }, to: { groupId: 'gA' } },
        { id: 'eb', from: { blockId: 'ab', itemId: 'a2' }, to: { groupId: 'gB' } },
      ],
    )
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'bucket A' }])
  })

  it('unmatched item / missing id → no edge (falls through)', async () => {
    const d = def([{ id: 'g1', blocks: [
      { id: 'c', type: 'choice input', options: { items: [{ content: 'no-id' }] } },
      textBlock('after', 'após'),
    ] }])
    const eng = engine(d)
    const s = await eng.start()
    const r = await eng.resume(s.state, { text: 'no-id' })
    // matched by label, but item has no id + no edge → continue to next block
    expect(r.emissions).toEqual([{ kind: 'text', text: 'após' }])
  })
})

describe('FlowEngine Condition — nested Typebot item.content.comparisons (V1-import shape)', () => {
  it('matches comparisons nested under item.content and follows the item edge', async () => {
    // All 179 migrated condition items store rules at item.content.comparisons.
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'sv', type: 'Set variable', options: { variableId: 'resposta', value: 'Concordo' } },
          { id: 'c', type: 'Condition', options: { items: [
            {
              id: 'i1',
              content: {
                comparisons: [{ value: 'Concordo', variableId: 'resposta', comparisonOperator: 'Starts with' }],
                logicalOperator: 'AND',
              },
              outgoingEdgeId: 'eTrue',
            },
          ] }, outgoingEdgeId: 'eFalse' },
          textBlock('f', 'else-path'),
        ] },
        { id: 'g2', blocks: [textBlock('b2', 'matched')] },
        { id: 'g3', blocks: [textBlock('b3', 'unmatched')] },
      ],
      [edge('eTrue', 'g2'), edge('eFalse', 'g3')],
    )
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'matched' }])
  })

  it('nested logicalOperator OR is honored', async () => {
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'sv', type: 'Set variable', options: { variableId: 'v', value: 'bbb' } },
          { id: 'c', type: 'Condition', options: { items: [
            {
              id: 'i1',
              content: {
                comparisons: [
                  { value: 'aaa', variableId: 'v', comparisonOperator: 'Equal' },
                  { value: 'bbb', variableId: 'v', comparisonOperator: 'Equal' },
                ],
                logicalOperator: 'OR',
              },
              outgoingEdgeId: 'e1',
            },
          ] } },
          textBlock('f', 'fell-through'),
        ] },
        { id: 'g2', blocks: [textBlock('b2', 'or-hit')] },
      ],
      [edge('e1', 'g2')],
    )
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'or-hit' }])
  })

  it('flat item.comparisons wins over nested content when both exist', async () => {
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'sv', type: 'Set variable', options: { variableId: 'v', value: 'flat' } },
          { id: 'c', type: 'Condition', options: { items: [
            {
              id: 'i1',
              comparisons: [{ value: 'flat', variableId: 'v', comparisonOperator: 'Equal' }],
              content: {
                comparisons: [{ value: 'nested-no-match', variableId: 'v', comparisonOperator: 'Equal' }],
              },
              outgoingEdgeId: 'e1',
            },
          ] } },
          textBlock('f', 'no'),
        ] },
        { id: 'g2', blocks: [textBlock('b2', 'flat-wins')] },
      ],
      [edge('e1', 'g2')],
    )
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'flat-wins' }])
  })

  it('string content (choice-style label) has no comparisons — matches unconditionally (Nebula parity)', async () => {
    // Nebula's engine treats an item with no comparisons as a pass-through
    // branch (`comparisons.empty? → true`), so label-only items follow their
    // edge. Previously Cosmika ignored them, which dead-ended migrated flows.
    const d = def(
      [
        { id: 'g1', blocks: [
          { id: 'c', type: 'Condition', options: { items: [
            { id: 'i1', content: 'just a label', outgoingEdgeId: 'e1' },
          ] } },
          textBlock('f', 'fall'),
        ] },
        { id: 'g2', blocks: [textBlock('b2', 'followed')] },
      ],
      [edge('e1', 'g2')],
    )
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'followed' }])
  })
})

// ─── migrated (Typebot/V1-import) text content shapes ────────────────────

describe('FlowEngine migrated text content shapes', () => {
  it('emits from object content.plainText (migrated Nebula blocks)', async () => {
    const d = def([
      {
        id: 'g1',
        blocks: [
          {
            id: 'b1',
            type: 'text',
            content: { plainText: 'Bem-vindo(a) à Central de Suporte' },
          },
        ],
      },
    ])
    const r = await engine(d).start()
    expect(r.emissions).toEqual([
      { kind: 'text', text: 'Bem-vindo(a) à Central de Suporte' },
    ])
  })

  it('falls back to joining richText leaves when plainText is absent', async () => {
    const d = def([
      {
        id: 'g1',
        blocks: [
          {
            id: 'b1',
            type: 'text',
            content: {
              richText: [
                { children: [{ text: 'Olá ' }, { text: 'mundo' }] },
                { text: 'linha 2' },
                42, // non-object leaf → ignored
                { bold: true }, // no text, no children → ignored
              ],
            },
          },
        ],
      },
    ])
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Olá mundo\nlinha 2\n\n' }])
  })

  it('string content via options.text still works', async () => {
    const d = def([
      { id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { text: 'oi' } }] },
    ])
    const r = await engine(d).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'oi' }])
  })

  it('object content with neither plainText nor richText emits nothing', async () => {
    const d = def([
      { id: 'g1', blocks: [{ id: 'b1', type: 'text', content: { html: '<b>x</b>' } }] },
    ])
    const r = await engine(d).start()
    expect(r.emissions).toEqual([])
  })

  it('block with no content at all emits nothing', async () => {
    const d = def([{ id: 'g1', blocks: [{ id: 'b1', type: 'text' }] }])
    const r = await engine(d).start()
    expect(r.emissions).toEqual([])
  })
})

// ─── business-hours condition (migrated Nebula gate) ─────────────────────

import { isWithinBusinessHours } from './flow-engine'

const WEEK_9_18 = {
  mon_1: '09:00', mon_2: '18:00',
  tue_1: '09:00', tue_2: '18:00',
  wed_1: '09:00', wed_2: '18:00',
  thu_1: '09:00', thu_2: '18:00',
  fri_1: '09:00', fri_2: '18:00',
  sat_1: null, sat_2: null,
  sun_1: null, sun_2: null,
}

describe('isWithinBusinessHours', () => {
  // 2026-08-04 is a Tuesday. 15:00Z = 12:00 in São Paulo (UTC-3).
  const tueNoonSp = new Date('2026-08-04T15:00:00Z')
  const tueEveningSp = new Date('2026-08-04T22:30:00Z') // 19:30 SP — after close
  const tueEarlySp = new Date('2026-08-04T11:30:00Z') // 08:30 SP — before open
  const satSp = new Date('2026-08-08T15:00:00Z') // Saturday — closed day

  it('true inside the window, in the given timezone', () => {
    expect(isWithinBusinessHours(WEEK_9_18, 'America/Sao_Paulo', tueNoonSp)).toBe(true)
  })

  it('false after closing / before opening', () => {
    expect(isWithinBusinessHours(WEEK_9_18, 'America/Sao_Paulo', tueEveningSp)).toBe(false)
    expect(isWithinBusinessHours(WEEK_9_18, 'America/Sao_Paulo', tueEarlySp)).toBe(false)
  })

  it('false on a closed (null) day', () => {
    expect(isWithinBusinessHours(WEEK_9_18, 'America/Sao_Paulo', satSp)).toBe(false)
  })

  it('false when the closing slot is missing or empty', () => {
    expect(
      isWithinBusinessHours({ ...WEEK_9_18, tue_2: null }, 'America/Sao_Paulo', tueNoonSp),
    ).toBe(false)
    expect(
      isWithinBusinessHours({ ...WEEK_9_18, tue_2: '' }, 'America/Sao_Paulo', tueNoonSp),
    ).toBe(false)
    expect(
      isWithinBusinessHours({ ...WEEK_9_18, tue_1: '' }, 'America/Sao_Paulo', tueNoonSp),
    ).toBe(false)
  })

  it('false without a schedule at all', () => {
    expect(isWithinBusinessHours(undefined, 'America/Sao_Paulo', tueNoonSp)).toBe(false)
  })

  it('a second shift keeps the lunch break closed', () => {
    // 07:00-12:00 and 13:30-18:00, the "morning and afternoon" schedule.
    const split = { tue_1: '07:00', tue_2: '12:00', tue_3: '13:30', tue_4: '18:00' }
    const at = (hhmmUtc: string) => new Date(`2026-08-04T${hhmmUtc}:00Z`)
    expect(isWithinBusinessHours(split, 'America/Sao_Paulo', at('14:00'))).toBe(true) // 11:00
    expect(isWithinBusinessHours(split, 'America/Sao_Paulo', at('15:30'))).toBe(false) // 12:30, lunch
    expect(isWithinBusinessHours(split, 'America/Sao_Paulo', at('17:00'))).toBe(true) // 14:00
    expect(isWithinBusinessHours(split, 'America/Sao_Paulo', at('21:30'))).toBe(false) // 18:30
    // A second shift missing its closing time is ignored, not left open-ended.
    expect(
      isWithinBusinessHours({ ...split, tue_4: '' }, 'America/Sao_Paulo', at('17:00')),
    ).toBe(false)
  })

  it('falls back to UTC on an unknown timezone', () => {
    // 15:00Z is within 09–18 UTC even though the tz string is garbage.
    expect(isWithinBusinessHours(WEEK_9_18, 'Not/A_Zone', tueNoonSp)).toBe(true)
  })
})

describe('FlowEngine business_hours condition', () => {
  function bhFlow() {
    return def(
      [
        {
          id: 'g1',
          blocks: [
            {
              id: 'c1',
              type: 'Condition',
              items: [{ id: 'i1', content: { label: 'open' }, outgoingEdgeId: 'e-open' }],
              options: {
                conditionType: 'business_hours',
                timezone: 'America/Sao_Paulo',
                businessHours: WEEK_9_18,
              },
              outgoingEdgeId: 'e-closed',
            },
          ],
        },
        { id: 'g-open', blocks: [textBlock('bo', 'estamos abertos')] },
        { id: 'g-closed', blocks: [textBlock('bc', 'fora do horário')] },
      ],
      [edge('e-open', 'g-open'), edge('e-closed', 'g-closed')],
    )
  }

  it('takes the item edge inside business hours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T15:00:00Z')) // 12:00 SP, Tuesday
    try {
      const r = await engine(bhFlow()).start()
      expect(r.emissions).toEqual([{ kind: 'text', text: 'estamos abertos' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls through to the block edge outside business hours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T22:30:00Z')) // 19:30 SP
    try {
      const r = await engine(bhFlow()).start()
      expect(r.emissions).toEqual([{ kind: 'text', text: 'fora do horário' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('open but with no items produces no edge (block edge wins)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T15:00:00Z'))
    try {
      const d = def(
        [
          {
            id: 'g1',
            blocks: [
              {
                id: 'c1',
                type: 'Condition',
                items: [],
                options: {
                  conditionType: 'business_hours',
                  timezone: 'America/Sao_Paulo',
                  businessHours: WEEK_9_18,
                },
                outgoingEdgeId: 'e-closed',
              },
            ],
          },
          { id: 'g-closed', blocks: [textBlock('bc', 'else branch')] },
        ],
        [edge('e-closed', 'g-closed')],
      )
      const r = await engine(d).start()
      expect(r.emissions).toEqual([{ kind: 'text', text: 'else branch' }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('FlowEngine business_hours timezone default', () => {
  it('defaults to UTC when the block has no timezone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T15:00:00Z')) // 15:00 UTC — inside 09–18 UTC
    try {
      const d = def(
        [
          {
            id: 'g1',
            blocks: [
              {
                id: 'c1',
                type: 'Condition',
                items: [{ id: 'i1', outgoingEdgeId: 'e-open' }],
                options: { conditionType: 'business_hours', businessHours: WEEK_9_18 },
                outgoingEdgeId: 'e-closed',
              },
            ],
          },
          { id: 'g-open', blocks: [textBlock('bo', 'aberto utc')] },
          { id: 'g-closed', blocks: [textBlock('bc', 'fechado')] },
        ],
        [edge('e-open', 'g-open'), edge('e-closed', 'g-closed')],
      )
      const r = await engine(d).start()
      expect(r.emissions).toEqual([{ kind: 'text', text: 'aberto utc' }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('integration block option interpolation', () => {
  it('expands {{vars}} in options, keeping non-strings and nesting intact', async () => {
    const seen: Array<Record<string, unknown>> = []
    const effects: Partial<FlowEffects> = {
      runCode: vi.fn().mockResolvedValue({ nome: 'Ana' }),
      integration: vi.fn(async (_k: string, options: Record<string, unknown>) => {
        seen.push(options)
        return {}
      }),
    }
    const eng = engine(
      def([
        { id: 'g1', blocks: [
          { id: 'set', type: 'Code', options: { content: 'user.nome = "Ana"' }, outgoingEdgeId: 'e1' },
        ] },
        { id: 'g2', blocks: [
          { id: 'em', type: 'Email', options: {
            recipients: 'ana@example.com',
            subject: 'Contato de {{nome}}',
            body: 'Nome: {{nome}} / Ausente: {{ausente}}',
            isHtml: false,
            retries: 3,
            tags: ['lead', '{{nome}}'],
            meta: { owner: '{{nome}}' },
          } },
        ] },
      ], [edge('e1', 'g2')]),
      'STRICT',
      effects,
    )
    await eng.start()

    expect(seen[0]).toEqual({
      recipients: 'ana@example.com',
      subject: 'Contato de Ana',
      // An unresolved placeholder collapses to empty, never leaks as {{...}}.
      body: 'Nome: Ana / Ausente: ',
      isHtml: false,
      retries: 3,
      tags: ['lead', 'Ana'],
      meta: { owner: 'Ana' },
    })
  })

  it('interpolates block-level options when the block has no options map', async () => {
    const seen: Array<Record<string, unknown>> = []
    const effects: Partial<FlowEffects> = {
      integration: vi.fn(async (_k: string, options: Record<string, unknown>) => {
        seen.push(options)
        return {}
      }),
    }
    const eng = engine(
      def([{ id: 'g1', blocks: [{ id: 't', type: 'Ticket Create', subject: 'Erro em {{contact.name}}' }] }]),
      'STRICT',
      effects,
    )
    await eng.start({ contact: { name: 'Ana', email: null, phoneNumber: null } })
    expect(seen[0]!.subject).toBe('Erro em Ana')
  })
})

describe('choice menus and WhatsApp interactive limits', () => {
  const menu = (n: number, extra: Record<string, unknown> = {}) => ({
    groups: [{ id: 'g1', blocks: [{
      id: 'ci', type: 'choice input',
      options: {
        message: 'Escolha uma opção',
        items: Array.from({ length: n }, (_, i) => ({
          id: `i${i + 1}`, content: `Opção ${i + 1}`, outgoingEdgeId: `e${i + 1}`,
        })),
        ...extra,
      },
    }] }],
    edges: [],
    variables: [],
  })

  it('sends 3 or fewer options as reply buttons', async () => {
    const r = await engine(menu(3)).start()
    expect(r.emissions).toEqual([{
      kind: 'interactive',
      content: {
        kind: 'buttons',
        body: 'Escolha uma opção',
        buttons: [
          { id: 'i1', label: 'Opção 1' },
          { id: 'i2', label: 'Opção 2' },
          { id: 'i3', label: 'Opção 3' },
        ],
      },
    }])
  })

  it('switches to a list past 3 instead of hiding the rest', async () => {
    const r = await engine(menu(5)).start()
    const c = r.emissions[0]!.content as { kind: string; sections: Array<{ rows: unknown[] }>; buttonText: string }
    expect(c.kind).toBe('list')
    expect(c.buttonText).toBe('Menu')
    expect(c.sections[0]!.rows).toHaveLength(5)
  })

  it('trims to the 10 rows Meta allows rather than failing the whole prompt', async () => {
    const r = await engine(menu(14)).start()
    const c = r.emissions[0]!.content as { sections: Array<{ rows: Array<{ id: string }> }> }
    expect(c.sections[0]!.rows).toHaveLength(10)
    expect(c.sections[0]!.rows[9]!.id).toBe('i10')
  })

  it('respects the per-shape title limits', async () => {
    const long = 'x'.repeat(40)
    const three = await engine({
      groups: [{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: {
        message: 'm', items: [{ id: 'a', content: long }],
      } }] }], edges: [], variables: [],
    }).start()
    expect(
      (three.emissions[0]!.content as { buttons: Array<{ label: string }> }).buttons[0]!.label,
    ).toHaveLength(20)

    const many = await engine({
      groups: [{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: {
        message: 'm',
        items: Array.from({ length: 4 }, (_, i) => ({ id: `i${i}`, content: long })),
      } }] }], edges: [], variables: [],
    }).start()
    expect(
      (many.emissions[0]!.content as { sections: Array<{ rows: Array<{ title: string }> }> })
        .sections[0]!.rows[0]!.title,
    ).toHaveLength(24)
  })

  it('lets the author name the list button', async () => {
    const r = await engine(menu(4, { listButtonText: 'Ver opções' })).start()
    expect((r.emissions[0]!.content as { buttonText: string }).buttonText).toBe('Ver opções')
  })

  it('reads items from block level, as V1-imported flows store them', async () => {
    const r = await engine({
      groups: [{ id: 'g1', blocks: [{
        id: 'ci', type: 'choice input',
        message: 'Escolha',
        items: Array.from({ length: 4 }, (_, i) => ({ id: `i${i}`, content: `O${i}` })),
      }] }], edges: [], variables: [],
    }).start()
    expect((r.emissions[0]!.content as { kind: string }).kind).toBe('list')
  })

  it('emits nothing for a choice block with no items', async () => {
    const r = await engine({
      groups: [{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { message: 'm' } }] }],
      edges: [], variables: [],
    }).start()
    expect(r.emissions).toEqual([])
  })

  it('falls back to a placeholder body and label rather than sending empty strings', async () => {
    const r = await engine({
      groups: [{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: {
        items: [{ id: 'a', content: '' }],
      } }] }], edges: [], variables: [],
    }).start()
    const c = r.emissions[0]!.content as { body: string; buttons: Array<{ label: string }> }
    expect(c.body).toBe('·')
    expect(c.buttons[0]!.label).toBe('·')
  })
})

describe('AI block: vision and silent mode', () => {
  const aiFlow = (options: Record<string, unknown>) => ({
    groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options }] }],
    edges: [],
    variables: [],
  })

  it('sends the reply to the customer by default', async () => {
    const llm = vi.fn().mockResolvedValue({ kind: 'text', text: 'Parece um comprovante válido.' })
    const r = await engine(
      aiFlow({ prompt: 'Analise', responseMapping: { variableId: 'veredito' } }),
      'STRICT',
      { llm },
    ).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Parece um comprovante válido.', ai: true }])
    expect(r.state.variables.veredito).toBe('Parece um comprovante válido.')
  })

  it('sendMessage:false keeps the reply internal for a Condition to branch on', async () => {
    const llm = vi.fn().mockResolvedValue({ kind: 'text', text: 'aprovado' })
    const r = await engine(
      aiFlow({
        prompt: 'Classifique',
        sendMessage: false,
        responseMapping: { variableId: 'veredito' },
      }),
      'STRICT',
      { llm },
    ).start()
    expect(r.emissions).toEqual([])
    expect(r.state.variables.veredito).toBe('aprovado')
  })

  it('passes attachment URLs held in the named variables', async () => {
    const llm = vi.fn().mockResolvedValue({ kind: 'text', text: 'ok' })
    await engine(
      {
        groups: [{ id: 'g1', blocks: [
          { id: 'c', type: 'Code', options: { content: 'x' }, outgoingEdgeId: 'e1' },
        ] }, { id: 'g2', blocks: [
          { id: 'ai', type: 'OpenAI', options: {
            prompt: 'Analise', imageVariableIds: ['doc', 'extra'],
          } },
        ] }],
        edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
        variables: [],
      },
      'STRICT',
      {
        llm,
        // A file-input variable may hold one URL or a list of them.
        runCode: vi.fn().mockResolvedValue({
          doc: 'https://files.example/a.pdf',
          extra: ['https://files.example/b.png', '  '],
        }),
      },
    ).start()
    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrls: ['https://files.example/a.pdf', 'https://files.example/b.png'],
      }),
    )
  })

  it('ignores non-string entries in imageVariableIds', async () => {
    const llm = vi.fn().mockResolvedValue({ kind: 'text', text: 'ok' })
    await engine(
      aiFlow({ prompt: 'p', imageVariableIds: [42, null] }),
      'STRICT',
      { llm },
    ).start()
    expect(llm.mock.calls[0]![0].imageUrls).toBeUndefined()
  })

  it('omits imageUrls entirely when the variables are empty or unset', async () => {
    const llm = vi.fn().mockResolvedValue({ kind: 'text', text: 'ok' })
    await engine(
      aiFlow({ prompt: 'Analise', imageVariableIds: ['naoexiste'] }),
      'STRICT',
      { llm },
    ).start()
    expect(llm.mock.calls[0]![0].imageUrls).toBeUndefined()
  })

  it('still stores the reply when the model returns nothing to send', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('down'))
    const r = await engine(
      aiFlow({ prompt: 'p', responseMapping: { variableId: 'v' } }),
      'STRICT',
      { llm },
    ).start()
    expect(r.emissions).toEqual([])
    expect(r.state.variables.v).toBe('')
  })
})

describe('edges declared on the edge, not on the block (Typebot/V1 export shape)', () => {
  // Native blocks carry `outgoingEdgeId`. V1-exported flows instead declare
  // `edges[].from.blockId`. Without resolving those, a flow runs its first
  // group and silently "completes" — the customer answers one question and
  // the conversation stops. This is the real shape of Suporte - Novo Ticket.
  const def = {
    startGroupId: 'g1',
    groups: [
      { id: 'g1', blocks: [
        { id: 'b_ask', type: 'text', options: { content: 'Assunto?' } },
        { id: 'b_subject', type: 'text input', options: { variableId: 'assunto' } },
      ] },
      { id: 'g2', blocks: [
        { id: 'b_cat', type: 'text', options: { content: 'Categoria de {{assunto}}' } },
      ] },
    ],
    edges: [
      { id: 'e_start', from: { eventId: 'start' }, to: { groupId: 'g1' } },
      { id: 'e1', from: { blockId: 'b_subject' }, to: { groupId: 'g2' } },
    ],
    variables: [],
  }

  it('advances past a typed input whose edge lives on the edge list', async () => {
    const eng = engine(def)
    const start = await eng.start()
    expect(start.status).toBe('waiting')
    const next = await eng.resume(start.state, { text: 'Relatório quebrado' })
    expect(next.status).toBe('completed')
    expect(next.emissions).toEqual([
      { kind: 'text', text: 'Categoria de Relatório quebrado' },
    ])
  })

  it('advances past a non-input block the same way', async () => {
    const r = await engine({
      startGroupId: 'g1',
      groups: [
        { id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: 'um' } }] },
        { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'dois' } }] },
      ],
      edges: [{ id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g2' } }],
      variables: [],
    }).start()
    expect(r.emissions.map((e) => (e as { text: string }).text)).toEqual(['um', 'dois'])
  })

  it('ignores an edge that belongs to one choice option, not the block', async () => {
    // from.itemId edges are per-option; treating one as the block's own edge
    // would route every answer down the first option's branch.
    const r = await engine({
      startGroupId: 'g1',
      groups: [
        { id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: 'só um' } }] },
        { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'nunca' } }] },
      ],
      edges: [{ id: 'e1', from: { blockId: 'b1', itemId: 'opt1' }, to: { groupId: 'g2' } }],
      variables: [],
    }).start()
    expect(r.emissions.map((e) => (e as { text: string }).text)).toEqual(['só um'])
  })

  it('an inline outgoingEdgeId still wins over the edge list', async () => {
    const r = await engine({
      startGroupId: 'g1',
      groups: [
        { id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: 'a' }, outgoingEdgeId: 'e_inline' }] },
        { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'inline' } }] },
        { id: 'g3', blocks: [{ id: 'b3', type: 'text', options: { content: 'lista' } }] },
      ],
      edges: [
        { id: 'e_inline', from: {}, to: { groupId: 'g2' } },
        { id: 'e_list', from: { blockId: 'b1' }, to: { groupId: 'g3' } },
      ],
      variables: [],
    }).start()
    expect(r.emissions.map((e) => (e as { text: string }).text)).toEqual(['a', 'inline'])
  })
})

describe('choice inputs capture what was chosen', () => {
  const menu = (extra: Record<string, unknown> = {}) => ({
    startGroupId: 'g1',
    groups: [
      { id: 'g1', blocks: [{
        id: 'ci', type: 'choice input',
        options: {
          message: 'Categoria?',
          variableId: 'ticket_category',
          items: [
            { id: 'cat_bug', value: 'bug', content: '🐛 Bug' },
            { id: 'cat_q', value: 'question', content: '❓ Dúvida' },
          ],
          ...extra,
        },
      }] },
      { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'cat={{ticket_category}}' } }] },
    ],
    edges: [
      { id: 'e_bug', from: { blockId: 'ci', itemId: 'cat_bug' }, to: { groupId: 'g2' } },
      { id: 'e_q', from: { blockId: 'ci', itemId: 'cat_q' }, to: { groupId: 'g2' } },
    ],
    variables: [],
  })

  it('stores the machine-readable value, not the label', async () => {
    // Downstream Conditions are written against `value` ("bug"), not the
    // emoji label a customer sees.
    const eng = engine(menu())
    const start = await eng.start()
    const next = await eng.resume(start.state, { text: '', interactiveReplyId: 'cat_bug' })
    expect(next.state.variables.ticket_category).toBe('bug')
    expect(next.emissions).toEqual([{ kind: 'text', text: 'cat=bug' }])
  })

  it('falls back to the label when the item has no value', async () => {
    const def = menu()
    ;(def.groups[0]!.blocks[0] as never as { options: { items: Array<Record<string, unknown>> } })
      .options.items[0] = { id: 'cat_bug', content: '🐛 Bug' }
    const eng = engine(def)
    const start = await eng.start()
    const next = await eng.resume(start.state, { text: '', interactiveReplyId: 'cat_bug' })
    expect(next.state.variables.ticket_category).toBe('🐛 Bug')
  })

  it('captures a match made by typed label too, not just a tapped button', async () => {
    const eng = engine(menu())
    const start = await eng.start()
    const next = await eng.resume(start.state, { text: '❓ Dúvida' })
    expect(next.state.variables.ticket_category).toBe('question')
  })

  it('reads items from block level on resume, as V1 exports store them', async () => {
    // The prompt path already handles this; the reply path must agree or a
    // tapped option matches nothing.
    const eng = engine({
      startGroupId: 'g1',
      groups: [{ id: 'g1', blocks: [{
        id: 'ci', type: 'choice input',
        message: 'Categoria?',
        variableId: 'cat',
        items: [{ id: 'cat_bug', value: 'bug', content: 'Bug' }],
      }] }],
      edges: [],
      variables: [],
    })
    const start = await eng.start()
    const next = await eng.resume(start.state, { text: '', interactiveReplyId: 'cat_bug' })
    expect(next.state.variables.cat).toBe('bug')
  })

  it('stores an empty string when the item has neither value nor label', async () => {
    const eng = engine({
      startGroupId: 'g1',
      groups: [{ id: 'g1', blocks: [{
        id: 'ci', type: 'choice input',
        options: { message: 'm', variableId: 'cat', items: [{ id: 'only_id' }] },
      }] }],
      edges: [],
      variables: [],
    })
    const start = await eng.start()
    const next = await eng.resume(start.state, { text: '', interactiveReplyId: 'only_id' })
    expect(next.state.variables.cat).toBe('')
  })

  it('writes nothing when the block names no variable', async () => {
    const def = menu()
    delete (def.groups[0]!.blocks[0] as never as { options: Record<string, unknown> })
      .options.variableId
    const eng = engine(def)
    const start = await eng.start()
    const next = await eng.resume(start.state, { text: '', interactiveReplyId: 'cat_bug' })
    expect(next.state.variables).toEqual({})
  })
})

describe('folding the question into the menu', () => {
  const withPrompt = (promptLen: number, items: number) => ({
    startGroupId: 'g1',
    groups: [{ id: 'g1', blocks: [
      { id: 'txt', type: 'text', options: { content: 'P'.repeat(promptLen) } },
      { id: 'ci', type: 'choice input', options: {
        items: Array.from({ length: items }, (_, i) => ({ id: `i${i}`, content: `O${i}` })),
      } },
    ] }],
    edges: [],
    variables: [],
  })

  it('uses the preceding bubble as the menu body instead of a bare placeholder', async () => {
    const r = await engine(withPrompt(20, 2)).start()
    // One message, not two: the question IS the menu body.
    expect(r.emissions).toHaveLength(1)
    expect((r.emissions[0]!.content as { body: string }).body).toBe('P'.repeat(20))
  })

  it('leaves the bubble alone when it is too long for the shape', async () => {
    // Buttons cap the body at 1024; folding a longer one would get the whole
    // menu rejected and take the question with it.
    const r = await engine(withPrompt(1100, 2)).start()
    expect(r.emissions).toHaveLength(2)
    expect((r.emissions[1]!.content as { body: string }).body).toBe('·')
  })

  it('a list body allows far more than a button body', async () => {
    // Same 1100-char prompt, but 5 items makes it a list (4096 cap).
    const r = await engine(withPrompt(1100, 5)).start()
    expect(r.emissions).toHaveLength(1)
    expect((r.emissions[0]!.content as { body: string }).body).toHaveLength(1100)
  })

  it("never eats a bubble when the block has its own message", async () => {
    const def = withPrompt(20, 2)
    ;(def.groups[0]!.blocks[1] as never as { options: Record<string, unknown> })
      .options.message = 'Escolha:'
    const r = await engine(def).start()
    expect(r.emissions).toHaveLength(2)
    expect((r.emissions[1]!.content as { body: string }).body).toBe('Escolha:')
  })
})

// The V1 export shape that broke conversation 8739: ONE menu split into a
// prompt bubble, a `choice input` with no per-item routes, and a trailing
// `text input` that owns the variable and the group's outgoing edge.
describe('FlowEngine V1 composite step (choice + trailing text input)', () => {
  const menu = () =>
    def(
      [
        {
          id: 'g1',
          blocks: [
            textBlock('t', 'Escolha abaixo:'),
            {
              id: 'ci',
              type: 'choice input',
              options: {
                items: [
                  { id: 'q0', content: 'Falar com consultor' },
                  { id: 'q2', content: 'Como funciona?' },
                ],
              },
            },
            {
              id: 'in',
              type: 'text input',
              options: { variableId: 'opcoesInicio' },
              outgoingEdgeId: 'e_next',
            },
          ],
        },
        { id: 'g2', blocks: [textBlock('b2', 'roteado')] },
      ],
      [edge('e_next', 'g2')],
    )

  it('a tap answers the whole step: fills the trailing input and routes on', async () => {
    const eng = engine(menu())
    const started = await eng.start()
    expect(started.state.currentBlockId).toBe('ci')

    const r = await eng.resume(started.state, {
      text: 'Como funciona?',
      interactiveReplyId: 'q2',
    })
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'roteado' }])
    expect(r.state.variables.opcoesInicio).toBe('Como funciona?')
  })

  it('never parks on the trailing input, so the customer is asked only once', async () => {
    const eng = engine(menu())
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'Como funciona?', interactiveReplyId: 'q2' })
    // The regression: `waiting` on `in` with nothing emitted was dead air.
    expect(r.state.currentBlockId).not.toBe('in')
    expect(r.emissions.length).toBeGreaterThan(0)
  })

  it('an item with its own route still wins over the trailing input', async () => {
    const d = menu() as unknown as {
      groups: Array<{ id: string; blocks: Array<Record<string, unknown>> }>
      edges: unknown[]
    }
    ;(d.groups[0]!.blocks[1]!.options as { items: Array<Record<string, unknown>> }).items[0]!.outgoingEdgeId =
      'e_item'
    d.groups.push({ id: 'g3', blocks: [textBlock('b3', 'consultor')] })
    d.edges.push(edge('e_item', 'g3'))
    const eng = engine(d as never)
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'Falar com consultor', interactiveReplyId: 'q0' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'consultor' }])
    // The variable is still filled: downstream Conditions read it either way.
    expect(r.state.variables.opcoesInicio).toBe('Falar com consultor')
  })

  it('with no route anywhere, resumes AFTER the trailing input', async () => {
    const eng = engine(
      def([
        {
          id: 'g1',
          blocks: [
            { id: 'ci', type: 'choice input', options: { items: [{ id: 'q0', content: 'A' }] } },
            { id: 'in', type: 'text input', options: { variableId: 'v' } },
            textBlock('after', 'depois'),
          ],
        },
      ]),
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'A', interactiveReplyId: 'q0' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'depois' }])
    expect(r.state.variables.v).toBe('A')
  })

  it('a lone choice input (no trailing input) is unchanged', async () => {
    const eng = engine(
      def(
        [
          {
            id: 'g1',
            blocks: [
              { id: 'ci', type: 'choice input', options: { items: [{ id: 'i1', content: 'A', outgoingEdgeId: 'e1' }] } },
            ],
          },
          { id: 'g2', blocks: [textBlock('b2', 'ok')] },
        ],
        [edge('e1', 'g2')],
      ),
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: '', interactiveReplyId: 'i1' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'ok' }])
  })

  it('pairs a rating input with its trailing text input too', async () => {
    const eng = engine(
      def(
        [
          {
            id: 'g1',
            blocks: [
              { id: 'ri', type: 'rating input', options: {} },
              { id: 'in', type: 'text input', options: { variableId: 'nota' }, outgoingEdgeId: 'e1' },
            ],
          },
          { id: 'g2', blocks: [textBlock('b2', 'obrigado')] },
        ],
        [edge('e1', 'g2')],
      ),
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: '9' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'obrigado' }])
    expect(r.state.variables.nota).toBe('9')
  })
})

describe('FlowEngine sub-flow cycle guard', () => {
  // "Boas vindas" links to "Ações de Templates", which links back. Before the
  // guard this built a stack MAX_SUBFLOW_DEPTH deep whose unwind re-ran the
  // greeting, so the customer got the welcome message instead of an answer.
  it('skips a link back into a flow already on the stack', async () => {
    const root = def(
      [
        {
          id: 'gr',
          blocks: [
            { id: 'link', type: 'Cosmoflow link', options: { cosmoflowId: 'sub' }, outgoingEdgeId: 'e_back' },
          ],
        },
        { id: 'gr2', blocks: [textBlock('b', 'fim')] },
      ],
      [edge('e_back', 'gr2')],
    )
    const sub = def([
      {
        id: 'gs',
        blocks: [
          textBlock('s1', 'no sub'),
          { id: 'backlink', type: 'Cosmoflow link', options: { cosmoflowId: 'root' } },
        ],
      },
    ])
    const subs = new Map<string, unknown>([
      ['sub', sub],
      // The entry flow reachable under its own id, same object the engine got.
      ['root', root],
    ])
    const r = await engine(root, 'STRICT', undefined, subs).start()
    expect(r.status).toBe('completed')
    // The greeting inside the sub-flow runs exactly once, not once per frame.
    expect(r.emissions.filter((e) => e.kind === 'text' && e.text === 'no sub')).toHaveLength(1)
    expect(r.state.stack).toEqual([])
  })
})

describe('FlowEngine composite step: typed answer to an open question', () => {
  // "Your website, please (or tap 'Não tenho')": one button, and a trailing
  // text input that owns the answer. Conversation 8741 typed a URL here and
  // was asked to pick between buttons.
  const website = (conditionOn: string | null = null) =>
    def(
      [
        {
          id: 'g1',
          blocks: [
            textBlock('t', 'Agora, me informe a URL do seu site'),
            {
              id: 'ci',
              type: 'choice input',
              options: { items: [{ id: 'q0', content: 'Não tenho' }] },
            },
            {
              id: 'in',
              type: 'text input',
              options: { variableId: 'url' },
              outgoingEdgeId: 'e_next',
            },
          ],
        },
        {
          id: 'g2',
          blocks: [
            ...(conditionOn
              ? [
                  {
                    id: 'cond',
                    type: 'Condition',
                    items: [
                      {
                        id: 'c0',
                        content: {
                          comparisons: [
                            { variableId: conditionOn, comparisonOperator: 'Equal', value: 'Não tenho' },
                          ],
                        },
                      },
                    ],
                  },
                ]
              : []),
            textBlock('b2', 'Qual o seu cargo?'),
          ],
        },
      ],
      [edge('e_next', 'g2')],
    )

  it.each(['STRICT', 'GUIDED'] as const)(
    '%s: what they typed is the answer, and the flow moves on',
    async (mode) => {
      const eng = new FlowEngine(website(), mode)
      const s = (await eng.start()).state
      const r = await eng.resume(s, { text: '  https://asanet.com.br ', interactiveReplyId: null })
      expect(r.status).not.toBe('deviation')
      expect(r.state.variables.url).toBe('https://asanet.com.br')
      expect(r.emissions).toEqual([{ kind: 'text', text: 'Qual o seu cargo?' }])
    },
  )

  it('the button still works as before', async () => {
    const eng = new FlowEngine(website(), 'GUIDED')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'Não tenho', interactiveReplyId: 'q0' })
    expect(r.state.variables.url).toBe('Não tenho')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Qual o seu cargo?' }])
  })

  it('a menu stays a menu: when a Condition branches on the answer, GUIDED still deviates', async () => {
    const eng = new FlowEngine(website('url'), 'GUIDED')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'quanto custa?', interactiveReplyId: null })
    expect(r.status).toBe('deviation')
    expect(r.state.variables.url).toBeUndefined()
  })

  it('a menu stays a menu in STRICT too: the retry path, not a silent accept', async () => {
    const eng = new FlowEngine(website('url'), 'STRICT')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'quanto custa?', interactiveReplyId: null })
    expect(r.status).toBe('waiting')
    expect(r.state.currentBlockId).toBe('ci')
    expect(r.state.variables.url).toBeUndefined()
  })

  it('a Condition in a sub-flow that reads the answer also makes it a menu', async () => {
    const sub = website('url')
    const eng = new FlowEngine(website(), 'GUIDED', {}, new Map([['483', sub]]))
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'https://x.com', interactiveReplyId: null })
    expect(r.status).toBe('deviation')
  })

  it('a Condition on some other variable does not make it a menu (flat comparisons too)', async () => {
    const d = website('outra') as unknown as {
      groups: Array<{ blocks: Array<Record<string, unknown>> }>
    }
    // Builder-authored shape: comparisons flat on the item.
    const cond = d.groups[1]!.blocks[0]!
    cond.items = [{ id: 'c0', comparisons: [{ variableId: 'outra', value: 'x' }] }]
    const eng = new FlowEngine(d as never, 'GUIDED')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'https://x.com', interactiveReplyId: null })
    expect(r.state.variables.url).toBe('https://x.com')
  })

  it('without a variable to hold it, or with nothing typed, nothing is accepted', async () => {
    const d = website() as unknown as {
      groups: Array<{ blocks: Array<Record<string, unknown>> }>
    }
    d.groups[0]!.blocks[2]!.options = {}
    const noVar = new FlowEngine(d as never, 'GUIDED')
    const s1 = (await noVar.start()).state
    expect((await noVar.resume(s1, { text: 'https://x.com', interactiveReplyId: null })).status).toBe(
      'deviation',
    )
    const empty = new FlowEngine(website(), 'GUIDED')
    const s2 = (await empty.start()).state
    expect((await empty.resume(s2, { text: '   ', interactiveReplyId: null })).status).toBe('deviation')
  })

  it('a Condition block with no items is skipped while looking', async () => {
    const d = website() as unknown as {
      groups: Array<{ blocks: Array<Record<string, unknown>> }>
    }
    d.groups[1]!.blocks.unshift({ id: 'empty', type: 'Condition', options: {} })
    const eng = new FlowEngine(d as never, 'GUIDED')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'https://x.com', interactiveReplyId: null })
    expect(r.state.variables.url).toBe('https://x.com')
  })
})

describe('FlowEngine composite + cycle guard, remaining shapes', () => {
  it('a cycled link with no return edge ends the flow instead of recursing', async () => {
    const root = def([
      {
        id: 'gr',
        blocks: [{ id: 'link', type: 'Cosmoflow link', options: { cosmoflowId: 'sub' } }],
      },
    ])
    const sub = def([
      {
        id: 'gs',
        blocks: [
          textBlock('s1', 'uma vez'),
          { id: 'back', type: 'Cosmoflow link', options: { cosmoflowId: 'sub' } },
        ],
      },
    ])
    const r = await engine(root, 'STRICT', undefined, new Map([['sub', sub]])).start()
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'uma vez' }])
  })

  it('a choice that is the last block of its group has no companion', async () => {
    const eng = engine(
      def([
        {
          id: 'g1',
          blocks: [{ id: 'ci', type: 'choice input', options: { items: [{ id: 'i1', content: 'A' }] } }],
        },
      ]),
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'A', interactiveReplyId: 'i1' })
    expect(r.status).toBe('completed')
  })

  it('a block following the choice that is not a text input is not a companion', async () => {
    const eng = engine(
      def([
        {
          id: 'g1',
          blocks: [
            { id: 'ci', type: 'choice input', options: { items: [{ id: 'i1', content: 'A' }] } },
            { id: 'em', type: 'email input', options: { variableId: 'mail' } },
          ],
        },
      ]),
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'A', interactiveReplyId: 'i1' })
    // Falls through to the next block, which is a real second question.
    expect(r.status).toBe('waiting')
    expect(r.state.currentBlockId).toBe('em')
    expect(r.state.variables.mail).toBeUndefined()
  })

  it('a cycled link WITH a return edge carries on past it', async () => {
    const root = def(
      [
        {
          id: 'gr',
          blocks: [{ id: 'link', type: 'Cosmoflow link', options: { cosmoflowId: 'sub' } }],
        },
      ],
      [],
    )
    const sub = def(
      [
        {
          id: 'gs',
          blocks: [
            {
              id: 'back',
              type: 'Cosmoflow link',
              options: { cosmoflowId: 'sub' },
              outgoingEdgeId: 'e_after',
            },
          ],
        },
        { id: 'gs2', blocks: [textBlock('s2', 'seguiu em frente')] },
      ],
      [edge('e_after', 'gs2')],
    )
    const r = await engine(root, 'STRICT', undefined, new Map([['sub', sub]])).start()
    expect(r.emissions).toEqual([{ kind: 'text', text: 'seguiu em frente' }])
  })
})

// Conversation 8741 (2026-10-13): the step offered one button ("não tenho
// site") and expected the URL typed. The typed URL went to the AI as an
// off-script message, which answered "escolha uma das opções".
describe('FlowEngine composite step accepts a typed answer', () => {
  const urlStep = () =>
    def(
      [
        {
          id: 'g1',
          blocks: [
            {
              id: 'ci',
              type: 'choice input',
              options: { items: [{ id: 'q0', content: 'Não tenho site' }] },
            },
            { id: 'in', type: 'text input', options: { variableId: 'url' }, outgoingEdgeId: 'e1' },
          ],
        },
        { id: 'g2', blocks: [textBlock('b2', 'site: {{url}}')] },
      ],
      [edge('e1', 'g2')],
    )

  it.each(['GUIDED', 'STRICT'] as const)('%s: the typed text is the answer, not a deviation', async (mode) => {
    const eng = engine(urlStep(), mode)
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: '  https://empresa.com.br ' })
    expect(r.status).toBe('completed')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'site: https://empresa.com.br' }])
  })

  it('the button still works', async () => {
    const eng = engine(urlStep(), 'GUIDED')
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'Não tenho site', interactiveReplyId: 'q0' })
    expect(r.state.variables.url).toBe('Não tenho site')
  })

  it('a plain menu (no free-text slot) still hands an off-script reply to the AI', async () => {
    const eng = engine(
      def([
        { id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: [{ id: 'q0', content: 'A' }] } }] },
      ]),
      'GUIDED',
    )
    const s = (await eng.start()).state
    const r = await eng.resume(s, { text: 'qual o preço?' })
    expect(r.status).toBe('deviation')
  })
})

describe('FlowEngine: `now` and date/time conditions (PoC item 05)', () => {
  const SP = 'America/Sao_Paulo'
  // A notice that shows until 2026-10-20 18:00 São Paulo time, then disappears.
  const noticeFlow = (comparison: Record<string, unknown>) =>
    def(
      [
        {
          id: 'g1',
          blocks: [
            {
              id: 'c',
              type: 'Condition',
              options: { items: [{ outgoingEdgeId: 'e1', comparisons: [comparison] }] },
              outgoingEdgeId: 'e2',
            },
          ],
        },
        { id: 'notice', blocks: [textBlock('n', 'Aviso: atendimento encerra às 18h', 'e2')] },
        { id: 'menu', blocks: [textBlock('m', 'Como posso ajudar?')] },
      ],
      [edge('e1', 'notice'), edge('e2', 'menu')],
    )
  const before = { variableId: 'now', comparisonOperator: 'Is before', value: '2026-10-20 18:00' }
  // 17:59 and 18:00 in São Paulo (UTC-3).
  const at1759 = new Date(Date.UTC(2026, 9, 20, 20, 59, 30))
  const at1800 = new Date(Date.UTC(2026, 9, 20, 21, 0, 0))

  it('shows the notice before the configured time and drops it after, on its own', async () => {
    const live = await engine(noticeFlow(before)).start({ timezone: SP, now: at1759 })
    expect(live.emissions.map((e) => (e as { text: string }).text)).toEqual([
      'Aviso: atendimento encerra às 18h',
      'Como posso ajudar?',
    ])
    const expired = await engine(noticeFlow(before)).start({ timezone: SP, now: at1800 })
    expect(expired.emissions).toEqual([{ kind: 'text', text: 'Como posso ajudar?' }])
  })

  it('reads the real clock when no fixed clock is given', async () => {
    const past = { ...before, value: '2000-01-01 00:00' }
    const r = await engine(noticeFlow(past)).start({ timezone: SP })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Como posso ajudar?' }])
  })

  it('uses the account timezone, not UTC', async () => {
    // 20:59 UTC is still 17:59 in São Paulo, but past 18:00 in UTC.
    const utc = await engine(noticeFlow(before)).start({ now: at1759 })
    expect(utc.emissions).toHaveLength(1)
  })

  it('Is after and Is between (valueTo), with the first of an array value', async () => {
    const after = { variableId: 'now', comparisonOperator: 'Is after', value: ['2026-10-20 18:00'] }
    expect((await engine(noticeFlow(after)).start({ timezone: SP, now: at1800 })).emissions).toHaveLength(2)
    const between = {
      variableId: 'now',
      comparisonOperator: 'Is between',
      value: '{{inicio}}',
      valueTo: '20/10/2026 18:00',
    }
    const r = await engine(noticeFlow(between)).start({ timezone: SP, now: at1759 }, { inicio: '20/10/2026 08:00' })
    expect(r.emissions).toHaveLength(2)
    // Non-string values never match.
    const broken = { variableId: 'now', comparisonOperator: 'Is between', value: 5, valueTo: 7 }
    expect((await engine(noticeFlow(broken)).start({ timezone: SP, now: at1759 })).emissions).toHaveLength(1)
  })

  it('compares a date the contact gave against a fixed date', async () => {
    const due = { variableId: 'vencimento', comparisonOperator: 'Is before', value: '2026-10-20' }
    const r = await engine(noticeFlow(due)).start({ timezone: SP }, { vencimento: '19/10/2026' })
    expect(r.emissions).toHaveLength(2)
  })

  it('`now` interpolates as the account clock and outranks a stored variable', async () => {
    const d = def([{ id: 'g1', blocks: [textBlock('t', 'Agora: {{now}}')] }])
    const r = await engine(d).start({ timezone: SP, now: at1759 }, { now: 'velho' })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Agora: 2026-10-20 17:59' }])
  })
})

describe('FlowEngine: AI agent block (PoC items 03/04/07)', () => {
  const NOW = new Date('2026-10-16T12:00:00.000Z')
  const agentBlock = (options: Record<string, unknown>, edgeId: string | null = 'e1') => ({
    id: 'ag', type: 'AI agent', options: { agentBotId: 'bot-fin', ...options }, outgoingEdgeId: edgeId,
  })
  const flow = (options: Record<string, unknown> = {}, edgeId: string | null = 'e1') =>
    def(
      [
        { id: 'g1', blocks: [agentBlock(options, edgeId)] },
        { id: 'g2', blocks: [{ id: 'cd', type: 'Cosmodesk', options: { assigningMessage: 'Um atendente continua.' } }] },
      ],
      edgeId ? [edge(edgeId, 'g2')] : [],
    )
  const reply = (text: string, handoff = false) => ({ kind: 'reply' as const, text, handoff })
  const run = (d: unknown, agentTurn: FlowEffects['agentTurn']) => engine(d, 'STRICT', { agentTurn })

  it('a greeting opens the stretch without calling the model', async () => {
    const agentTurn = vi.fn()
    const r = await run(flow({ greeting: 'Olá, {{contact.name}}! Sou a Ana.' }), agentTurn).start({ contact: { name: 'Rui' }, now: NOW })
    expect(r.status).toBe('waiting')
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Olá, Rui! Sou a Ana.' }])
    expect(agentTurn).not.toHaveBeenCalled()
    expect(r.state.agent).toEqual({ blockId: 'ag', since: NOW.toISOString(), turns: 0 })
  })

  it('without a greeting the agent opens, and its line is marked as AI', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply('Oi! Como posso ajudar com a anuidade?'))
    const r = await run(flow({ instructions: 'Fale de {{assunto}}.', offTopic: 'handoff' }), agentTurn).start({ now: NOW }, { assunto: 'anuidade' })
    expect(agentTurn).toHaveBeenCalledWith({
      agentBotId: 'bot-fin', userText: null, since: NOW.toISOString(),
      instructions: 'Fale de anuidade.', offTopic: 'handoff', turn: 0, maxTurns: 3,
    })
    expect(r.emissions).toEqual([{ kind: 'text', text: 'Oi! Como posso ajudar com a anuidade?', ai: true }])
    expect(r.status).toBe('waiting')
  })

  it('counts customer messages and leaves by the edge in the turn the limit is hit', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply('Resposta.'))
    const e = run(flow({ greeting: 'Oi', maxAiTurns: 2 }), agentTurn)
    const s0 = await e.start({ now: NOW })
    const s1 = await e.resume(s0.state, { text: 'pergunta 1' })
    expect(s1.status).toBe('waiting')
    expect(agentTurn.mock.calls[0]![0]).toMatchObject({ userText: 'pergunta 1', turn: 1, maxTurns: 2, offTopic: 'refuse' })
    const s2 = await e.resume(s1.state, { text: 'pergunta 2' })
    expect(s2.emissions).toEqual([{ kind: 'text', text: 'Resposta.', ai: true }])
    expect(s2.status).toBe('handoff')
    expect(s2.intents).toEqual([{ type: 'handoff', message: 'Um atendente continua.', teamId: null }])
    expect(s2.state.agent).toBeUndefined()
  })

  it('the agent asking for a person leaves early', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply('Vou chamar alguém.', true))
    const e = run(flow({ greeting: 'Oi' }), agentTurn)
    const s0 = await e.start({ now: NOW })
    const s1 = await e.resume(s0.state, { text: 'quero um humano' })
    expect(s1.status).toBe('handoff')
  })

  it('with no edge it hands over directly, with the block message and team', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply(''))
    const e = run(flow({ greeting: 'Oi', maxAiTurns: 1, handoffMessage: 'Transferindo, {{contact.name}}.', teamId: 't-fin' }, null), agentTurn)
    const s0 = await e.start({ contact: { name: 'Rui' }, now: NOW })
    const s1 = await e.resume(s0.state, { text: 'x' }, { contact: { name: 'Rui' } })
    expect(s1.emissions).toEqual([])
    expect(s1.intents).toEqual([{ type: 'handoff', message: 'Transferindo, Rui.', teamId: 't-fin' }])
    const bare = run(flow({ greeting: 'Oi', maxAiTurns: 1 }, null), agentTurn)
    const b1 = await bare.resume((await bare.start({ now: NOW })).state, { text: 'x' })
    expect(b1.intents).toEqual([{ type: 'handoff', message: null, teamId: null }])
  })

  it('maxAiTurns 0 never forces the exit; an invalid value means the default', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply('ok'))
    const unlimited = run(flow({ greeting: 'Oi', maxAiTurns: 0 }), agentTurn)
    let state = (await unlimited.start({ now: NOW })).state
    for (let i = 0; i < 5; i += 1) {
      const r = await unlimited.resume(state, { text: `m${i}` })
      expect(r.status).toBe('waiting')
      state = r.state
    }
    const invalid = run(flow({ greeting: 'Oi', maxAiTurns: 'abc' }), agentTurn)
    await invalid.resume((await invalid.start({ now: NOW })).state, { text: 'x' })
    expect(agentTurn.mock.calls.at(-1)![0].maxTurns).toBe(3)
  })

  it('a blocked turn (budget, missing agent) notes it and hands over', async () => {
    const agentTurn = vi.fn().mockResolvedValue({ kind: 'blocked', message: 'Já te transfiro.', note: 'Sem orçamento.' })
    const r = await run(flow({}), agentTurn).start({ now: NOW })
    expect(r.status).toBe('handoff')
    expect(r.intents).toEqual([
      { type: 'note', body: 'Sem orçamento.' },
      { type: 'handoff', message: 'Já te transfiro.', teamId: null },
    ])
    expect(r.state.agent).toBeUndefined()
  })

  it('a throwing agent leaves by the exit instead of going silent', async () => {
    const agentTurn = vi.fn().mockRejectedValue(new Error('down'))
    const r = await run(flow({}), agentTurn).start({ now: NOW })
    expect(r.status).toBe('handoff')
    expect(r.intents).toEqual([{ type: 'handoff', message: 'Um atendente continua.', teamId: null }])
  })

  it('a state saved without the agent record starts one; a missing agent id is sent empty', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply('ok'))
    const d = def([{ id: 'g1', blocks: [{ id: 'ag', type: 'AI agent', options: {} }] }])
    const state = { ...emptyFlowState(), currentGroupId: 'g1', currentBlockId: 'ag' }
    const r = await run(d, agentTurn).resume(state, { text: 'oi' }, { now: NOW })
    expect(agentTurn.mock.calls[0]![0]).toMatchObject({ agentBotId: '', turn: 1, since: NOW.toISOString() })
    expect(r.state.agent).toEqual({ blockId: 'ag', since: NOW.toISOString(), turns: 1 })
  })

  it('with no edge, the next block of the group runs, like after any other block', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply('ok'))
    const d = def([{ id: 'g1', blocks: [agentBlock({ greeting: 'Oi', maxAiTurns: 1 }, null), textBlock('after', 'Obrigado por falar com a Ana.')] }])
    const e = run(d, agentTurn)
    const r = await e.resume((await e.start({ now: NOW })).state, { text: 'x' })
    expect(r.emissions.map((m) => (m as { text: string }).text)).toEqual(['ok', 'Obrigado por falar com a Ana.'])
    expect(r.status).toBe('completed')
  })

  it('with no edge inside a sub-flow, it returns to the parent flow', async () => {
    const agentTurn = vi.fn().mockResolvedValue(reply('ok'))
    const sub = def([{ id: 's1', blocks: [agentBlock({ greeting: 'Oi', maxAiTurns: 1 }, null)] }])
    const root = def(
      [
        { id: 'g1', blocks: [{ id: 'link', type: 'Cosmoflow link', options: { cosmoflowId: 'sub' }, outgoingEdgeId: 'back' }] },
        { id: 'g2', blocks: [textBlock('t', 'De volta ao menu.')] },
      ],
      [edge('back', 'g2')],
    )
    const e = engine(root, 'STRICT', { agentTurn }, new Map([['sub', sub]]))
    const r = await e.resume((await e.start({ now: NOW })).state, { text: 'x' })
    expect(r.emissions.at(-1)).toEqual({ kind: 'text', text: 'De volta ao menu.' })
    expect(r.status).toBe('completed')
  })

  it('a blocked turn hands to the team chosen on the block', async () => {
    const agentTurn = vi.fn().mockResolvedValue({ kind: 'blocked', message: 'Já te transfiro.', note: 'Sem orçamento.' })
    const r = await run(flow({ teamId: 't-fin' }), agentTurn).start({ now: NOW })
    expect(r.intents.at(-1)).toEqual({ type: 'handoff', message: 'Já te transfiro.', teamId: 't-fin' })
  })

  it('the default effects keep a flow with an agent block waiting', async () => {
    const r = await engine(flow({})).start({ now: NOW })
    expect(r.status).toBe('waiting')
    expect(r.emissions).toEqual([])
  })
})
