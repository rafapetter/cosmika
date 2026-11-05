import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeGraphError, graphCall } from './embedded-signup.graph'

afterEach(() => vi.unstubAllGlobals())

describe('graphCall', () => {
  it('builds the URL, sends bearer + JSON, and returns the body', async () => {
    const fetchMock = vi.fn(async () => new Response('{"success":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await graphCall('https://g/v25.0', '/123/register', {
      method: 'POST',
      token: 'tok',
      query: { a: 'b c' },
      body: { pin: '000111' },
    })
    expect(r).toEqual({ ok: true, data: { success: true } })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://g/v25.0/123/register?a=b+c')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' })
    expect(init.body).toBe('{"pin":"000111"}')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a bare GET has no auth, no content type and no body', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await graphCall('https://g', 'x')).toEqual({ ok: true, data: {} })
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init).toMatchObject({ method: 'GET', headers: {} })
    expect('body' in init).toBe(false)
  })

  it('maps a Graph error body', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ error: { message: 'Invalid', code: 100, error_subcode: 2388, fbtrace_id: 'AbC' } }),
        { status: 400 },
      ),
    )
    expect(await graphCall('https://g', 'x')).toEqual({
      ok: false,
      error: { status: 400, code: 100, subcode: 2388, fbtraceId: 'AbC', message: 'Invalid' },
    })
  })

  it('an error without a body still says what happened', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 502 }))
    expect(await graphCall('https://g', 'x')).toEqual({
      ok: false,
      error: { status: 502, code: null, subcode: null, fbtraceId: null, message: 'HTTP 502' },
    })
  })

  it('a network failure or timeout is status 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError')
    })
    expect(await graphCall('https://g', 'x')).toMatchObject({ ok: false, error: { status: 0, message: 'TimeoutError' } })
    vi.stubGlobal('fetch', async () => {
      throw 'weird'
    })
    expect(await graphCall('https://g', 'x')).toMatchObject({ ok: false, error: { message: 'network error' } })
  })
})

describe('describeGraphError', () => {
  it('prints ids only', () => {
    expect(
      describeGraphError({ status: 400, code: 100, subcode: null, fbtraceId: null, message: 'm' }),
    ).toBe('status=400 code=100 subcode=- fbtrace_id=- message=m')
    expect(
      describeGraphError({ status: 0, code: null, subcode: 3, fbtraceId: 'T', message: 'm' }),
    ).toBe('status=0 code=- subcode=3 fbtrace_id=T message=m')
  })
})
