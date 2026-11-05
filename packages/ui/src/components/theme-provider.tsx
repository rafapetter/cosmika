'use client'

import * as React from 'react'

type Theme = 'light' | 'dark' | 'system'
type Resolved = 'light' | 'dark'

const STORAGE_KEY = 'cosmika.theme'

const ThemeContext = React.createContext<{
  theme: Theme
  resolved: Resolved
  setTheme: (t: Theme) => void
}>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => {},
})

function resolve(t: Theme): Resolved {
  if (t === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return t
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>('system')
  const [resolved, setResolved] = React.useState<Resolved>('light')

  // Read persisted choice once on mount.
  React.useEffect(() => {
    const stored =
      (typeof window !== 'undefined'
        ? (window.localStorage.getItem(STORAGE_KEY) as Theme | null)
        : null) ?? 'system'
    setThemeState(stored)
  }, [])

  // Apply class on <html>, update resolved, persist.
  React.useEffect(() => {
    const r = resolve(theme)
    setResolved(r)
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(r)
    root.style.colorScheme = r
    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  // Live-update when system preference changes (only when theme === 'system')
  React.useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setResolved(mq.matches ? 'dark' : 'light')
    handler()
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  // Reflect resolved on <html> whenever it changes (driven by system mq).
  React.useEffect(() => {
    if (theme !== 'system') return
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolved)
    root.style.colorScheme = resolved
  }, [theme, resolved])

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme: setThemeState }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return React.useContext(ThemeContext)
}
