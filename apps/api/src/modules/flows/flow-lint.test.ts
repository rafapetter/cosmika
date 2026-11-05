import { describe, expect, it } from 'vitest'

import { formatFindings, lintFlow, type FlowLintFinding } from './flow-lint'

function def(groups: unknown[], edges: unknown[] = [], extra: object = {}) {
  return { groups, edges, variables: [], ...extra } as never
}
function codes(f: FlowLintFinding[]): string[] {
  return f.map((x) => x.code)
}
const text = (id: string, edge?: string) => ({
  id,
  type: 'text',
  options: { content: 'x' },
  ...(edge ? { outgoingEdgeId: edge } : {}),
})
const edge = (id: string, to: string, fromBlockId?: string) => ({
  id,
  from: fromBlockId ? { blockId: fromBlockId } : {},
  to: { groupId: to },
})

describe('lintFlow', () => {
  it('passes a well-wired flow', () => {
    const f = lintFlow(
      def(
        [
          { id: 'g1', blocks: [text('b1', 'e1')] },
          { id: 'g2', blocks: [text('b2')] },
        ],
        [edge('e1', 'g2', 'b1')],
      ),
    )
    expect(f).toEqual([])
  })

  it('flags a group nothing leads to', () => {
    const f = lintFlow(
      def([
        { id: 'g1', title: 'Início', blocks: [text('b1')] },
        { id: 'g2', title: 'Órfão', blocks: [text('b2')] },
      ]),
    )
    expect(codes(f)).toEqual(['unreachable_group'])
    expect(f[0]!.groupTitle).toBe('Órfão')
  })

  it('counts a Jump as reaching its target, and honours startGroupId', () => {
    const f = lintFlow(
      def(
        [
          { id: 'g1', blocks: [text('b1')] },
          { id: 'g2', blocks: [{ id: 'j', type: 'Jump', options: { groupId: 'g1' } }] },
        ],
        [],
        { startGroupId: 'g2' },
      ),
    )
    expect(f).toEqual([])
  })

  // The exact shape of conversation 8739: three options, no route on any of
  // them, and the composite's trailing input is the last block of the group.
  it('flags a menu whose options go nowhere', () => {
    const f = lintFlow(
      def([
        {
          id: 'g1',
          title: 'Opções de atendimento',
          blocks: [
            {
              id: 'ci',
              type: 'choice input',
              options: { items: [{ id: 'q0', content: 'A' }, { id: 'q1', content: 'B' }] },
            },
            { id: 'in', type: 'text input', options: { variableId: 'v' } },
          ],
        },
      ]),
    )
    expect(codes(f)).toEqual(['menu_without_route'])
    expect(f[0]!.detail).toContain('2 options')
  })

  it('accepts a menu routed by its trailing input', () => {
    const f = lintFlow(
      def(
        [
          {
            id: 'g1',
            blocks: [
              { id: 'ci', type: 'choice input', options: { items: [{ id: 'q0', content: 'A' }] } },
              { id: 'in', type: 'text input', options: { variableId: 'v' }, outgoingEdgeId: 'e1' },
            ],
          },
          { id: 'g2', blocks: [text('b2')] },
        ],
        [edge('e1', 'g2', 'in')],
      ),
    )
    expect(f).toEqual([])
  })

  it('accepts a menu routed per item, by edge or by item id', () => {
    const viaItemEdge = lintFlow(
      def(
        [
          {
            id: 'g1',
            blocks: [
              { id: 'ci', type: 'choice input', options: { items: [{ id: 'q0', content: 'A', outgoingEdgeId: 'e1' }] } },
            ],
          },
          { id: 'g2', blocks: [text('b2')] },
        ],
        [edge('e1', 'g2')],
      ),
    )
    expect(viaItemEdge).toEqual([])

    const viaItemId = lintFlow(
      def(
        [
          {
            id: 'g1',
            blocks: [{ id: 'ci', type: 'choice input', options: { items: [{ id: 'q0', content: 'A' }] } }],
          },
          { id: 'g2', blocks: [text('b2')] },
        ],
        [{ id: 'e1', from: { blockId: 'ci', itemId: 'q0' }, to: { groupId: 'g2' } }],
      ),
    )
    expect(viaItemId).toEqual([])
  })

  it('ignores an empty menu (nothing is asked)', () => {
    const f = lintFlow(def([{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { items: [] } }] }]))
    expect(f).toEqual([])
  })

  it('flags a typed question whose answer leads nowhere', () => {
    const f = lintFlow(
      def([{ id: 'g1', title: 'Qual seu e-mail?', blocks: [{ id: 'in', type: 'email input', options: {} }] }]),
    )
    expect(codes(f)).toEqual(['question_without_route'])
  })

  it('accepts a question followed by more blocks, or before a deliberate ending', () => {
    expect(
      lintFlow(def([{ id: 'g1', blocks: [{ id: 'in', type: 'email input', options: {} }, text('b2')] }])),
    ).toEqual([])
    expect(
      lintFlow(
        def([
          {
            id: 'g1',
            blocks: [
              { id: 'cd', type: 'Cosmodesk', options: {} },
              { id: 'in', type: 'email input', options: {} },
            ],
          },
        ]),
      ),
    ).toEqual([])
  })

  it('flags a link to a flow that did not resolve, and a link back to itself', () => {
    const missing = lintFlow(
      def([{ id: 'g1', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: 3339 } }] }]),
    )
    expect(codes(missing)).toEqual(['link_to_missing_flow'])
    expect(missing[0]!.detail).toContain('3339')

    const cycle = lintFlow(
      def([{ id: 'g1', blocks: [{ id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: '3331' } }] }]),
      new Set(['3331']),
      new Set(['3331']),
    )
    expect(codes(cycle)).toEqual(['link_cycle'])
  })

  it('leaves resolved links and the intra-flow "current" keyword alone', () => {
    const f = lintFlow(
      def([{ id: 'g1', blocks: [
        { id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: '3339' } },
        { id: 'l2', type: 'Cosmoflow link', options: { cosmoflowId: 'current' } },
        { id: 'l3', type: 'Cosmoflow link', options: {} },
      ] }]),
      new Set(['3339']),
    )
    expect(f).toEqual([])
  })

  it('copes with a definition whose groups or blocks are missing', () => {
    expect(lintFlow(def([]))).toEqual([])
    expect(lintFlow(def([{ id: 'g1' }]))).toEqual([])
    expect(lintFlow({ groups: 'nope', edges: [] } as never)).toEqual([])
  })

  it('ignores an edge with no target group', () => {
    const f = lintFlow(
      def([{ id: 'g1', blocks: [text('b1', 'e1')] }], [{ id: 'e1', from: {}, to: {} }]),
    )
    expect(f).toEqual([])
  })

  it('formats findings one per line', () => {
    expect(
      formatFindings([
        { code: 'unreachable_group', groupId: 'g2', groupTitle: 'Órfão', detail: 'nothing leads to this group' },
      ]),
    ).toEqual(['[unreachable_group] Órfão: nothing leads to this group'])
  })
})

describe('lintFlow — V1 export shapes', () => {
  it('reads a menu whose items sit at the block level, and a definition with no edges key', () => {
    const f = lintFlow(
      {
        groups: [
          {
            id: 'g1',
            title: 'Menu V1',
            blocks: [
              // V1 put `items` on the block, not under `options`.
              { id: 'ci', type: 'choice input', items: [{ id: 'q0', content: 'A' }] },
              { id: 'in', type: 'text input', options: { variableId: 'v' } },
            ],
          },
        ],
      } as never,
    )
    expect(codes(f)).toEqual(['menu_without_route'])
  })
})
