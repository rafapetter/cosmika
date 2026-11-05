'use client'

import { Check, ChevronDown, List } from 'lucide-react'
import type { SavedViewDTO } from '@cosmika/shared'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@cosmika/ui'

import { useDateTime } from '../lib/format-datetime'

/**
 * Twenty-style view switcher: the current view's name plus the record count
 * as the grid's title-dropdown ("≡ All Companies · 9 ⌄"). Selecting a view
 * restores its whole grid state; the save form appears when the current
 * state differs from the default view. All copy arrives via `labels` so the
 * component stays namespace-agnostic across grids.
 */
export function ViewSwitcher({
  views,
  activeViewId,
  count,
  dirty,
  saving,
  viewName,
  labels,
  onViewNameChange,
  onSelect,
  onSave,
  onDelete,
}: {
  views: SavedViewDTO[]
  activeViewId: string | null
  count: number | null
  /** Current grid state differs from the default view → offer to save it. */
  dirty: boolean
  saving: boolean
  viewName: string
  labels: {
    defaultName: string
    save: string
    namePlaceholder: string
    delete: string
  }
  onViewNameChange: (v: string) => void
  onSelect: (v: SavedViewDTO | null) => void
  onSave: () => void
  onDelete: (v: SavedViewDTO) => void
}) {
  const fmt = useDateTime()
  const active = views.find((v) => v.id === activeViewId) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2 font-medium"
          data-testid="view-switcher"
        >
          <List className="size-4 text-muted-foreground" />
          <span className="max-w-56 truncate">
            {active?.name ?? labels.defaultName}
          </span>
          {count !== null ? (
            <span
              className="font-normal text-muted-foreground"
              data-testid="record-count"
            >
              · {fmt.number(count)}
            </span>
          ) : null}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem
          onSelect={() => onSelect(null)}
          data-testid="view-option-all"
        >
          <span className="flex-1 truncate">{labels.defaultName}</span>
          {activeViewId === null ? <Check className="size-3.5" /> : null}
        </DropdownMenuItem>
        {views.map((v) => (
          <DropdownMenuItem
            key={v.id}
            onSelect={() => onSelect(v)}
            data-testid={`view-option-${v.id}`}
          >
            <span className="flex-1 truncate">{v.name}</span>
            {activeViewId === v.id ? <Check className="size-3.5" /> : null}
            <button
              type="button"
              aria-label={labels.delete}
              className="ml-1 rounded px-1 text-muted-foreground hover:text-destructive"
              data-testid={`view-delete-${v.id}`}
              onClick={(e) => {
                // Deleting must not also select the row it sits on.
                e.stopPropagation()
                e.preventDefault()
                onDelete(v)
              }}
            >
              ×
            </button>
          </DropdownMenuItem>
        ))}
        {dirty ? (
          <>
            <DropdownMenuSeparator />
            <form
              className="flex items-center gap-1.5 p-2"
              data-testid="view-save-form"
              onSubmit={(e) => {
                e.preventDefault()
                onSave()
              }}
            >
              <Input
                value={viewName}
                onChange={(e) => onViewNameChange(e.target.value)}
                placeholder={labels.namePlaceholder}
                className="h-7 flex-1 text-xs"
                data-testid="view-name-input"
                // Radix menus typeahead-steal printable keys from anything
                // inside the content — without this the input never types.
                onKeyDown={(e) => e.stopPropagation()}
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={saving || !viewName.trim()}
                data-testid="view-save"
              >
                {labels.save}
              </Button>
            </form>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
