import { describe, expect, it } from 'vitest'

import { formatKnowledgeTags, parseKnowledgeTags } from './knowledge-tags'

describe('knowledge tags', () => {
  it('splits, trims, drops empties and repeats, keeping order', () => {
    expect(parseKnowledgeTags(' financeiro, anuidade,, financeiro ,')).toEqual(['financeiro', 'anuidade'])
    expect(parseKnowledgeTags('   ')).toEqual([])
  })

  it('round-trips through the form line', () => {
    expect(parseKnowledgeTags(formatKnowledgeTags(['cadastro', 'inscrição']))).toEqual(['cadastro', 'inscrição'])
  })
})
