import * as React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderWhatsAppFormatting, stripWhatsAppFormatting } from './whatsapp-format'

function html(text: string, plain?: (chunk: string) => React.ReactNode) {
  const { container } = render(<p>{renderWhatsAppFormatting(text, plain)}</p>)
  return container.firstElementChild!.innerHTML
}

describe('renderWhatsAppFormatting', () => {
  // The question from the commercial flow that showed raw asterisks.
  it('bolds a starred word followed by punctuation', () => {
    expect(html('Qual o nome da *Empresa*? ')).toBe(
      'Qual o nome da <span class="font-semibold">Empresa</span>? ',
    )
  })

  it('handles italic, strike and monospace', () => {
    expect(html('_oi_ ~não~ ```x = 1```')).toBe(
      '<span class="italic">oi</span> <span class="line-through">não</span> ' +
        '<code class="rounded bg-foreground/10 px-1 font-mono text-[0.92em]">x = 1</code>',
    )
  })

  it('nests markers and keeps monospace literal', () => {
    expect(html('*muito _bom_*')).toBe(
      '<span class="font-semibold">muito <span class="italic">bom</span></span>',
    )
    expect(html('```*não*```')).toContain('>*não*</code>')
  })

  it('leaves markers that do not hug the text, like WhatsApp does', () => {
    expect(html('5 * 3 * 2')).toBe('5 * 3 * 2')
    expect(html('a*b*c')).toBe('a*b*c')
    expect(html('* solto*')).toBe('* solto*')
    expect(html('*aberto')).toBe('*aberto')
  })

  it('formats after a line break and inside brackets', () => {
    expect(html('Olá\n*Menu*')).toBe('Olá\n<span class="font-semibold">Menu</span>')
    expect(html('(*sim*)')).toBe('(<span class="font-semibold">sim</span>)')
  })

  it('passes plain stretches through the caller decoration', () => {
    expect(html('oi *@ana* e @bia', (chunk) => <em>{chunk}</em>)).toBe(
      '<em>oi </em><span class="font-semibold"><em>@ana</em></span><em> e @bia</em>',
    )
  })

  it('picks whichever marker comes first', () => {
    expect(html('*a* ```b```')).toBe(
      '<span class="font-semibold">a</span> <code class="rounded bg-foreground/10 px-1 font-mono text-[0.92em]">b</code>',
    )
  })

  it('returns nothing for empty text', () => {
    expect(renderWhatsAppFormatting('')).toEqual([])
  })
})

describe('stripWhatsAppFormatting', () => {
  it('removes the markers for the list preview', () => {
    expect(stripWhatsAppFormatting('Qual o nome da *Empresa*? ')).toBe('Qual o nome da Empresa? ')
    expect(stripWhatsAppFormatting('*muito _bom_* ```x```')).toBe('muito bom x')
    expect(stripWhatsAppFormatting('5 * 3')).toBe('5 * 3')
  })
})
