'use client'

import { useEffect, useState } from 'react'
import type { AuthEnvelope } from '@cosmika/shared'

const STORAGE_KEY = 'cosmika.session'

export type StoredSession = AuthEnvelope

export function readSession(): StoredSession | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredSession
  } catch {
    return null
  }
}

export function writeSession(value: StoredSession) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}

export function clearSession() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_KEY)
}

export function useStoredSession() {
  const [session, setSession] = useState<StoredSession | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setSession(readSession())
    setReady(true)
  }, [])
  return { session, ready, setSession }
}
