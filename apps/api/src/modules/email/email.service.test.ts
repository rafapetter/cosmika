import { ConfigService } from '@nestjs/config'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EmailService } from './email.service'

function makeService(overrides: Record<string, unknown> = {}) {
  const config: Partial<ConfigService> = {
    get: vi.fn((key: string) => overrides[key]),
  }
  return new EmailService(config as ConfigService)
}

describe('EmailService.send', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips (returns false) without calling the provider when no key is set', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const svc = makeService()
    await expect(svc.send('a@b.com', 'Hi', 'body')).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('treats an empty key the same as no key', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const svc = makeService({ RESEND_API_KEY: '' })
    await expect(svc.send('a@b.com', 'Hi', 'body')).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends from the configured address, ignoring a blank one', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    await makeService({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Acme <hi@acme.example>' }).send('a@b.com', 'Hi', 'b')
    await makeService({ RESEND_API_KEY: 're_test', EMAIL_FROM: '  ' }).send('a@b.com', 'Hi', 'b')
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body).from).toBe('Acme <hi@acme.example>')
    expect(JSON.parse(fetchSpy.mock.calls[1]![1].body).from).toBe('Cosmika <no-reply@example.com>')
  })

  it('posts to Resend with auth header and default from, returns true on 200', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    const svc = makeService({ RESEND_API_KEY: 're_test' })
    await expect(svc.send('a@b.com', 'Hi', 'body')).resolves.toBe(true)

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.authorization).toBe('Bearer re_test')
    const payload = JSON.parse(init.body)
    expect(payload).toEqual({
      from: 'Cosmika <no-reply@example.com>',
      to: ['a@b.com'],
      subject: 'Hi',
      text: 'body',
    })
  })

  it('honors EMAIL_FROM override', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    const svc = makeService({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Ops <ops@x.com>' })
    await svc.send('a@b.com', 'Hi', 'body')
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body).from).toBe('Ops <ops@x.com>')
  })

  it('returns false and logs on a provider error (body read ok)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: vi.fn().mockResolvedValue('nope'),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const svc = makeService({ RESEND_API_KEY: 're_test' })
    await expect(svc.send('a@b.com', 'Hi', 'body')).resolves.toBe(false)
  })

  it('returns false when the error body itself fails to read', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockRejectedValue(new Error('stream dead')),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const svc = makeService({ RESEND_API_KEY: 're_test' })
    await expect(svc.send('a@b.com', 'Hi', 'body')).resolves.toBe(false)
  })
})
