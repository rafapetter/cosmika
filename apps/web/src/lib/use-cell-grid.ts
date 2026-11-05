'use client'

import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'

/**
 * Keyboard-first cell grid (Twenty-style), shared by the record-table pages
 * (contacts, tickets): a roving tabindex over the data cells, arrow-key
 * navigation with a visible cursor, Enter / type-over to start editing,
 * Escape to back out.
 *
 * The hook owns focus state and DOM focus; the page owns what "edit" means
 * (text input, enum picker, …) via the `onEdit` callback.
 */
export function useCellGrid(opts: {
  rows: number
  cols: number
  /** True while a cell editor is open — the editor owns the keyboard. */
  editing: boolean
  /** May the cell at (r, c) start an edit? (role + column editability) */
  canEdit: (r: number, c: number) => boolean
  /** Open the editor. `seed` is the typed character for type-over edits. */
  onEdit: (r: number, c: number, seed?: string) => void
}) {
  const { rows, cols, editing, canEdit, onEdit } = opts
  const [focused, setFocused] = useState<{ r: number; c: number } | null>(null)
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>())

  // DOM focus follows the keyboard cursor whenever no editor is open (the
  // editor's control holds focus while it exists; closing it hands focus
  // back to the cell so arrow keys keep working).
  useEffect(() => {
    if (!focused || editing) return
    const el = cellRefs.current.get(`${focused.r}:${focused.c}`)
    // The activeElement check breaks the focus() → focus event → setState →
    // effect cycle; without it the grid re-focuses forever.
    if (el && document.activeElement !== el) el.focus()
  }, [focused, editing])

  function onKeyDown(e: KeyboardEvent<HTMLTableCellElement>, r: number, c: number) {
    if (editing) return // the editor's control owns the keyboard while open
    let nr = r
    let nc = c
    if (e.key === 'ArrowDown') nr = Math.min(r + 1, rows - 1)
    else if (e.key === 'ArrowUp') nr = Math.max(r - 1, 0)
    else if (e.key === 'ArrowRight') nc = Math.min(c + 1, cols - 1)
    else if (e.key === 'ArrowLeft') nc = Math.max(c - 1, 0)
    else if (e.key === 'Enter') {
      if (canEdit(r, c)) {
        e.preventDefault()
        onEdit(r, c)
      }
      return
    } else if (e.key === 'Escape') {
      setFocused(null)
      e.currentTarget.blur()
      return
    } else if (
      canEdit(r, c) &&
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      // Typing over a focused cell opens the editor with the typed character
      // replacing the value, spreadsheet-style.
      e.preventDefault()
      onEdit(r, c, e.key)
      return
    } else {
      return
    }
    e.preventDefault()
    setFocused({ r: nr, c: nc })
  }

  const isFocused = (r: number, c: number) => focused?.r === r && focused.c === c

  /** Spread onto each data TableCell. Click-to-edit stays page-side. */
  function cellProps(r: number, c: number) {
    const key = `${r}:${c}`
    return {
      ref: (el: HTMLTableCellElement | null) => {
        if (el) cellRefs.current.set(key, el)
        else cellRefs.current.delete(key)
      },
      // Roving tabindex: one cell is the grid's tab stop — the focused one,
      // or the top-left cell before any cell has been focused.
      tabIndex: isFocused(r, c) || (!focused && r === 0 && c === 0) ? 0 : -1,
      onFocus: (_e: FocusEvent<HTMLTableCellElement>) =>
        // Keep the object identity stable when the position hasn't changed,
        // so the focus effect doesn't loop.
        setFocused((p) => (p && p.r === r && p.c === c ? p : { r, c })),
      onKeyDown: (e: KeyboardEvent<HTMLTableCellElement>) => onKeyDown(e, r, c),
    }
  }

  return { focused, setFocused, isFocused, cellProps }
}
