import { describe, expect, it } from 'vitest'

import {
  BLOCK_TYPES,
  addGroupAt,
  addItem,
  addVariable,
  blockHandle,
  blockItems,
  blockKind,
  blockTargetGroup,
  canvasEdges,
  conditionItemPatch,
  decodeHandle,
  groupChoices,
  itemComparisons,
  itemLogicalOperator,
  groupPosition,
  itemHandle,
  itemSummary,
  itemTargetGroup,
  removeEdge,
  removeItem,
  removeVariable,
  setBlockNext,
  setGroupPosition,
  setItemNext,
  type Def,
  addBlock,
  addGroup,
  deleteBlock,
  deleteGroup,
  describeBlock,
  duplicateBlock,
  duplicateGroup,
  genId,
  groupNextTarget,
  moveBlock,
  renameGroup,
  setBlockOptions,
  setGroupNext,
  setStartGroup,
  starterDefinition,
  updateItem,
  variableUseCount,
  variables,
  DEFAULT_FLOW_TEXT,
  type FlowText,
} from './flow-edit'

function gid(def: Def, i = 0): string {
  return (def as { groups: { id: string }[] }).groups[i]!.id
}
function blocks(def: Def, i = 0) {
  return (def as { groups: { blocks: { id: string; type: string }[] }[] }).groups[i]!.blocks
}

describe('genId / starterDefinition', () => {
  it('genId is unique and prefixed', () => {
    const a = genId('x')
    const b = genId('x')
    expect(a).not.toBe(b)
    expect(a.startsWith('x_')).toBe(true)
  })
  it('starter has one start group with a text block', () => {
    const d = starterDefinition() as { groups: { id: string; blocks: unknown[] }[]; startGroupId: string }
    expect(d.groups).toHaveLength(1)
    expect(d.startGroupId).toBe(d.groups[0]!.id)
    expect(d.groups[0]!.blocks).toHaveLength(1)
  })
  it('exposes a non-empty block-type menu', () => {
    expect(BLOCK_TYPES.length).toBeGreaterThan(5)
    expect(BLOCK_TYPES).toContain('text')
  })
})

describe('FlowText', () => {
  // A translator that tags every word, to prove nothing falls back to English.
  const text: FlowText = {
    ...DEFAULT_FLOW_TEXT,
    startGroup: 'Início',
    starterMessage: 'Olá!',
    newMessage: 'Nova mensagem',
    group: (n) => `Grupo ${n}`,
    groupFallback: 'Grupo',
    copyOf: (title) => `${title} (cópia)`,
    emptyText: '(vazio)',
    emptyMedia: (type) => `[${type}]`,
    ask: (v) => `pergunta ${v}`,
    aVariable: 'variável',
    branchOnCondition: 'condição',
    setVariable: (v) => `define ${v}`,
    jumpTo: (g) => `vai ${g}`,
    aGroup: 'um grupo',
    runSubflow: (f) => `fluxo ${f}`,
    branch: (n) => `Caminho ${n}`,
    bucket: (n, w) => `Teste ${n} peso ${w}`,
    option: (n) => `Opção ${n}`,
    typeLabel: (type) => `tipo:${type}`,
  }

  it('writes translated defaults into new content', () => {
    const d = starterDefinition(text) as unknown as { groups: { id: string; title: string; blocks: { options: { content: string } }[] }[] }
    expect(d.groups[0]!.title).toBe('Início')
    expect(d.groups[0]!.blocks[0]!.options.content).toBe('Olá!')
    const withGroup = addGroup(d as never, text) as unknown as { groups: { title: string }[] }
    expect(withGroup.groups[1]!.title).toBe('Grupo 2')
    const at = addGroupAt(d as never, 1, 2, text) as unknown as { groups: { title: string }[] }
    expect(at.groups[1]!.title).toBe('Grupo 2')
    const withBlock = addBlock(d as never, d.groups[0]!.id, 'text', text) as unknown as typeof d
    expect(withBlock.groups[0]!.blocks[1]!.options.content).toBe('Nova mensagem')
    const dup = duplicateGroup(d as never, d.groups[0]!.id, text) as unknown as { groups: { title: string }[] }
    expect(dup.groups[1]!.title).toBe('Início (cópia)')
    const untitled = { groups: [{ id: 'x', blocks: [] }], edges: [], variables: [] } as never
    expect(groupChoices(untitled, text)).toEqual([{ id: 'x', title: 'Grupo 1' }])
    expect((duplicateGroup(untitled, 'x', text) as unknown as { groups: { title: string }[] }).groups[1]!.title).toBe('Grupo (cópia)')
  })

  it('summarizes blocks and items with the given words', () => {
    expect(describeBlock({ id: 'a', type: 'text', options: {} }, text)).toBe('(vazio)')
    expect(describeBlock({ id: 'a', type: 'video', options: {} }, text)).toBe('[tipo:video]')
    expect(describeBlock({ id: 'a', type: 'email input', options: {} }, text)).toBe('pergunta variável')
    expect(describeBlock({ id: 'a', type: 'Condition', options: {} }, text)).toBe('condição')
    expect(describeBlock({ id: 'a', type: 'Set variable', options: {} }, text)).toBe('define variável')
    expect(describeBlock({ id: 'a', type: 'Jump', options: {} }, text)).toBe('vai um grupo')
    expect(describeBlock({ id: 'a', type: 'Cosmoflow link', options: {} }, text)).toBe('fluxo ?')
    expect(describeBlock({ id: 'a', type: 'mystery' }, text)).toBe('tipo:mystery')
    expect(itemSummary({ comparisons: [{}] }, 0, text)).toBe('Caminho 1')
    expect(itemSummary({ weight: 2 }, 0, text)).toBe('Teste 1 peso 2')
    expect(itemSummary({}, 1, text)).toBe('Opção 2')
  })
})

describe('describeBlock', () => {
  it('summarizes each friendly type and falls back to the type name', () => {
    expect(describeBlock({ id: 'a', type: 'text', options: { content: 'Hi' } })).toBe('Hi')
    expect(describeBlock({ id: 'a', type: 'text', options: {} })).toBe('(empty text)')
    expect(describeBlock({ id: 'a', type: 'image', options: { url: 'u' } })).toBe('u')
    expect(describeBlock({ id: 'a', type: 'video', options: {} })).toBe('(video)')
    expect(describeBlock({ id: 'a', type: 'text input', options: { variableId: 'name' } })).toBe('ask → name')
    expect(describeBlock({ id: 'a', type: 'choice input', options: { variable: { name: 'opt' } } })).toBe('ask → opt')
    expect(describeBlock({ id: 'a', type: 'email input', options: {} })).toBe('ask → variable')
    expect(describeBlock({ id: 'a', type: 'Condition', options: {} })).toBe('branch on a condition')
    expect(describeBlock({ id: 'a', type: 'Set variable', options: { variableId: 'v' } })).toBe('set v')
    expect(describeBlock({ id: 'a', type: 'Set variable', options: {} })).toBe('set variable')
    expect(describeBlock({ id: 'a', type: 'Jump', options: { groupId: 'g2' } })).toBe('jump to g2')
    expect(describeBlock({ id: 'a', type: 'Jump', options: {} })).toBe('jump to a group')
    expect(describeBlock({ id: 'a', type: 'Cosmoflow link', options: { cosmoflowId: '7' } })).toBe('run sub-flow 7')
    expect(describeBlock({ id: 'a', type: 'Cosmoflow link', options: {} })).toBe('run sub-flow ?')
    expect(describeBlock({ id: 'a', type: 'mystery' })).toBe('mystery')
  })
})

describe('group operations', () => {
  it('addGroup appends a new empty group', () => {
    const d = addGroup(starterDefinition())
    expect((d as { groups: unknown[] }).groups).toHaveLength(2)
  })
  it('renameGroup sets the title; no-op for unknown id', () => {
    const d = starterDefinition()
    const renamed = renameGroup(d, gid(d), 'Welcome')
    expect((renamed as { groups: { title?: string }[] }).groups[0]!.title).toBe('Welcome')
    expect(renameGroup(d, 'nope', 'x')).toBe(d)
  })
  it('deleteGroup removes the group, its edges, and repoints start', () => {
    let d = addGroup(starterDefinition())
    const g0 = gid(d, 0)
    const g1 = gid(d, 1)
    d = setGroupNext(d, g0, g1) // edge g0 → g1
    d = deleteGroup(d, g0)
    expect((d as { groups: { id: string }[] }).groups.map((g) => g.id)).toEqual([g1])
    expect((d as { edges: unknown[] }).edges).toHaveLength(0)
    expect((d as { startGroupId?: string }).startGroupId).toBe(g1)
    expect(deleteGroup(d, 'nope')).toBe(d)
  })
  it('setStartGroup updates startGroupId', () => {
    const d = addGroup(starterDefinition())
    const out = setStartGroup(d, gid(d, 1))
    expect((out as { startGroupId?: string }).startGroupId).toBe(gid(d, 1))
  })
})

describe('block operations', () => {
  it('addBlock appends; text gets default content; no-op for unknown group', () => {
    const d = starterDefinition()
    const out = addBlock(d, gid(d), 'text')
    expect(blocks(out)).toHaveLength(2)
    expect((blocks(out)[1] as unknown as { options: { content: string } }).options.content).toBe('New message')
    const choice = addBlock(d, gid(d), 'choice input')
    expect((blocks(choice)[1] as { type: string }).type).toBe('choice input')
    expect(addBlock(d, 'nope', 'text')).toBe(d)
  })
  it('deleteBlock removes by id; no-op for unknown group', () => {
    const d = addBlock(starterDefinition(), '__none__', 'text')
    expect(d).toBe(d) // unknown group → same ref handled below
    const base = starterDefinition()
    const bId = blocks(base)[0]!.id
    const out = deleteBlock(base, gid(base), bId)
    expect(blocks(out)).toHaveLength(0)
    expect(deleteBlock(base, 'nope', bId)).toBe(base)
  })
  it('moveBlock reorders within bounds; no-op at edges/unknown', () => {
    let d = starterDefinition()
    d = addBlock(d, gid(d), 'text') // now 2 blocks
    const [b0, b1] = blocks(d).map((b) => b.id)
    const moved = moveBlock(d, gid(d), b1!, -1)
    expect(blocks(moved).map((b) => b.id)).toEqual([b1, b0])
    expect(moveBlock(d, gid(d), b0!, -1)).toBe(d) // already first
    expect(moveBlock(d, gid(d), b1!, 1)).toBe(d) // already last
    expect(moveBlock(d, 'nope', b0!, 1)).toBe(d)
  })
  it('setBlockOptions replaces options; no-op for unknown', () => {
    const d = starterDefinition()
    const bId = blocks(d)[0]!.id
    const out = setBlockOptions(d, gid(d), bId, { content: 'Edited' })
    expect((blocks(out)[0] as unknown as { options: { content: string } }).options.content).toBe('Edited')
    expect(setBlockOptions(d, gid(d), 'nope', {})).toBe(d)
  })
})

describe('edges (group next)', () => {
  it('setGroupNext adds an edge; groupNextTarget reads it; empty clears', () => {
    let d = addGroup(starterDefinition())
    const g0 = gid(d, 0)
    const g1 = gid(d, 1)
    expect(groupNextTarget(d, g0)).toBeNull()
    d = setGroupNext(d, g0, g1)
    expect(groupNextTarget(d, g0)).toBe(g1)
    expect((d as { edges: unknown[] }).edges).toHaveLength(1)
    // re-pointing replaces, not duplicates
    d = setGroupNext(d, g0, g1)
    expect((d as { edges: unknown[] }).edges).toHaveLength(1)
    // clear
    d = setGroupNext(d, g0, '')
    expect(groupNextTarget(d, g0)).toBeNull()
    expect((d as { edges: unknown[] }).edges).toHaveLength(0)
  })
  it('setGroupNext is a no-op for a group with no blocks or unknown group', () => {
    const empty = addGroup(starterDefinition()) // group 1 has no blocks
    const g1 = gid(empty, 1)
    expect(setGroupNext(empty, g1, gid(empty, 0))).toBe(empty)
    expect(setGroupNext(empty, 'nope', g1)).toBe(empty)
    expect(groupNextTarget(empty, g1)).toBeNull()
  })
})

describe('canvas helpers', () => {
  it('groupPosition prefers graphCoordinates, else grid fallback by index', () => {
    const d = {
      groups: [
        { id: 'a', blocks: [], graphCoordinates: { x: 350, y: 120 } },
        { id: 'b', blocks: [] },
        { id: 'c', blocks: [] },
      ],
      edges: [], variables: [],
    } as unknown as Def
    expect(groupPosition(d, 'a')).toEqual({ x: 350, y: 120 })
    expect(groupPosition(d, 'b')).toEqual({ x: 340, y: 0 }) // idx 1 → col 1
    expect(groupPosition(d, 'missing')).toEqual({ x: 0, y: 0 }) // idx -1 → clamped
  })

  it('setGroupPosition writes graphCoordinates; no-op for unknown group', () => {
    const d = starterDefinition()
    const moved = setGroupPosition(d, gid(d), 42, 99)
    expect((moved as { groups: { graphCoordinates?: { x: number } }[] }).groups[0]!.graphCoordinates).toEqual({ x: 42, y: 99 })
    expect(setGroupPosition(d, 'nope', 1, 2)).toBe(d)
  })

  it('addGroupAt places the new group at the given coords', () => {
    const d = addGroupAt(starterDefinition(), 500, 300)
    const g = (d as { groups: { graphCoordinates?: { x: number; y: number } }[] }).groups[1]!
    expect(g.graphCoordinates).toEqual({ x: 500, y: 300 })
  })

  it('canvasEdges resolves block-, item- and group-anchored edges with source handles', () => {
    const d = {
      groups: [
        { id: 'g1', blocks: [
          { id: 'b1', type: 'choice input', options: { items: [{ id: 'i1' }] } },
          { id: 'b2', type: 'text', items: [{ id: 'i2' }] },
        ] },
        { id: 'g2', blocks: [] },
      ],
      edges: [
        { id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g2' } },
        { id: 'e2', from: { blockId: 'b1', itemId: 'i1' }, to: { groupId: 'g2' } },
        { id: 'e3', from: { itemId: 'i2' }, to: { groupId: 'g2' } }, // blockId inferred
        { id: 'e4', from: { groupId: 'g2' }, to: { groupId: 'g1' } },
        { id: 'e5', from: { blockId: 'ghost' }, to: { groupId: 'g1' } }, // unresolvable → dropped
      ],
      variables: [],
    } as unknown as Def
    expect(canvasEdges(d)).toEqual([
      { id: 'e1', source: 'g1', target: 'g2', sourceHandle: 'blk:b1' },
      { id: 'e2', source: 'g1', target: 'g2', sourceHandle: 'item:b1:i1' },
      { id: 'e3', source: 'g1', target: 'g2', sourceHandle: 'item:b2:i2' },
      { id: 'e4', source: 'g2', target: 'g1' },
    ])
  })

  it('handle encode/decode round-trips block, item, and group', () => {
    expect(decodeHandle(blockHandle('b9'))).toEqual({ kind: 'block', blockId: 'b9' })
    expect(decodeHandle(itemHandle('b9', 'i3'))).toEqual({ kind: 'item', blockId: 'b9', itemId: 'i3' })
    expect(decodeHandle(null)).toEqual({ kind: 'group' })
    expect(decodeHandle('weird')).toEqual({ kind: 'group' })
  })

  it('blockItems reads options.items then legacy top-level items', () => {
    expect(blockItems({ id: 'b', type: 'x', options: { items: [{ id: 'a' }] } })).toHaveLength(1)
    expect(blockItems({ id: 'b', type: 'x', items: [{ id: 'a' }, { id: 'b' }] })).toHaveLength(2)
    expect(blockItems({ id: 'b', type: 'x' })).toEqual([])
  })

  it('setBlockNext creates/clears a from.blockId edge; no-op for unknown', () => {
    let d = addGroup(starterDefinition())
    const [g0, g1] = [gid(d, 0), gid(d, 1)]
    const b0 = blocks(d, 0)[0]!.id
    d = setBlockNext(d, g0, b0, g1)
    const e = canvasEdges(d)
    expect(e).toEqual([{ id: expect.any(String), source: g0, target: g1, sourceHandle: `blk:${b0}` }])
    d = setBlockNext(d, g0, b0, '')
    expect(canvasEdges(d)).toEqual([])
    expect(setBlockNext(d, 'nope', b0, g1)).toBe(d)
  })

  it('setItemNext wires a choice item branch (from.itemId) and clears it', () => {
    let d = {
      groups: [
        { id: 'g1', blocks: [{ id: 'c', type: 'choice input', options: { items: [{ id: 'i1', content: 'A' }] } }] },
        { id: 'g2', blocks: [] },
      ],
      edges: [], variables: [],
    } as unknown as Def
    d = setItemNext(d, 'g1', 'c', 'i1', 'g2')
    expect(canvasEdges(d)).toEqual([
      { id: expect.any(String), source: 'g1', target: 'g2', sourceHandle: 'item:c:i1', label: 'A' },
    ])
    // item.outgoingEdgeId is also set (engine primary read)
    const item = (d as unknown as { groups: { blocks: { options: { items: { outgoingEdgeId?: string }[] } }[] }[] }).groups[0]!.blocks[0]!.options.items[0]!
    expect(item.outgoingEdgeId).toEqual(expect.any(String))
    d = setItemNext(d, 'g1', 'c', 'i1', '')
    expect(canvasEdges(d)).toEqual([])
    expect(setItemNext(d, 'g1', 'c', 'nope', 'g2')).toBe(d)
  })

  it('removeEdge drops the edge and clears block/item references; no-op if unknown', () => {
    const d = {
      groups: [
        { id: 'g1', blocks: [
          { id: 'b1', type: 'text', outgoingEdgeId: 'e1' },
          { id: 'b2', type: 'choice input', options: { items: [{ id: 'i1', outgoingEdgeId: 'e1' }] } },
          { id: 'b3', type: 'x', items: [{ id: 'i2', outgoingEdgeId: 'e1' }] },
        ] },
      ],
      edges: [{ id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g1' } }],
      variables: [],
    } as unknown as Def
    const out = removeEdge(d, 'e1') as unknown as {
      edges: unknown[]
      groups: { blocks: ({ outgoingEdgeId?: string; options?: { items?: { outgoingEdgeId?: string }[] }; items?: { outgoingEdgeId?: string }[] })[] }[]
    }
    expect(out.edges).toHaveLength(0)
    expect(out.groups[0]!.blocks[0]!.outgoingEdgeId).toBeUndefined()
    expect(out.groups[0]!.blocks[1]!.options!.items![0]!.outgoingEdgeId).toBeUndefined()
    expect(out.groups[0]!.blocks[2]!.items![0]!.outgoingEdgeId).toBeUndefined()
    expect(removeEdge(d, 'nope')).toBe(d)
  })

  it('blockKind buckets block types into visual families', () => {
    expect(blockKind('text')).toBe('bubble')
    expect(blockKind('choice input')).toBe('input')
    expect(blockKind('Condition')).toBe('logic')
    expect(blockKind('Cosmoflow link')).toBe('logic')
    expect(blockKind('Webhook')).toBe('integration')
    expect(blockKind('Google Sheets')).toBe('integration')
  })
})

describe('variables helpers', () => {
  const base = {
    groups: [
      { id: 'g1', blocks: [
        { id: 'b1', type: 'text', options: { content: 'Oi {{nome}}, tudo bem? {{nome | amigo}}' } },
        { id: 'b2', type: 'text input', options: { variableId: 'nome' } },
      ] },
    ],
    edges: [], variables: [{ id: 'nome', name: 'nome' }],
  } as unknown as Def

  it('variables reads the list; tolerates a missing array', () => {
    expect(variables(base)).toEqual([{ id: 'nome', name: 'nome' }])
    expect(variables({ groups: [], edges: [] } as unknown as Def)).toEqual([])
  })

  it('addVariable appends id===name; no-ops on blank and duplicate', () => {
    const out = addVariable(base, ' email ')
    expect(variables(out)).toEqual([
      { id: 'nome', name: 'nome' },
      { id: 'email', name: 'email' },
    ])
    expect(addVariable(base, '   ')).toBe(base)
    expect(addVariable(base, 'nome')).toBe(base)
    // works when the definition has no variables array at all
    const bare = { groups: [], edges: [] } as unknown as Def
    expect(variables(addVariable(bare, 'x'))).toEqual([{ id: 'x', name: 'x' }])
  })

  it('removeVariable drops by id; no-op when unknown', () => {
    expect(variables(removeVariable(base, 'nome'))).toEqual([])
    expect(removeVariable(base, 'ghost')).toBe(base)
  })

  it('variableUseCount counts {{tokens}} (with defaults) and variableId captures', () => {
    expect(variableUseCount(base, 'nome')).toBe(3)
    expect(variableUseCount(base, 'email')).toBe(0)
  })
})

describe('item CRUD', () => {
  const base = {
    groups: [
      { id: 'g1', blocks: [
        { id: 'c', type: 'choice input', options: { items: [{ id: 'i1', content: 'Yes' }] } },
      ] },
      { id: 'g2', blocks: [] },
    ],
    edges: [], variables: [],
  } as unknown as Def

  it('addItem appends with a generated id; no-op on unknown block', () => {
    const out = addItem(base, 'g1', 'c', { content: 'No' })
    const items = blockItems(blocks(out)[0]! as never)
    expect(items).toHaveLength(2)
    expect(items[1]!.content).toBe('No')
    expect(typeof items[1]!.id).toBe('string')
    expect(addItem(base, 'g1', 'nope')).toBe(base)
  })

  it('addItem normalizes legacy top-level items into options.items', () => {
    const legacy = {
      groups: [{ id: 'g1', blocks: [{ id: 'c', type: 'choice input', items: [{ id: 'i1', content: 'Old' }] }] }],
      edges: [], variables: [],
    } as unknown as Def
    const out = addItem(legacy, 'g1', 'c', { content: 'New' })
    const b = blocks(out)[0]! as { items?: unknown; options?: { items?: { content?: string }[] } }
    expect(b.items).toBeUndefined()
    expect(b.options!.items!.map((i) => i.content)).toEqual(['Old', 'New'])
  })

  it('updateItem shallow-merges a patch; no-op on unknown item', () => {
    const out = updateItem(base, 'g1', 'c', 'i1', { content: 'Sim' })
    expect(blockItems(blocks(out)[0]! as never)[0]!.content).toBe('Sim')
    expect(updateItem(base, 'g1', 'c', 'ghost', {})).toBe(base)
    expect(updateItem(base, 'g1', 'nope', 'i1', {})).toBe(base)
  })

  it('removeItem drops the item and its anchored edges', () => {
    let d = setItemNext(base, 'g1', 'c', 'i1', 'g2')
    expect((d as unknown as { edges: unknown[] }).edges).toHaveLength(1)
    d = removeItem(d, 'g1', 'c', 'i1')
    expect(blockItems(blocks(d)[0]! as never)).toHaveLength(0)
    expect((d as unknown as { edges: unknown[] }).edges).toHaveLength(0)
    expect(removeItem(base, 'g1', 'c', 'ghost')).toBe(base)
    expect(removeItem(base, 'g1', 'nope', 'i1')).toBe(base)
  })
})

describe('target lookups + group choices', () => {
  it('itemTargetGroup resolves own edge, from.itemId fallback, and null', () => {
    const d = {
      groups: [
        { id: 'g1', blocks: [{ id: 'c', type: 'choice input', options: { items: [
          { id: 'i1', outgoingEdgeId: 'e1' },
          { id: 'i2' },
          { id: 'i3' },
        ] } }] },
        { id: 'g2', blocks: [] },
      ],
      edges: [
        { id: 'e1', from: { blockId: 'c', itemId: 'i1' }, to: { groupId: 'g2' } },
        { id: 'e2', from: { itemId: 'i2' }, to: { groupId: 'g1' } },
      ],
      variables: [],
    } as unknown as Def
    expect(itemTargetGroup(d, 'c', 'i1')).toBe('g2')
    expect(itemTargetGroup(d, 'c', 'i2')).toBe('g1')
    expect(itemTargetGroup(d, 'c', 'i3')).toBeNull()
    expect(itemTargetGroup(d, 'c', 'ghost')).toBeNull()
    expect(itemTargetGroup(d, 'nope', 'i1')).toBeNull()
  })

  it('blockTargetGroup resolves outgoingEdgeId, from.blockId fallback, and null', () => {
    const d = {
      groups: [
        { id: 'g1', blocks: [
          { id: 'b1', type: 'text', outgoingEdgeId: 'e1' },
          { id: 'b2', type: 'text' },
          { id: 'b3', type: 'text' },
        ] },
        { id: 'g2', blocks: [] },
      ],
      edges: [
        { id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g2' } },
        { id: 'e2', from: { blockId: 'b2' }, to: { groupId: 'g1' } },
        // item edge on b3 must NOT count as the block's own edge
        { id: 'e3', from: { blockId: 'b3', itemId: 'ix' }, to: { groupId: 'g2' } },
      ],
      variables: [],
    } as unknown as Def
    expect(blockTargetGroup(d, 'b1')).toBe('g2')
    expect(blockTargetGroup(d, 'b2')).toBe('g1')
    expect(blockTargetGroup(d, 'b3')).toBeNull()
    expect(blockTargetGroup(d, 'ghost')).toBeNull()
  })

  it('setBlockNext replaces a legacy from.blockId edge instead of duplicating', () => {
    const d = {
      groups: [
        { id: 'g1', blocks: [{ id: 'b1', type: 'text' }] },
        { id: 'g2', blocks: [] },
        { id: 'g3', blocks: [] },
      ],
      edges: [{ id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g2' } }],
      variables: [],
    } as unknown as Def
    const out = setBlockNext(d, 'g1', 'b1', 'g3')
    const edges = (out as unknown as { edges: { to: { groupId: string } }[] }).edges
    expect(edges).toHaveLength(1)
    expect(edges[0]!.to.groupId).toBe('g3')
  })

  it('groupChoices lists id/title pairs, numbering untitled groups', () => {
    const d = {
      groups: [{ id: 'a', title: 'Start', blocks: [] }, { id: 'b', blocks: [] }],
      edges: [], variables: [],
    } as unknown as Def
    expect(groupChoices(d)).toEqual([
      { id: 'a', title: 'Start' },
      { id: 'b', title: 'Group 2' },
    ])
  })
})

describe('item-owned edges (item.outgoingEdgeId + from.blockId shape)', () => {
  // The common V1-import shape: the edge's `from` has ONLY blockId; the item
  // link lives on item.outgoingEdgeId. 24/55 edges in "Falar com consultor".
  const base = {
    groups: [
      { id: 'g1', blocks: [
        { id: 'c', type: 'choice input', outgoingEdgeId: 'eElse', options: { items: [
          { id: 'i1', content: 'Sim', outgoingEdgeId: 'eYes' },
        ] } },
      ] },
      { id: 'g2', blocks: [] },
      { id: 'g3', blocks: [] },
    ],
    edges: [
      { id: 'eYes', from: { blockId: 'c' }, to: { groupId: 'g2' } },
      { id: 'eElse', from: { blockId: 'c' }, to: { groupId: 'g3' } },
    ],
    variables: [],
  } as unknown as Def

  it('canvasEdges anchors item-owned edges to the item handle, not the block', () => {
    expect(canvasEdges(base)).toEqual([
      { id: 'eYes', source: 'g1', target: 'g2', sourceHandle: 'item:c:i1', label: 'Sim' },
      { id: 'eElse', source: 'g1', target: 'g3', sourceHandle: 'blk:c' },
    ])
  })

  it('setBlockNext replaces only the block edge, never an item-owned one', () => {
    const out = setBlockNext(base, 'g1', 'c', 'g2')
    const edges = (out as unknown as { edges: { id: string; to: { groupId: string } }[] }).edges
    expect(edges.some((e) => e.id === 'eYes')).toBe(true) // item edge survives
    expect(edges.some((e) => e.id === 'eElse')).toBe(false) // block edge replaced
    expect(edges).toHaveLength(2)
  })

  it('blockTargetGroup skips item-owned edges when resolving the block target', () => {
    expect(blockTargetGroup(base, 'c')).toBe('g3')
    // if the block's only candidate is item-owned, it has no own target
    const onlyItem = JSON.parse(JSON.stringify(base)) as unknown as {
      groups: { blocks: { outgoingEdgeId?: string }[] }[]
      edges: unknown[]
    }
    onlyItem.groups[0]!.blocks[0]!.outgoingEdgeId = 'eYes'
    ;(onlyItem.edges as { id: string }[]).splice(1, 1) // drop eElse
    expect(blockTargetGroup(onlyItem as unknown as Def, 'c')).toBeNull()
  })

  it('itemTargetGroup still resolves via the item-owned edge', () => {
    expect(itemTargetGroup(base, 'c', 'i1')).toBe('g2')
  })
})

describe('condition item shape helpers', () => {
  it('itemComparisons reads flat, nested (V1 import), and neither', () => {
    const flat = { comparisons: [{ variableId: 'v' }] }
    const nested = { content: { comparisons: [{ variableId: 'n' }], logicalOperator: 'OR' } }
    const both = { comparisons: [{ variableId: 'f' }], content: { comparisons: [{ variableId: 'n' }] } }
    expect(itemComparisons(flat)).toEqual([{ variableId: 'v' }])
    expect(itemComparisons(nested)).toEqual([{ variableId: 'n' }])
    expect(itemComparisons(both)).toEqual([{ variableId: 'f' }]) // flat wins
    expect(itemComparisons({ content: 'label' })).toEqual([])
    expect(itemComparisons({})).toEqual([])
  })

  it('itemLogicalOperator reads flat, nested, defaults to AND', () => {
    expect(itemLogicalOperator({ logicalOperator: 'OR' })).toBe('OR')
    expect(itemLogicalOperator({ content: { logicalOperator: 'OR' } })).toBe('OR')
    expect(itemLogicalOperator({ logicalOperator: 'AND', content: { logicalOperator: 'OR' } })).toBe('AND')
    expect(itemLogicalOperator({ content: 'label' })).toBe('AND')
    expect(itemLogicalOperator({})).toBe('AND')
  })

  it('conditionItemPatch normalizes to flat and drops the nested copy on write', () => {
    const d = {
      groups: [{ id: 'g1', blocks: [{ id: 'c', type: 'Condition', options: { items: [
        { id: 'i1', content: { comparisons: [{ variableId: 'old' }], logicalOperator: 'OR' } },
      ] } }] }],
      edges: [], variables: [],
    } as unknown as Def
    const next = [{ variableId: 'new', comparisonOperator: 'Equal', value: 'x' }]
    const out = updateItem(d, 'g1', 'c', 'i1', conditionItemPatch(next, 'AND'))
    const item = blockItems(blocks(out)[0]! as never)[0]! as Record<string, unknown>
    expect(item.comparisons).toEqual(next)
    expect(item.logicalOperator).toBe('AND')
    expect(item.content).toBeUndefined()
  })
})

describe('duplicate helpers', () => {
  const base = {
    groups: [
      { id: 'g1', title: 'Menu', graphCoordinates: { x: 100, y: 50 }, blocks: [
        { id: 'b1', type: 'choice input', outgoingEdgeId: 'e1', options: { items: [
          { id: 'i1', content: 'Sim', outgoingEdgeId: 'e2' },
        ] } },
        { id: 'b2', type: 'text', options: { content: 'oi' } },
      ] },
      { id: 'g2', blocks: [] },
    ],
    edges: [
      { id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g2' } },
      { id: 'e2', from: { blockId: 'b1', itemId: 'i1' }, to: { groupId: 'g2' } },
    ],
    variables: [],
  } as unknown as Def

  it('duplicateBlock inserts a copy below with fresh ids and no edge links', () => {
    const out = duplicateBlock(base, 'g1', 'b1')
    const bs = blocks(out)
    expect(bs).toHaveLength(3)
    const copy = bs[1]! as Record<string, unknown>
    expect(copy.type).toBe('choice input')
    expect(copy.id).not.toBe('b1')
    expect(copy.outgoingEdgeId).toBeUndefined()
    const items = blockItems(copy as never)
    expect(items[0]!.content).toBe('Sim')
    expect(items[0]!.id).not.toBe('i1')
    expect(items[0]!.outgoingEdgeId).toBeUndefined()
    // original untouched; edges untouched
    expect(bs[0]!.id).toBe('b1')
    expect((out as unknown as { edges: unknown[] }).edges).toHaveLength(2)
    expect(duplicateBlock(base, 'g1', 'nope')).toBe(base)
    expect(duplicateBlock(base, 'nope', 'b1')).toBe(base)
  })

  it('duplicateGroup appends an offset copy with fresh ids and no edges', () => {
    const out = duplicateGroup(base, 'g1')
    const gs = (out as unknown as { groups: ({ id: string; title?: string; graphCoordinates?: { x: number; y: number }; blocks: { id: string }[] })[] }).groups
    expect(gs).toHaveLength(3)
    const copy = gs[2]!
    expect(copy.title).toBe('Menu (copy)')
    expect(copy.id).not.toBe('g1')
    expect(copy.graphCoordinates).toEqual({ x: 140, y: 90 })
    expect(copy.blocks).toHaveLength(2)
    expect(copy.blocks[0]!.id).not.toBe('b1')
    expect((out as unknown as { edges: unknown[] }).edges).toHaveLength(2)
    expect(duplicateGroup(base, 'nope')).toBe(base)
  })
})

describe('itemSummary (canvas chip labels)', () => {
  it('prefers content, then value, then condition summary, then bucket/option fallback', () => {
    expect(itemSummary({ content: 'Sim' }, 0)).toBe('Sim')
    expect(itemSummary({ value: 'v' }, 0)).toBe('v')
    expect(
      itemSummary({ content: { comparisons: [{ variableId: 'canal', comparisonOperator: 'Equal', value: 'widget' }] } }, 0),
    ).toBe('canal equal widget')
    expect(
      itemSummary(
        { comparisons: [
          { variableId: 'a', comparisonOperator: 'Equal', value: '1' },
          { variableId: 'b', comparisonOperator: 'Equal', value: '2' },
        ] },
        0,
      ),
    ).toBe('a equal 1 (+1)')
    expect(itemSummary({ comparisons: [{}] }, 2)).toBe('Branch 3')
    expect(itemSummary({ weight: 3 }, 1)).toBe('Bucket 2 · weight 3')
    expect(itemSummary({}, 4)).toBe('Option 5')
  })
})

describe('itemSummary: date comparisons', () => {
  it('reads a datetime-local value with a space and shows both ends of a between', () => {
    expect(
      itemSummary({ comparisons: [{ variableId: 'now', comparisonOperator: 'Is before', value: '2026-10-20T18:00' }] }, 0),
    ).toBe('now is before 2026-10-20 18:00')
    expect(
      itemSummary(
        { comparisons: [{ variableId: 'now', comparisonOperator: 'Is between', value: '09:00', valueTo: '18:00' }] },
        0,
      ),
    ).toBe('now is between 09:00 – 18:00')
  })
})

describe('AI agent block', () => {
  it('is offered in the block menu and starts with the engine defaults', () => {
    expect(BLOCK_TYPES).toContain('AI agent')
    const d = starterDefinition()
    const g = (d as unknown as { groups: { id: string }[] }).groups[0]!.id
    const next = addBlock(d, g, 'AI agent') as unknown as { groups: { blocks: { type: string; options: unknown }[] }[] }
    const block = next.groups[0]!.blocks.at(-1)!
    expect(block).toMatchObject({ type: 'AI agent', options: { maxAiTurns: 3, offTopic: 'refuse' } })
  })
})

describe('file block', () => {
  it('is a bubble offered in the menu, summarised by its URL', () => {
    expect(BLOCK_TYPES).toContain('file')
    expect(blockKind('file')).toBe('bubble')
    expect(describeBlock({ id: 'f', type: 'file', options: { url: 'https://app/poc/guia.pdf' } })).toBe('https://app/poc/guia.pdf')
    expect(describeBlock({ id: 'f', type: 'file', options: {} })).toBe('(file)')
  })
})
