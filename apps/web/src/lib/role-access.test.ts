import { describe, expect, it } from 'vitest'

import { canAccessPath } from './role-access'

describe('canAccessPath', () => {
  it('lets administrators and supervisors go anywhere', () => {
    for (const role of ['ADMINISTRATOR', 'SUPERVISOR']) {
      expect(canAccessPath(role, '/settings/members')).toBe(true)
      expect(canAccessPath(role, '/flows/abc')).toBe(true)
    }
  })

  it('closes settings, user management and configuration areas to agents', () => {
    for (const p of [
      '/settings',
      '/settings/members',
      '/settings/account',
      '/settings/audit-log',
      '/settings/data-export',
      '/inboxes',
      '/inboxes/new',
      '/agent-bots/1',
      '/flows/1',
      '/teams',
      '/automation',
      '/broadcasts',
      '/labels',
      '/reports',
      '/reports/csat',
      '/assistant',
    ]) {
      expect(canAccessPath('AGENT', p), p).toBe(false)
    }
  })

  it('keeps the agent workspace, canned responses and their own account pages', () => {
    for (const p of [
      '/inbox',
      '/conversations/12',
      '/contacts',
      '/canned-responses',
      '/knowledge-base',
      '/tickets',
      '/settings/profile',
      '/settings/security',
      '/settings/availability',
    ]) {
      expect(canAccessPath('AGENT', p), p).toBe(true)
    }
  })

  it('matches whole path segments, not prefixes of words', () => {
    expect(canAccessPath('AGENT', '/settingsx')).toBe(true)
    expect(canAccessPath('AGENT', '/settings/profile-x')).toBe(false)
  })

  it('does not lock anyone out while the role is still unknown', () => {
    expect(canAccessPath(undefined, '/settings/members')).toBe(true)
  })
})
