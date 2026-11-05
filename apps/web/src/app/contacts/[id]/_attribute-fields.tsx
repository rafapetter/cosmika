'use client'

import { useTranslations } from 'next-intl'
import type { CustomAttributeDTO } from '@cosmika/shared'
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@cosmika/ui'

/**
 * Structured editor for the account's CONTACT custom attributes (F3).
 *
 * Replaces the raw-JSON textarea: each attribute defined in
 * Settings → Custom attributes renders with the control its type deserves,
 * so an agent doesn't have to hand-write JSON (and can't break a contact
 * with a stray comma).
 *
 * Values are stored as strings/booleans in `customAttributes`. Anything in
 * that map WITHOUT a definition is shown read-only rather than dropped —
 * see `mergeDefinedAttributes` for why that matters.
 */
export function ContactAttributeFields({
  definitions,
  values,
  onChange,
  disabled,
}: {
  definitions: CustomAttributeDTO[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  disabled?: boolean
}) {
  const t = useTranslations()

  const definedKeys = new Set(definitions.map((d) => d.key))
  const extras = Object.entries(values).filter(([k]) => !definedKeys.has(k))

  if (definitions.length === 0 && extras.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="no-attributes">
        {t('contacts.attributes_none_defined')}
      </p>
    )
  }

  return (
    <div className="space-y-3" data-testid="contact-attributes">
      {definitions.map((def) => {
        const id = `attr-${def.key}`
        const raw = values[def.key]
        switch (def.type) {
          case 'BOOLEAN':
            return (
              <div key={def.key} className="flex items-center justify-between gap-2">
                <Label htmlFor={id}>{def.label}</Label>
                <Switch
                  id={id}
                  checked={raw === true || raw === 'true'}
                  disabled={disabled}
                  onCheckedChange={(v) => onChange(def.key, v)}
                  data-testid={id}
                />
              </div>
            )
          case 'SELECT':
            return (
              <div key={def.key} className="space-y-1">
                <Label htmlFor={id}>{def.label}</Label>
                <Select
                  value={raw == null || raw === '' ? '__none__' : String(raw)}
                  disabled={disabled}
                  onValueChange={(v) => onChange(def.key, v === '__none__' ? '' : v)}
                >
                  <SelectTrigger id={id} data-testid={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      {t('contacts.attributes_unset')}
                    </SelectItem>
                    {(def.options ?? []).map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          default:
            return (
              <div key={def.key} className="space-y-1">
                <Label htmlFor={id}>{def.label}</Label>
                <Input
                  id={id}
                  type={def.type === 'NUMBER' ? 'number' : def.type === 'DATE' ? 'date' : 'text'}
                  value={raw == null ? '' : String(raw)}
                  disabled={disabled}
                  onChange={(e) => onChange(def.key, e.target.value)}
                  data-testid={id}
                />
              </div>
            )
        }
      })}

      {extras.length > 0 ? (
        <div className="space-y-1 rounded-md border border-dashed border-border p-2">
          <p className="text-[11px] text-muted-foreground">
            {t('contacts.attributes_undefined')}
          </p>
          <ul className="space-y-0.5 font-mono text-xs" data-testid="undefined-attributes">
            {extras.map(([k, v]) => (
              <li key={k} className="truncate">
                <span className="text-muted-foreground">{k}:</span> {String(v)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Build the map to PATCH: the edited values for DEFINED attributes, on top of
 * everything already stored.
 *
 * The merge is the whole point. `customAttributes` is replaced wholesale by
 * the API, and migrated contacts carry keys no one ever defined in settings
 * (`country_code`, Nebula leftovers). Sending only the form's fields would
 * silently delete those on the next save of any contact — a data loss the
 * old JSON textarea couldn't cause, because it showed the raw map.
 */
export function mergeDefinedAttributes(
  stored: Record<string, unknown>,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored, ...edited }
  // An emptied text/select field means "unset", not "store empty string".
  for (const [k, v] of Object.entries(out)) {
    if (v === '' || v === null || v === undefined) delete out[k]
  }
  return out
}
