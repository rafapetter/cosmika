'use client'

import * as React from 'react'
import { ArrowUp, Paperclip, X, FileText } from 'lucide-react'
import { ADMIN_AGENT_MAX_ATTACHMENTS, ADMIN_AGENT_MEDIA_TYPES } from '@cosmika/shared'
import { Textarea } from '@cosmika/ui'

export type Draft = {
  name: string
  mediaType: string
  /** base64, no `data:` prefix */
  data: string
  /** object URL for the thumbnail; images only */
  previewUrl?: string
}

const MAX_CHARS = 8000
/** Base64 inflates by ~4/3, and the API caps the encoded string at 5MB. */
export const MAX_FILE_BYTES = 3_500_000

export function readFileAsAttachment(file: File): Promise<Draft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => {
      const result = String(reader.result)
      // "data:image/png;base64,AAA" → "AAA". The API wants the payload only.
      const comma = result.indexOf(',')
      resolve({
        name: file.name,
        mediaType: file.type,
        data: comma >= 0 ? result.slice(comma + 1) : result,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      })
    }
    reader.readAsDataURL(file)
  })
}

export function Composer({
  value,
  onChange,
  attachments,
  onAttach,
  onRemoveAttachment,
  onSubmit,
  busy,
  t,
}: {
  value: string
  onChange: (v: string) => void
  attachments: Draft[]
  onAttach: (files: FileList | null) => void
  onRemoveAttachment: (index: number) => void
  onSubmit: () => void
  busy: boolean
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)

  // Grow with the text instead of scrolling a two-line box, up to a ceiling
  // so the composer can never eat the conversation.
  //
  // Measured again on the next frame, not just synchronously: on first mount
  // the element can be measured before layout has settled, and since `value`
  // never changes for an untouched composer the effect would never re-run to
  // correct it — leaving an empty box a line taller than its own content.
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }
    fit()
    const frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [value])

  const canSend = !busy && (value.trim().length > 0 || attachments.length > 0)
  const nearLimit = value.length > MAX_CHARS * 0.9
  const full = attachments.length >= ADMIN_AGENT_MAX_ATTACHMENTS

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        onAttach(e.dataTransfer.files)
      }}
      className={`rounded-lg border bg-background transition-colors ${
        dragging ? 'border-primary bg-primary/5' : 'border-border'
      }`}
      data-testid="composer"
    >
      {attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2 border-b border-border p-2">
          {attachments.map((a, i) => (
            <li
              key={`${a.name}-${i}`}
              className="group relative flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-1 pr-6 text-xs"
              data-testid="attachment-chip"
            >
              {a.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  className="h-7 w-7 rounded object-cover"
                />
              ) : (
                <FileText className="h-5 w-5 text-muted-foreground" />
              )}
              <span className="max-w-[10rem] truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(i)}
                aria-label={t('assistant.remove_attachment')}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-end gap-1 p-1.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy || full}
          aria-label={t('assistant.attach')}
          title={full ? t('assistant.attach_full') : t('assistant.attach')}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ADMIN_AGENT_MEDIA_TYPES.join(',')}
          className="hidden"
          data-testid="file-input"
          onChange={(e) => {
            onAttach(e.target.files)
            // Reset so picking the same file twice still fires a change.
            e.target.value = ''
          }}
        />

        {/* The shared Textarea, with its frame removed: the composer form
            owns the border and focus ring, so the control must not draw a
            second one inside it, and `block` overrides its `flex` display —
            a flex textarea reports an inflated scrollHeight, which the
            auto-grow effect below would trust. Behaviour and tokens still
            come from the primitive rather than being reinvented here. */}
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, MAX_CHARS))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) onSubmit()
            }
          }}
          rows={1}
          placeholder={t('assistant.placeholder')}
          disabled={busy}
          data-testid="assistant-input"
          className="block max-h-[200px] min-h-0 flex-1 resize-none border-0 bg-transparent px-1 py-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />

        <div className="flex items-center gap-1.5 pb-0.5">
          {nearLimit ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {value.length}/{MAX_CHARS}
            </span>
          ) : null}
          <button
            type="submit"
            disabled={!canSend}
            aria-label={t('assistant.send')}
            className="rounded-md bg-primary p-2 text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </form>
  )
}
