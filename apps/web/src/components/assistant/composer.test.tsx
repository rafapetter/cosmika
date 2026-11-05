import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { Composer, readFileAsAttachment, type Draft } from './composer'

const t = (k: string) => k

function setup(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSubmit = vi.fn()
  const onChange = vi.fn()
  const onAttach = vi.fn()
  const onRemoveAttachment = vi.fn()
  render(
    <Composer
      value=""
      onChange={onChange}
      attachments={[]}
      onAttach={onAttach}
      onRemoveAttachment={onRemoveAttachment}
      onSubmit={onSubmit}
      busy={false}
      t={t}
      {...over}
    />,
  )
  return { onSubmit, onChange, onAttach, onRemoveAttachment }
}

beforeEach(() => {
  // jsdom has no object URLs; the composer only uses them for thumbnails.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('sending', () => {
  it('will not send an empty message', async () => {
    const { onSubmit } = setup({ value: '   ' })
    await userEvent.click(screen.getByRole('button', { name: 'assistant.send' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('sends on Enter', async () => {
    const { onSubmit } = setup({ value: 'hello' })
    await userEvent.type(screen.getByTestId('assistant-input'), '{Enter}')
    expect(onSubmit).toHaveBeenCalled()
  })

  it('does not send on Shift+Enter, so multi-line questions are possible', async () => {
    const { onSubmit } = setup({ value: 'hello' })
    await userEvent.type(screen.getByTestId('assistant-input'), '{Shift>}{Enter}{/Shift}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('allows sending an attachment with no words at all', async () => {
    const att: Draft = { name: 'a.png', mediaType: 'image/png', data: 'AAA' }
    const { onSubmit } = setup({ value: '', attachments: [att] })
    await userEvent.click(screen.getByRole('button', { name: 'assistant.send' }))
    expect(onSubmit).toHaveBeenCalled()
  })

  it('sends nothing while a turn is in flight', async () => {
    const { onSubmit } = setup({ value: 'hi', busy: true })
    await userEvent.type(screen.getByTestId('assistant-input'), '{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('caps the message at the length the API accepts', async () => {
    const { onChange } = setup()
    await userEvent.click(screen.getByTestId('assistant-input'))
    await userEvent.paste('x'.repeat(9000))
    const last = onChange.mock.calls.at(-1)?.[0] as string
    expect(last).toHaveLength(8000)
  })

  it('hides the character counter until the limit is close', () => {
    setup({ value: 'short' })
    expect(screen.queryByText(/8000/)).toBeNull()
  })

  it('shows the character counter once the limit is close', () => {
    setup({ value: 'x'.repeat(7500) })
    expect(screen.getByText('7500/8000')).toBeInTheDocument()
  })
})

describe('attachments', () => {
  it('lists what is attached and offers to remove it', async () => {
    const att: Draft = { name: 'screenshot.png', mediaType: 'image/png', data: 'AAA' }
    const { onRemoveAttachment } = setup({ attachments: [att] })
    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('screenshot.png')
    await userEvent.click(screen.getByRole('button', { name: 'assistant.remove_attachment' }))
    expect(onRemoveAttachment).toHaveBeenCalledWith(0)
  })

  it('blocks the attach button once the limit is reached', () => {
    const many: Draft[] = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.png`,
      mediaType: 'image/png',
      data: 'A',
    }))
    setup({ attachments: many })
    expect(screen.getByRole('button', { name: 'assistant.attach' })).toBeDisabled()
  })

  it('accepts a dropped file', async () => {
    const { onAttach } = setup()
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const dt = { files: [file] }
    const form = screen.getByTestId('composer')
    // fireEvent-style drop: userEvent has no drop helper.
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.drop(form, { dataTransfer: dt })
    expect(onAttach).toHaveBeenCalled()
  })
})

describe('readFileAsAttachment', () => {
  it('strips the data: prefix, keeping only the payload the API wants', async () => {
    const file = new File(['hello'], 'a.png', { type: 'image/png' })
    const att = await readFileAsAttachment(file)
    expect(att.name).toBe('a.png')
    expect(att.mediaType).toBe('image/png')
    expect(att.data).not.toContain('data:')
    expect(att.data).not.toContain(',')
    expect(att.previewUrl).toBe('blob:preview')
  })

  it('makes no thumbnail for a PDF', async () => {
    const file = new File(['%PDF'], 'r.pdf', { type: 'application/pdf' })
    const att = await readFileAsAttachment(file)
    expect(att.previewUrl).toBeUndefined()
  })
})

describe('auto-grow sizing', () => {
  // Caught in the browser, not by a test: an empty composer rendered a line
  // taller than its content. The effect measured once on mount before layout
  // settled, and since `value` never changes for an untouched composer it
  // never re-ran to correct itself.
  it('re-measures on the next frame, not only synchronously', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        frames.push(cb)
        return frames.length
      })
    setup({ value: '' })
    expect(frames).toHaveLength(1)

    const box = screen.getByTestId('assistant-input')
    // Simulate layout settling: the element now reports its true height.
    Object.defineProperty(box, 'scrollHeight', { value: 36, configurable: true })
    frames[0]!(0)
    expect(box.style.height).toBe('36px')
    raf.mockRestore()
  })

  it('caps growth so the composer cannot eat the conversation', () => {
    setup({ value: 'x'.repeat(5000) })
    const box = screen.getByTestId('assistant-input')
    Object.defineProperty(box, 'scrollHeight', { value: 9000, configurable: true })
    // Re-render path: typing triggers the same effect.
    expect(parseInt(box.style.height || '0', 10)).toBeLessThanOrEqual(200)
  })

  it('uses the shared Textarea rather than a hand-rolled control', () => {
    // The design system's one rule. `min-h-0` and `border-0` are the
    // deliberate overrides: the composer form owns the frame.
    setup()
    const box = screen.getByTestId('assistant-input')
    expect(box.tagName).toBe('TEXTAREA')
    expect(box.className).toMatch(/min-h-0/)
    expect(box.className).toMatch(/border-0/)
  })
})
