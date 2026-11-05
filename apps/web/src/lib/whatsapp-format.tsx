import * as React from 'react'

/**
 * WhatsApp's inline formatting, as the customer sees it on the phone:
 * *bold*, _italic_, ~strike~ and ```monospace```. Flows and agents write
 * these markers for the channel, so showing them raw in the desk ("Qual o
 * nome da *Empresa*?") made every scripted question look broken.
 *
 * WhatsApp only formats when the marker hugs the text: the opening marker
 * follows the start, a space or an opening bracket, and the closing one is
 * followed by the end, a space or punctuation. "5 * 3 * 2" and "a*b*c" stay
 * as typed, here and on the phone.
 */
const MONO = /```([\s\S]+?)```/
const INLINE =
  /(^|[\s([{"'])([*_~])(?!\s)([^\n]*?[^\s])\2(?=$|[\s.,!?;:)\]}"'])/

const STYLE: Record<string, string> = {
  '*': 'font-semibold',
  _: 'italic',
  '~': 'line-through',
}

type Match = { start: number; end: number; marker: string; inner: string }

function nextMatch(text: string): Match | null {
  const mono = MONO.exec(text)
  const inline = INLINE.exec(text)
  const inlineStart = inline ? inline.index + inline[1]!.length : -1
  if (mono && (!inline || mono.index <= inlineStart)) {
    return { start: mono.index, end: mono.index + mono[0].length, marker: '```', inner: mono[1]! }
  }
  if (!inline) return null
  return {
    start: inlineStart,
    end: inline.index + inline[0].length,
    marker: inline[2]!,
    inner: inline[3]!,
  }
}

/**
 * Formatted nodes for `text`. Plain stretches go through `plain` so callers
 * keep their own decoration (mentions in the thread).
 */
export function renderWhatsAppFormatting(
  text: string,
  plain: (chunk: string) => React.ReactNode = (chunk) => chunk,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let rest = text
  let key = 0
  for (let match = nextMatch(rest); match; match = nextMatch(rest)) {
    if (match.start > 0) out.push(<React.Fragment key={key++}>{plain(rest.slice(0, match.start))}</React.Fragment>)
    out.push(
      match.marker === '```' ? (
        <code key={key++} className="rounded bg-foreground/10 px-1 font-mono text-[0.92em]">
          {match.inner}
        </code>
      ) : (
        <span key={key++} className={STYLE[match.marker]}>
          {renderWhatsAppFormatting(match.inner, plain)}
        </span>
      ),
    )
    rest = rest.slice(match.end)
  }
  if (rest) out.push(<React.Fragment key={key++}>{plain(rest)}</React.Fragment>)
  return out
}

/** The same text with the markers removed, for one-line previews. */
export function stripWhatsAppFormatting(text: string): string {
  let out = ''
  let rest = text
  for (let match = nextMatch(rest); match; match = nextMatch(rest)) {
    const inner = match.marker === '```' ? match.inner : stripWhatsAppFormatting(match.inner)
    out += rest.slice(0, match.start) + inner
    rest = rest.slice(match.end)
  }
  return out + rest
}
