'use client'

import * as React from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'

import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { useTheme } from './theme-provider'

export type ThemeToggleLabels = { toggle: string; light: string; dark: string; system: string }

// The UI package has no translator; the app passes the words in.
const DEFAULT_LABELS: ThemeToggleLabels = { toggle: 'Toggle theme', light: 'Light', dark: 'Dark', system: 'System' }

export function ThemeToggle({
  className,
  labels = DEFAULT_LABELS,
}: {
  className?: string
  labels?: ThemeToggleLabels
}) {
  const { theme, resolved, setTheme } = useTheme()
  const Icon = resolved === 'dark' ? Moon : Sun

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={className}
          aria-label={labels.toggle}
        >
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun /> {labels.light}
          {theme === 'light' ? <span className="ml-auto text-xs text-muted-foreground">●</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon /> {labels.dark}
          {theme === 'dark' ? <span className="ml-auto text-xs text-muted-foreground">●</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor /> {labels.system}
          {theme === 'system' ? <span className="ml-auto text-xs text-muted-foreground">●</span> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
