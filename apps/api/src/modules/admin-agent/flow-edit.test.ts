// A flow is a graph real customers walk through on WhatsApp. A dangling edge
// doesn't throw — it strands people mid-conversation. So these tests are about
// one thing: an invalid graph must never be persistable.
import { describe, expect, it, vi } from 'vitest'

import {
  allBlockIds,
  clone,
  findBlock,
  newId,
  summariseBlock,
  summariseChange,
  unreachableGroups,
  validateDefinition,
  type Definition,
} from './flow-edit'

const def = (over: Partial<Definition> = {}): Definition => ({
  groups: [
    { id: 'g1', blocks: [{ id: 'b1', type: 'text', content: 'Olá', outgoingEdgeId: 'e1' }] },
    { id: 'g2', blocks: [{ id: 'b2', type: 'text', content: 'Tchau' }] },
  ],
  edges: [{ id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g2' } }],
  variables: [],
  startGroupId: 'g1',
  ...over,
})

describe('validateDefinition', () => {
  it('accepts a well-formed flow', () => {
    expect(validateDefinition(def())).toEqual([])
  })

  it('rejects an edge pointing at a group that does not exist', () => {
    const d = def({ edges: [{ id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'ghost' } }] })
    expect(validateDefinition(d)).toContainEqual(
      expect.stringContaining('points at group "ghost"'),
    )
  })

  it('rejects an edge starting from a block that does not exist', () => {
    const d = def({ edges: [{ id: 'e1', from: { blockId: 'ghost' }, to: { groupId: 'g2' } }] })
    expect(validateDefinition(d)).toContainEqual(
      expect.stringContaining('starts at block "ghost"'),
    )
  })

  it('rejects a block pointing at an edge that does not exist', () => {
    // This is the exact shape that made imported flows stop after one group.
    const d = def()
    d.groups[0]!.blocks[0]!.outgoingEdgeId = 'gone'
    expect(validateDefinition(d)).toContainEqual(
      expect.stringContaining('points at edge "gone"'),
    )
  })

  it('rejects duplicate block ids, which would make edits ambiguous', () => {
    const d = def()
    d.groups[1]!.blocks[0]!.id = 'b1'
    expect(validateDefinition(d)).toContainEqual(expect.stringContaining('duplicate block id'))
  })

  it('rejects duplicate edge ids', () => {
    const d = def()
    d.edges.push({ id: 'e1', from: { blockId: 'b2' }, to: { groupId: 'g1' } })
    expect(validateDefinition(d)).toContainEqual(expect.stringContaining('duplicate edge id'))
  })

  it('rejects a startGroupId that is not in the flow', () => {
    expect(validateDefinition(def({ startGroupId: 'nope' }))).toContainEqual(
      expect.stringContaining('startGroupId'),
    )
  })

  it('rejects an empty flow', () => {
    expect(validateDefinition({ groups: [], edges: [] })).toContainEqual(
      expect.stringContaining('at least one group'),
    )
  })

  it('reports a malformed shape rather than throwing', () => {
    expect(validateDefinition({ groups: 'not an array' }).length).toBeGreaterThan(0)
    expect(validateDefinition(null).length).toBeGreaterThan(0)
  })

  it('allows a block with no outgoing edge — that is just an end', () => {
    const d = def()
    delete d.groups[0]!.blocks[0]!.outgoingEdgeId
    d.edges = []
    expect(validateDefinition(d)).toEqual([])
  })
})

describe('unreachableGroups', () => {
  it('finds nothing wrong with a connected flow', () => {
    expect(unreachableGroups(def())).toEqual([])
  })

  it('reports a group nothing links to', () => {
    const d = def()
    d.groups.push({ id: 'orphan', blocks: [{ id: 'b9', type: 'text' }] })
    expect(unreachableGroups(d)).toEqual(['orphan'])
  })

  it('follows edges declared from a group rather than a block', () => {
    const d = def({
      edges: [{ id: 'e1', from: { groupId: 'g1' }, to: { groupId: 'g2' } }],
    })
    d.groups[0]!.blocks[0]!.outgoingEdgeId = undefined
    expect(unreachableGroups(d)).toEqual([])
  })

  it('starts from the first group when none is named', () => {
    const d = def({ startGroupId: undefined })
    expect(unreachableGroups(d)).toEqual([])
  })

  it('survives a cycle instead of looping forever', () => {
    const d = def()
    d.edges.push({ id: 'e2', from: { blockId: 'b2' }, to: { groupId: 'g1' } })
    expect(unreachableGroups(d)).toEqual([])
  })

  it('returns nothing for an empty flow', () => {
    expect(unreachableGroups({ groups: [], edges: [] })).toEqual([])
  })
})

describe('findBlock', () => {
  it('locates a block and where it sits', () => {
    const found = findBlock(def(), 'b2')
    expect(found?.group.id).toBe('g2')
    expect(found?.index).toBe(0)
  })

  it('returns null for an unknown block', () => {
    expect(findBlock(def(), 'nope')).toBeNull()
  })
})

describe('summariseBlock', () => {
  it('reads plain content', () => {
    expect(summariseBlock({ id: 'b', type: 'text', content: 'Bom dia' })).toBe('Bom dia')
  })

  it('reads content nested under options, as imported flows store it', () => {
    expect(summariseBlock({ id: 'b', type: 'text', options: { content: 'Oi' } })).toBe('Oi')
  })

  it('reads rich text stored as an object', () => {
    expect(summariseBlock({ id: 'b', type: 'text', content: { text: 'Rico' } })).toBe('Rico')
  })

  it('lists the choices of a menu block', () => {
    const s = summariseBlock({
      id: 'b',
      type: 'choice input',
      items: [{ content: 'Suporte' }, { content: 'Financeiro' }],
    })
    expect(s).toBe('options: Suporte | Financeiro')
  })

  it('returns empty for a block with nothing readable', () => {
    expect(summariseBlock({ id: 'b', type: 'Wait' })).toBe('')
  })

  it('truncates so listing a flow cannot blow up the context', () => {
    const s = summariseBlock({ id: 'b', type: 'text', content: 'x'.repeat(500) })
    expect(s).toHaveLength(160)
  })
})

describe('newId', () => {
  it('avoids ids already in use', () => {
    expect(newId('blk', new Set(['blk_1', 'blk_2']))).toBe('blk_3')
  })

  it('starts at one on an empty flow', () => {
    expect(newId('blk', new Set())).toBe('blk_1')
  })
})

describe('clone', () => {
  it('isolates the copy so a failed edit cannot half-apply', () => {
    const original = def()
    const copy = clone(original)
    copy.groups[0]!.blocks[0]!.content = 'changed'
    expect(original.groups[0]!.blocks[0]!.content).toBe('Olá')
  })
})

describe('allBlockIds', () => {
  it('collects every block across groups', () => {
    expect(allBlockIds(def())).toEqual(new Set(['b1', 'b2']))
  })
})

describe('summariseChange', () => {
  // Exists because of a real near-miss: three live flows had drafts still
  // pointing at a decommissioned ticket system. "Publish flow 3351" tells an
  // approver nothing; this has to tell them what actually changes.
  it('flags a first publish', () => {
    expect(summariseChange(def(), null)).toEqual({ firstPublish: true })
  })

  it('reports changed message text with before and after', () => {
    const draft = def()
    draft.groups[0]!.blocks[0]!.content = 'Bom dia'
    expect(summariseChange(draft, def()).messagesChanged).toEqual([
      { blockId: 'b1', from: 'Olá', to: 'Bom dia' },
    ])
  })

  it('reports blocks and groups added or removed', () => {
    const draft = def()
    draft.groups.push({ id: 'g3', blocks: [{ id: 'b3', type: 'text' }] })
    draft.groups[1]!.blocks = []
    const c = summariseChange(draft, def())
    expect(c.groupsAdded).toEqual(['g3'])
    expect(c.blocksAdded).toEqual(['b3'])
    expect(c.blocksRemoved).toEqual(['b2'])
  })

  it('surfaces a changed sub-flow link, the easiest thing to miss', () => {
    // This is the exact hazard: a draft still linking the old ticket intake.
    const live = def()
    live.groups[0]!.blocks[0]!.options = { cosmoflowId: '5220' }
    const draft = def()
    draft.groups[0]!.blocks[0]!.options = { cosmoflowId: '3350' }
    const c = summariseChange(draft, live)
    expect(c.linkedFlowsAdded).toEqual(['3350'])
    expect(c.linkedFlowsRemoved).toEqual(['5220'])
  })

  it('reports nothing changed when draft matches live', () => {
    const c = summariseChange(def(), def())
    expect(c.messagesChanged).toEqual([])
    expect(c.groupsAdded).toEqual([])
    expect(c.linkedFlowsAdded).toEqual([])
  })

  it('caps the message list so a big rewrite stays readable', () => {
    const live = def()
    const draft = def()
    for (let i = 0; i < 20; i += 1) {
      live.groups[0]!.blocks.push({ id: `x${i}`, type: 'text', content: `a${i}` })
      draft.groups[0]!.blocks.push({ id: `x${i}`, type: 'text', content: `b${i}` })
    }
    expect((summariseChange(draft, live).messagesChanged as unknown[]).length).toBe(10)
  })
})

// ─── groups and menu options ──────────────────────────────────────────────

import {
  addGroup,
  allItemIds,
  choiceItems,
  connectOption,
  nextGroupPosition,
  removeGroup,
  setChoiceOptions,
  shapeNewBlock,
  type Definition as D,
} from './flow-edit'

describe('menu and group editing', () => {
  const base = (): D => ({
    groups: [
      {
        id: 'start',
        graphCoordinates: { x: 0, y: 0 },
        blocks: [
          {
            id: 'menu',
            type: 'choice input',
            options: {
              message: 'Q?',
              items: [{ id: 'old1', content: 'Old', outgoingEdgeId: 'eo' }],
            },
          },
          { id: 'txt', type: 'text', content: 'hi', outgoingEdgeId: 'eb' },
        ],
      },
      { id: 'g2', graphCoordinates: { x: 400, y: 0 }, blocks: [{ id: 'b2', type: 'text' }] },
    ],
    edges: [
      { id: 'eo', from: { blockId: 'menu', itemId: 'old1' }, to: { groupId: 'g2' } },
      { id: 'eb', from: { blockId: 'txt' }, to: { groupId: 'g2' } },
    ],
    startGroupId: 'start',
  })

  it('shapes a menu so its question is where the engine reads it', () => {
    expect(shapeNewBlock({ type: 'choice input', content: 'Q?' })).toEqual({
      type: 'choice input',
      options: { message: 'Q?' },
    })
    expect(shapeNewBlock({ type: 'text', content: 'hi', options: { a: 1 } })).toEqual({
      type: 'text', content: 'hi', options: { a: 1 },
    })
    expect(shapeNewBlock({ type: 'text' })).toEqual({ type: 'text' })
  })

  it('places new groups to the right of the layout, or on a grid without one', () => {
    expect(nextGroupPosition(base(), 1)).toEqual({ x: 800, y: 260 })
    expect(nextGroupPosition({ groups: [{ id: 'a', blocks: [] }], edges: [] })).toEqual({ x: 340, y: 0 })
  })

  it('adds a group with fresh ids that never collide', () => {
    const d = base()
    const made = addGroup(d, 'Nova', [{ type: 'text', content: 'x' }, { type: 'choice input', content: 'Q' }])
    expect(made.blockIds).toHaveLength(2)
    expect(new Set(made.blockIds).size).toBe(2)
    expect(d.groups.at(-1)).toMatchObject({ id: made.groupId, title: 'Nova' })
    expect(validateDefinition(d)).toEqual([])
  })

  it('reads V1 menus that keep items at block level', () => {
    expect(choiceItems({ id: 'x', type: 'choice input', items: [{ id: 'i' }] })).toEqual([{ id: 'i' }])
    expect(choiceItems({ id: 'x', type: 'text' })).toEqual([])
    expect(allItemIds(base())).toEqual(new Set(['old1']))
  })

  it('deletes a group with every edge into and out of it, detaching what pointed there', () => {
    const d = base()
    const out = removeGroup(d, 'g2')
    expect(out).toMatchObject({ deleted: 'g2', removedBlocks: 1 })
    expect(d.edges).toEqual([])
    const [menu, txt] = d.groups[0]!.blocks
    expect(choiceItems(menu!)[0]!.outgoingEdgeId).toBeNull()
    expect(txt!.outgoingEdgeId).toBeNull()
    expect(validateDefinition(d)).toEqual([])
  })

  it('removes edges that start at the deleted group or its blocks', () => {
    const d = base()
    d.edges.push({ id: 'eg', from: { groupId: 'g2' }, to: { groupId: 'start' } })
    d.edges.push({ id: 'ebk', from: { blockId: 'b2' }, to: { groupId: 'start' } })
    const out = removeGroup(d, 'g2') as { removedEdges: string[] }
    expect(out.removedEdges.sort()).toEqual(['eb', 'ebk', 'eg', 'eo'])
  })

  it('refuses to delete the start group or an unknown one', () => {
    expect(removeGroup(base(), 'start')).toMatch(/start group/)
    expect(removeGroup(base(), 'nope')).toMatch(/no group "nope"/)
  })

  it('replaces a menu: new options, old option edges gone, block edge untouched', () => {
    const d = base()
    const out = setChoiceOptions(d, 'menu', [
      { label: 'Vendas', value: 'sales', toGroupId: 'g2' },
      { label: 'Sem destino' },
    ], 'Nova pergunta') as { options: Array<{ itemId: string; toGroupId: string | null }>; shownAs: string }
    expect(out.shownAs).toBe('buttons')
    expect(out.options[1]!.toGroupId).toBeNull()
    expect(d.edges.find((e) => e.id === 'eo')).toBeUndefined()
    expect(d.edges.find((e) => e.id === 'eb')).toBeDefined()
    const items = choiceItems(d.groups[0]!.blocks[0]!)
    expect(items[0]).toMatchObject({ content: 'Vendas', value: 'sales' })
    expect((d.groups[0]!.blocks[0]!.options as { message: string }).message).toBe('Nova pergunta')
    expect(validateDefinition(d)).toEqual([])
  })

  it('says a long or large menu will show as a list', () => {
    const d = base()
    const many = setChoiceOptions(d, 'menu', [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }]) as { shownAs: string }
    expect(many.shownAs).toBe('list')
    const long = setChoiceOptions(base(), 'menu', [{ label: 'x'.repeat(22) }]) as { shownAs: string }
    expect(long.shownAs).toBe('list')
  })

  it('moves V1 block-level items into options.items when rewriting', () => {
    const d: D = {
      groups: [{ id: 's', blocks: [{ id: 'm', type: 'choice input', items: [{ id: 'v1' }] }] }],
      edges: [],
    }
    setChoiceOptions(d, 'm', [{ label: 'Um' }])
    expect('items' in d.groups[0]!.blocks[0]!).toBe(false)
    expect(choiceItems(d.groups[0]!.blocks[0]!)[0]).toMatchObject({ content: 'Um' })
  })

  it('refuses menus WhatsApp would reject, and non-menus', () => {
    expect(setChoiceOptions(base(), 'txt', [{ label: 'a' }])).toMatch(/not a menu/)
    expect(setChoiceOptions(base(), 'ghost', [{ label: 'a' }])).toMatch(/no block/)
    expect(setChoiceOptions(base(), 'menu', [])).toMatch(/1 to 10/)
    expect(setChoiceOptions(base(), 'menu', Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })))).toMatch(/1 to 10/)
    expect(setChoiceOptions(base(), 'menu', [{ label: 'x'.repeat(25) }])).toMatch(/24 characters/)
    expect(setChoiceOptions(base(), 'menu', [{ label: '  ' }])).toMatch(/24 characters/)
    expect(setChoiceOptions(base(), 'menu', [{ label: 'a', toGroupId: 'nope' }])).toMatch(/no group "nope"/)
  })

  it('re-routes a single option, replacing its previous edge', () => {
    const d = base()
    const out = connectOption(d, 'menu', 'old1', 'start') as { replaced: string[]; edgeId: string }
    expect(out.replaced).toEqual(['eo'])
    expect(d.edges.find((e) => e.id === out.edgeId)?.to.groupId).toBe('start')
    expect(validateDefinition(d)).toEqual([])
  })

  it('refuses to connect an unknown block, option or group', () => {
    expect(connectOption(base(), 'ghost', 'old1', 'g2')).toMatch(/no block/)
    expect(connectOption(base(), 'menu', 'ghost', 'g2')).toMatch(/no option/)
    expect(connectOption(base(), 'menu', 'old1', 'nope')).toMatch(/no group/)
  })
})

// ─── opening-hours branch ───────────────────────────────────────────────

import { FlowEngine } from '../flows/flow-engine'

import {
  describeSchedule,
  isTimezone,
  scheduleFromWindows,
  setHoursCondition,
  type Definition as HD,
} from './flow-edit'

describe('scheduleFromWindows', () => {
  it('writes one shift per day, and a second one for morning and afternoon', () => {
    expect(
      scheduleFromWindows([
        // Given out of order on purpose: the earlier shift must come first.
        { days: ['mon', 'Tuesday'], open: '13:30', close: '18:00' },
        { days: ['mon', 'tue'], open: '07:00', close: '12:00' },
        { days: ['sat'], open: '07:00', close: '11:00' },
      ]),
    ).toEqual({
      mon_1: '07:00', mon_2: '12:00', mon_3: '13:30', mon_4: '18:00',
      tue_1: '07:00', tue_2: '12:00', tue_3: '13:30', tue_4: '18:00',
      sat_1: '07:00', sat_2: '11:00',
    })
  })

  it('refuses schedules it cannot represent, saying why', () => {
    const one = { days: ['mon'], open: '07:00', close: '12:00' }
    expect(scheduleFromWindows([])).toMatch(/at least one opening window/)
    expect(scheduleFromWindows('x' as never)).toMatch(/at least one opening window/)
    expect(scheduleFromWindows([{ ...one, days: [] }])).toMatch(/at least one day/)
    expect(scheduleFromWindows([{ ...one, days: 'mon' as never }])).toMatch(/at least one day/)
    expect(scheduleFromWindows([{ ...one, days: ['funday'] }])).toMatch(/"fun" is not a weekday/)
    expect(scheduleFromWindows([{ ...one, open: '7h' }])).toMatch(/HH:MM/)
    expect(scheduleFromWindows([{ ...one, close: '25:00' }])).toMatch(/HH:MM/)
    expect(scheduleFromWindows([{ ...one, open: 7 as never }])).toMatch(/HH:MM/)
    expect(scheduleFromWindows([{ ...one, close: null as never }])).toMatch(/HH:MM/)
    expect(scheduleFromWindows([{ ...one, open: '12:00', close: '07:00' }])).toMatch(/open before it closes/)
    expect(
      scheduleFromWindows([one, { ...one, open: '11:00', close: '15:00' }]),
    ).toMatch(/two windows on mon overlap/)
    expect(
      scheduleFromWindows([
        one,
        { ...one, open: '13:00', close: '15:00' },
        { ...one, open: '16:00', close: '18:00' },
      ]),
    ).toMatch(/at most 2/)
  })
})

describe('describeSchedule / isTimezone', () => {
  it('reads a schedule back in weekday order, skipping closed days and half-set shifts', () => {
    expect(
      describeSchedule({
        sat_1: '07:00', sat_2: '11:00',
        mon_1: '07:00', mon_2: '12:00', mon_3: '13:30', mon_4: '18:00',
        tue_1: '07:00', tue_2: '',
        wed_1: null, wed_2: null,
      }),
    ).toBe('mon 07:00-12:00, 13:30-18:00; sat 07:00-11:00')
    expect(describeSchedule({})).toBe('')
  })

  it('knows a real timezone from a made-up one', () => {
    expect(isTimezone('America/Sao_Paulo')).toBe(true)
    expect(isTimezone('Not/A_Zone')).toBe(false)
  })
})

describe('setHoursCondition', () => {
  const flow = (): HD => ({
    groups: [
      { id: 'start', blocks: [{ id: 'hi', type: 'text', content: 'Olá' }] },
      { id: 'all', blocks: [{ id: 'm5', type: 'text', content: 'Menu com cinco unidades' }] },
      { id: 'two', blocks: [{ id: 'm2', type: 'text', content: 'Menu com duas unidades' }] },
    ],
    edges: [],
    variables: [],
    startGroupId: 'start',
  })
  const mornings = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], open: '07:00', close: '11:30' }]
  const input = { groupId: 'start', windows: mornings, timezone: 'America/Sao_Paulo', openGroupId: 'all', closedGroupId: 'two' }

  it('adds a check with BOTH branches wired, and the engine follows the clock', async () => {
    const d = flow()
    const out = setHoursCondition(d, { ...input, openLabel: ' Dentro do horário ' }) as {
      blockId: string; created: boolean; schedule: string; timezone: string; open: string; closed: string
    }
    expect(out).toMatchObject({
      created: true,
      schedule: 'mon 07:00-11:30; tue 07:00-11:30; wed 07:00-11:30; thu 07:00-11:30; fri 07:00-11:30',
      timezone: 'America/Sao_Paulo',
      open: 'all',
      closed: 'two',
    })
    expect(validateDefinition(d)).toEqual([])
    expect(unreachableGroups(d)).toEqual([])

    const block = findBlock(d, out.blockId)!.block
    expect(block.type).toBe('Condition')
    const opts = block.options as { conditionType: string; items: Array<Record<string, unknown>> }
    expect(opts.conditionType).toBe('business_hours')
    expect(opts.items).toHaveLength(1)
    expect(opts.items[0]!.content).toBe('Dentro do horário')
    // Open branch hangs off the item, closed branch off the block itself.
    const openEdge = d.edges.find((e) => e.from.itemId === opts.items[0]!.id)!
    expect(openEdge.to.groupId).toBe('all')
    expect(opts.items[0]!.outgoingEdgeId).toBe(openEdge.id)
    const closedEdge = d.edges.find((e) => e.from.blockId === block.id && !e.from.itemId)!
    expect(closedEdge.to.groupId).toBe('two')
    expect(block.outgoingEdgeId).toBe(closedEdge.id)
    expect(summariseBlock(block)).toMatch(/^opening hours \(America\/Sao_Paulo\): mon 07:00-11:30/)

    // The real engine, at two moments of the same Tuesday in São Paulo.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-04T13:00:00Z')) // 10:00, units open
      const open = await new FlowEngine(d as never, 'STRICT').start()
      expect(open.emissions.map((e) => (e as { text: string }).text)).toEqual(['Olá', 'Menu com cinco unidades'])
      vi.setSystemTime(new Date('2026-08-04T16:00:00Z')) // 13:00, they closed
      const closed = await new FlowEngine(d as never, 'STRICT').start()
      expect(closed.emissions.map((e) => (e as { text: string }).text)).toEqual(['Olá', 'Menu com duas unidades'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('labels the open branch when no label is given', () => {
    const d = flow()
    const out = setHoursCondition(d, input) as { blockId: string }
    const opts = findBlock(d, out.blockId)!.block.options as { items: Array<{ content: string }> }
    expect(opts.items[0]!.content).toBe('Open hours')
  })

  it('changes an existing check in place, replacing schedule and both branches', () => {
    const d = flow()
    const first = setHoursCondition(d, input) as { blockId: string }
    const out = setHoursCondition(d, {
      blockId: first.blockId,
      windows: [{ days: ['sat'], open: '08:00', close: '12:00' }],
      timezone: 'America/Manaus',
      openGroupId: 'two',
      closedGroupId: 'all',
    }) as { blockId: string; created: boolean; schedule: string }
    expect(out).toMatchObject({ blockId: first.blockId, created: false, schedule: 'sat 08:00-12:00' })
    // Exactly two edges leave the block: the old pair is gone.
    expect(d.edges.filter((e) => e.from.blockId === first.blockId)).toHaveLength(2)
    expect(d.groups[0]!.blocks).toHaveLength(2)
    expect(validateDefinition(d)).toEqual([])
  })

  it('moves V1 block-level items into options when rewriting', () => {
    const d = flow()
    d.groups[0]!.blocks.push({
      id: 'old', type: 'Condition', items: [{ id: 'v1' }],
      options: { conditionType: 'business_hours', businessHours: {}, timezone: 'UTC' },
    })
    setHoursCondition(d, { ...input, groupId: undefined, blockId: 'old' })
    expect('items' in findBlock(d, 'old')!.block).toBe(false)
    expect(validateDefinition(d)).toEqual([])
  })

  it('refuses anything that would leave a branch dangling', () => {
    expect(setHoursCondition(flow(), { ...input, windows: [] })).toMatch(/at least one opening window/)
    expect(setHoursCondition(flow(), { ...input, timezone: 'Sao Paulo' })).toMatch(/is not a timezone/)
    expect(setHoursCondition(flow(), { ...input, openGroupId: 'nope' })).toMatch(/no group "nope"/)
    expect(setHoursCondition(flow(), { ...input, closedGroupId: 'nada' })).toMatch(/no group "nada"/)
    expect(setHoursCondition(flow(), { ...input, groupId: 'ghost' })).toMatch(/no group "ghost"/)
    expect(setHoursCondition(flow(), { ...input, groupId: undefined })).toMatch(/no group "undefined"/)
    expect(setHoursCondition(flow(), { ...input, blockId: 'ghost' })).toMatch(/no block "ghost"/)
    // A plain text block, and a Condition that compares variables, are not it.
    expect(setHoursCondition(flow(), { ...input, blockId: 'hi' })).toMatch(/not an opening-hours condition/)
    const d = flow()
    d.groups[0]!.blocks.push({ id: 'cmp', type: 'Condition' })
    expect(setHoursCondition(d, { ...input, blockId: 'cmp' })).toMatch(/not an opening-hours condition/)
  })
})

describe('summariseBlock for opening hours', () => {
  it('falls back to UTC in the summary when the block carries no timezone', () => {
    expect(
      summariseBlock({
        id: 'c', type: 'Condition',
        options: { conditionType: 'business_hours', businessHours: { mon_1: '09:00', mon_2: '18:00' } },
      }),
    ).toBe('opening hours (UTC): mon 09:00-18:00')
  })
})
