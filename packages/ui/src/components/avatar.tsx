'use client'

import * as React from 'react'
import * as AvatarPrimitive from '@radix-ui/react-avatar'

import { cn } from '../lib/cn'

export const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      'relative inline-flex h-9 w-9 shrink-0 overflow-hidden rounded-full bg-muted',
      className,
    )}
    {...props}
  />
))
Avatar.displayName = AvatarPrimitive.Root.displayName

export const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn('aspect-square h-full w-full object-cover', className)}
    {...props}
  />
))
AvatarImage.displayName = AvatarPrimitive.Image.displayName

export const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center text-xs font-medium uppercase text-muted-foreground',
      className,
    )}
    {...props}
  />
))
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

/**
 * Deterministic pastel color pair for record avatars (Twenty-style).
 * Inline hsl on purpose: these are data-derived accents keyed to the record,
 * not theme tokens, and each pair keeps enough contrast on both light and
 * dark surfaces.
 */
const AVATAR_HUES = [265, 221, 178, 142, 96, 45, 21, 336] as const
export function avatarColor(seed: string | null | undefined): {
  backgroundColor: string
  color: string
} {
  let h = 0
  const s = seed ?? ''
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
  const hue = AVATAR_HUES[h % AVATAR_HUES.length]
  return {
    backgroundColor: `hsl(${hue} 60% 88%)`,
    color: `hsl(${hue} 55% 30%)`,
  }
}

/** Generate consistent fallback initials from a name or email. */
export function initialsOf(input: string | null | undefined): string {
  if (!input) return '?'
  const trimmed = input.trim()
  if (!trimmed) return '?'
  if (trimmed.includes('@')) return (trimmed[0] ?? '?').toUpperCase()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase()
  const first = parts[0]?.[0] ?? ''
  const last = parts[parts.length - 1]?.[0] ?? ''
  return (first + last).toUpperCase() || '?'
}
