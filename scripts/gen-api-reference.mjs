#!/usr/bin/env node
// Generate docs/api-reference.md from the running API. Walks the Nest router
// dump + groups by module.
import { readFileSync, writeFileSync } from 'node:fs'

const lines = readFileSync('/tmp/cosmika-api.log', 'utf8').split('\n')
const endpoints = new Set()
for (const l of lines) {
  const m = /Mapped \{(.+)\} route/.exec(l)
  if (!m) continue
  endpoints.add(m[1])
}

const grouped = new Map()
for (const e of endpoints) {
  const [path, method] = e.split(', ')
  // Group by first non-:param segment after /accounts/:accountId, or by /auth, /api/v1, /health, /csat, /widget, /webhooks.
  let group
  if (path.startsWith('/accounts/:accountId/')) {
    group = path.split('/')[3]
  } else if (path.startsWith('/accounts/:id')) {
    group = 'accounts'
  } else if (path.startsWith('/auth')) {
    group = 'auth'
  } else if (path.startsWith('/api/v1')) {
    group = 'public-api'
  } else if (path.startsWith('/csat')) {
    group = 'csat-public'
  } else if (path.startsWith('/widget')) {
    group = 'widget'
  } else if (path.startsWith('/webhooks')) {
    group = 'webhooks-inbound'
  } else if (path.startsWith('/health')) {
    group = 'health'
  } else {
    group = 'other'
  }
  if (!grouped.has(group)) grouped.set(group, [])
  grouped.get(group).push({ method, path })
}

const out = []
out.push('# Cosmika API reference')
out.push('')
out.push('> Generated from the running API on **' + new Date().toISOString() + '**.')
out.push('> Use this as a launching point for integrations — request/response schemas live in `@cosmika/shared`.')
out.push('')
out.push('## Auth')
out.push('')
out.push('Two ways to authenticate:')
out.push('')
out.push('- **Session token** (web): `Authorization: Bearer <session.token>`, returned by `/auth/sign-in` (or by `/auth/2fa/challenge` if 2FA is on).')
out.push('- **API key** (programmatic): `Authorization: Bearer cosmika_<prefix>_<secret>`, created from `/settings/api-keys`. Only the `/api/v1/*` endpoints accept this.')
out.push('')
out.push('All endpoints under `/accounts/:accountId/` are scoped to one account — the session\'s user must be an active member of it.')
out.push('')

const groupOrder = [
  'health',
  'auth',
  'accounts',
  'inboxes',
  'contacts',
  'conversations',
  'agent-bots',
  'agents',
  'articles',
  'audit-logs',
  'automation-rules',
  'canned-responses',
  'csat',
  'custom-attributes',
  'labels',
  'notifications',
  'reports',
  'saved-views',
  'search',
  'sla-policies',
  'teams',
  'usage',
  'api-keys',
  'webhooks',
  'working-hours',
  'public-api',
  'csat-public',
  'widget',
  'webhooks-inbound',
  'other',
]

for (const g of groupOrder) {
  const eps = grouped.get(g)
  if (!eps) continue
  out.push('## ' + g)
  out.push('')
  out.push('| Method | Path |')
  out.push('|---|---|')
  for (const { method, path } of eps.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    out.push(`| \`${method}\` | \`${path}\` |`)
  }
  out.push('')
}

writeFileSync('/Users/rafael/Apps/cosmobots/cosmika/docs/api-reference.md', out.join('\n'))
console.log(`Wrote ${endpoints.size} endpoints across ${grouped.size} groups`)
