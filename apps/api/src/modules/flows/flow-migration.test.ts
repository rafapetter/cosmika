import { describe, expect, it } from 'vitest'

import { convertPublishedFlow } from './flow-migration'

const txt = (id: string, content: string) => ({
  id,
  type: 'text',
  options: { content },
})

describe('convertPublishedFlow', () => {
  it('converts a Typebot-shaped flow, deriving the start group from the start event', () => {
    const source = {
      events: [{ id: 'ev', type: 'start', outgoingEdgeId: 'e0' }],
      groups: [
        { id: 'g0', blocks: [txt('b0', 'unused-first')] },
        { id: 'g1', blocks: [txt('b1', 'real start')] },
      ],
      edges: [{ id: 'e0', from: { eventId: 'ev' }, to: { groupId: 'g1' } }],
      variables: [
        { id: 'v1', name: 'name', entity: 'contact' },
        { id: 'v2', name: 'plan' },
      ],
      theme: { ignore: true },
      settings: { ignore: true },
    }
    const { definition, warnings } = convertPublishedFlow(source)
    expect(warnings).toEqual([])
    expect(definition!.startGroupId).toBe('g1')
    expect(definition!.variables).toEqual([
      { id: 'v1', name: 'name', entity: 'contact' },
      { id: 'v2', name: 'plan' },
    ])
    expect(definition!.groups).toHaveLength(2)
  })

  it('falls back to the first group when there is no usable start event', () => {
    const { definition } = convertPublishedFlow({
      groups: [{ id: 'gA', blocks: [txt('b', 'x')] }],
      edges: [],
    })
    expect(definition!.startGroupId).toBe('gA')
  })

  it('falls back to the first group when the start edge is missing/malformed', () => {
    const { definition } = convertPublishedFlow({
      events: [{ outgoingEdgeId: 'ghost' }, { type: 'start' }, 'junk'],
      groups: [{ id: 'gA', blocks: [txt('b', 'x')] }],
      edges: [{ id: 'other', from: {}, to: { groupId: 'gA' } }],
    })
    expect(definition!.startGroupId).toBe('gA')
  })

  it('tallies block types and flags unsupported + sandbox (Code) blocks', () => {
    const { warnings, blockCounts } = convertPublishedFlow({
      groups: [
        { id: 'g1', blocks: [
          txt('b1', 'hi'),
          { id: 'c', type: 'Code', options: {} },
          { id: 'x', type: 'Quantum Teleport', options: {} },
          { id: 'noType' },
        ] },
      ],
      edges: [],
    })
    expect(blockCounts).toEqual({ text: 1, Code: 1, 'Quantum Teleport': 1, '(unknown)': 1 })
    expect(warnings).toContain('block "Code" runs in the isolated-vm sandbox (no-op if the native module is absent)')
    expect(warnings).toContain('block "Quantum Teleport" has no engine support — will be skipped')
  })

  it('flags the payment-input block Cosmika does not offer', () => {
    const { definition, warnings, blockCounts } = convertPublishedFlow({
      groups: [
        { id: 'g1', blocks: [
          txt('b1', 'hi'),
          { id: 'pay', type: 'payment input', options: {} },
        ] },
      ],
      edges: [],
    })
    // Kept in the definition so the import is lossless on disk, but the
    // migration report says out loud that it will never run.
    expect(blockCounts).toEqual({ text: 1, 'payment input': 1 })
    expect(
      warnings.some(
        (w) => w.includes('block "payment input"') && w.includes('no engine support'),
      ),
    ).toBe(true)
    expect(definition!.groups[0]!.blocks.map((b) => b.type)).toEqual([
      'text',
      'payment input',
    ])
  })

  it('drops malformed variables', () => {
    const { definition } = convertPublishedFlow({
      groups: [{ id: 'g1', blocks: [txt('b', 'x')] }],
      edges: [],
      variables: [{ id: 'v1', name: 'ok' }, { id: 'bad' }, 'junk', { name: 'noId' }],
    })
    expect(definition!.variables).toEqual([{ id: 'v1', name: 'ok' }])
  })

  it('rejects a non-object source', () => {
    expect(convertPublishedFlow(null).definition).toBeNull()
    expect(convertPublishedFlow('x').warnings).toContain('source is empty or not an object')
    expect(convertPublishedFlow([1, 2]).definition).toBeNull()
  })

  it('rejects a flow with no groups', () => {
    const r = convertPublishedFlow({ groups: [], edges: [] })
    expect(r.definition).toBeNull()
    expect(r.warnings).toContain('flow has no groups')
  })

  it('flags a definition that fails schema validation (first group missing id)', () => {
    // first group has no id → firstGroupId falls back to '' AND safeParse fails
    const r = convertPublishedFlow({ groups: [{ blocks: [] }], edges: [] })
    expect(r.definition).toBeNull()
    expect(r.warnings).toContain('converted definition failed schema validation')
  })
})
