// Unit tests for AttachmentsService.
// All external IO (S3, presigner, fs, Prisma) is mocked so the suite is hermetic.
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @aws-sdk/client-s3 with a S3Client whose .send is a vi.fn we can inspect.
const s3SendSpy = vi.fn()
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendSpy })),
  PutObjectCommand: vi.fn().mockImplementation((args: unknown) => ({
    __cmd: 'PutObjectCommand',
    args,
  })),
  GetObjectCommand: vi.fn().mockImplementation((args: unknown) => ({
    __cmd: 'GetObjectCommand',
    args,
  })),
}))

const getSignedUrlSpy = vi.fn(async () => 'https://signed.example.com/x')
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlSpy(...args),
}))

// fs/promises mocks
const mkdirSpy = vi.fn(async () => undefined)
const statSpy = vi.fn(async () => ({}))
const writeFileSpy = vi.fn(async () => undefined)
const readFileSpy = vi.fn(async () => Buffer.from('file-bytes'))
vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mkdirSpy(...args),
  stat: (...args: unknown[]) => statSpy(...args),
  writeFile: (...args: unknown[]) => writeFileSpy(...args),
  readFile: (...args: unknown[]) => readFileSpy(...args),
}))

// fs createReadStream
const createReadStreamSpy = vi.fn(() => ({ readable: true }))
vi.mock('node:fs', () => ({
  createReadStream: (...args: unknown[]) => createReadStreamSpy(...args),
}))

// crypto.randomUUID — deterministic, but shaped like a real uuid (hyphens and
// all). The local-mode fileUrl used to be derived by splitting the storage key
// on `-`, which silently truncated every real id to its first segment; a
// hyphenless fixture would hide that regression coming back.
let uuidCounter = 0
vi.mock('node:crypto', () => ({
  randomUUID: () => `0000000${++uuidCounter}-aaaa-4bbb-8ccc-dddddddddddd`,
}))

const UUID1 = '00000001-aaaa-4bbb-8ccc-dddddddddddd'

// Service-under-test (imported lazily so env vars set per-test take effect)
async function loadService() {
  const mod = await import('./attachments.service')
  return mod.AttachmentsService
}

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    attachment: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  }
}

const ORIGINAL_ENV = { ...process.env }
const ACTIVE_MEMBER = {
  id: 'm1',
  userId: 'u1',
  accountId: 'acc1',
  role: 'AGENT',
  isActive: true,
}

beforeEach(() => {
  // Force a fresh import each test so the constructor re-reads process.env.
  vi.resetModules()
  // Reset env for predictable construction; delete S3 vars first.
  delete process.env.S3_BUCKET
  delete process.env.S3_REGION
  delete process.env.S3_ENDPOINT
  delete process.env.S3_ACCESS_KEY_ID
  delete process.env.S3_SECRET_ACCESS_KEY
  delete process.env.ATTACHMENTS_LOCAL_DIR
  delete process.env.ATTACHMENTS_MAX_BYTES
  delete process.env.API_PUBLIC_URL
  s3SendSpy.mockReset().mockResolvedValue({})
  getSignedUrlSpy.mockClear().mockResolvedValue('https://signed.example.com/x')
  mkdirSpy.mockClear().mockResolvedValue(undefined)
  statSpy.mockClear().mockResolvedValue({})
  writeFileSpy.mockClear().mockResolvedValue(undefined)
  readFileSpy.mockClear().mockResolvedValue(Buffer.from('file-bytes'))
  createReadStreamSpy.mockClear()
  uuidCounter = 0
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('AttachmentsService constructor — storage backend selection', () => {
  it('local mode when S3_BUCKET unset', async () => {
    const Svc = await loadService()
    const svc = new Svc(makePrisma() as never)
    // bucket/s3 are private; assert via behavior — local-mode openLocalStream works
    expect(svc).toBeDefined()
  })

  it('s3 mode when S3_BUCKET set, with endpoint + credentials', async () => {
    process.env.S3_BUCKET = 'cosmika-attachments'
    process.env.S3_REGION = 'eu-west-1'
    process.env.S3_ENDPOINT = 'https://r2.example.com'
    process.env.S3_ACCESS_KEY_ID = 'AKIA'
    process.env.S3_SECRET_ACCESS_KEY = 'SECRET'
    const s3Mod = await import('@aws-sdk/client-s3')
    const Svc = await loadService()
    new Svc(makePrisma() as never)
    expect(s3Mod.S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'eu-west-1',
        endpoint: 'https://r2.example.com',
        forcePathStyle: true,
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'SECRET' },
      }),
    )
  })

  it('s3 mode without endpoint or credentials uses defaults', async () => {
    process.env.S3_BUCKET = 'cosmika-attachments'
    // No S3_REGION → us-east-1 default
    const s3Mod = await import('@aws-sdk/client-s3')
    const Svc = await loadService()
    new Svc(makePrisma() as never)
    const call = (s3Mod.S3Client as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as Record<string, unknown>
    expect(call.region).toBe('us-east-1')
    expect(call.endpoint).toBeUndefined()
    expect(call.credentials).toBeUndefined()
  })
})

describe('AttachmentsService.ingest', () => {
  it('403 when not an active member', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    const svc = new Svc(p as never)
    await expect(
      svc.ingest('u1', 'acc1', { buffer: Buffer.from('x') }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403 when membership is inactive', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ ...ACTIVE_MEMBER, isActive: false })
    await expect(
      new Svc(p as never).ingest('u1', 'acc1', { buffer: Buffer.from('x') }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('400 on empty buffer', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    await expect(
      new Svc(p as never).ingest('u1', 'acc1', { buffer: Buffer.alloc(0) }),
    ).rejects.toThrow(BadRequestException)
  })

  it('400 when file exceeds ATTACHMENTS_MAX_BYTES', async () => {
    process.env.ATTACHMENTS_MAX_BYTES = '8'
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    await expect(
      new Svc(p as never).ingest('u1', 'acc1', {
        buffer: Buffer.from('12345678901'),
      }),
    ).rejects.toThrow(/exceeds 8 bytes/)
  })

  it('local mode: writes to disk + creates Attachment row with fileUrl', async () => {
    process.env.ATTACHMENTS_LOCAL_DIR = '/tmp/cosmika-test'
    process.env.API_PUBLIC_URL = 'https://api.example.com'
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.create.mockResolvedValue({ id: UUID1 })
    await new Svc(p as never).ingest('u1', 'acc1', {
      buffer: Buffer.from('hello'),
      filename: 'note.txt',
      mimetype: 'text/plain',
    })
    expect(mkdirSpy).toHaveBeenCalledWith('/tmp/cosmika-test/acc1', { recursive: true })
    expect(writeFileSpy).toHaveBeenCalledWith(
      `/tmp/cosmika-test/acc1/${UUID1}-note.txt`,
      Buffer.from('hello'),
    )
    const created = p.attachment.create.mock.calls[0]![0]
    expect(created.data.id).toBe(UUID1)
    expect(created.data.storageKey).toBe(`acc1/${UUID1}-note.txt`)
    expect(created.data.fileType).toBe('FILE')
    expect(created.data.fileUrl).toBe(`https://api.example.com/attachments-files/${UUID1}`)
    expect(created.data.fileName).toBe('note.txt')
    expect(created.data.fileSize).toBe(5)
    expect(created.data.mimeType).toBe('text/plain')
  })

  it('local mode: defaults filename "file" + API_PUBLIC_URL when env unset', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.create.mockResolvedValue({ id: UUID1 })
    await new Svc(p as never).ingest('u1', 'acc1', {
      buffer: Buffer.from('hi'),
    })
    const created = p.attachment.create.mock.calls[0]![0]
    expect(created.data.storageKey).toMatch(new RegExp(`^acc1/${UUID1}-file$`))
    expect(created.data.fileUrl).toBe(`http://localhost:3110/attachments-files/${UUID1}`)
    expect(created.data.fileName).toBeNull()
    expect(created.data.mimeType).toBeNull()
    expect(created.data.fileType).toBe('FALLBACK')
  })

  it('s3 mode: sends PutObjectCommand and returns s3:// URL', async () => {
    process.env.S3_BUCKET = 'mybucket'
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.create.mockResolvedValue({ id: UUID1 })
    await new Svc(p as never).ingest('u1', 'acc1', {
      buffer: Buffer.from('img'),
      filename: 'photo.png',
      mimetype: 'image/png',
    })
    expect(s3SendSpy).toHaveBeenCalled()
    const cmd = s3SendSpy.mock.calls[0]![0] as { args: Record<string, unknown> }
    expect(cmd.args).toMatchObject({
      Bucket: 'mybucket',
      Key: `acc1/${UUID1}-photo.png`,
      ContentType: 'image/png',
    })
    const created = p.attachment.create.mock.calls[0]![0]
    expect(created.data.fileUrl).toBe(`s3://mybucket/acc1/${UUID1}-photo.png`)
    expect(created.data.fileType).toBe('IMAGE')
  })

  it('sanitizes special chars in filename and truncates >120 chars', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.create.mockResolvedValue({ id: UUID1 })
    const noisy = '../../etc/p@$$wd<script>.txt' + 'A'.repeat(200)
    await new Svc(p as never).ingest('u1', 'acc1', {
      buffer: Buffer.from('x'),
      filename: noisy,
    })
    const created = p.attachment.create.mock.calls[0]![0]
    // storageKey = `${accountId}/${id}-${sanitize(filename)}`. After stripping
    // the account + id prefix we should see only the sanitized filename which
    // contains exactly the allowed chars (a-z, A-Z, 0-9, dot, underscore, hyphen).
    const filenamePart = (created.data.storageKey as string).slice(`acc1/${UUID1}-`.length)
    expect(filenamePart).toMatch(/^[a-zA-Z0-9._-]+$/)
    expect(filenamePart.length).toBeLessThanOrEqual(120)
    // Verify the < and @ and $ and > were stripped.
    expect(filenamePart).not.toContain('<')
    expect(filenamePart).not.toContain('@')
    expect(filenamePart).not.toContain('$')
  })

  it('detectFileType: image / video / audio / file / fallback', async () => {
    const cases: Array<[string | undefined, string]> = [
      ['image/png', 'IMAGE'],
      ['video/mp4', 'VIDEO'],
      ['audio/mpeg', 'AUDIO'],
      ['application/pdf', 'FILE'],
      [undefined, 'FALLBACK'],
    ]
    for (const [mime, expected] of cases) {
      const Svc = await loadService()
      const p = makePrisma()
      p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
      p.attachment.create.mockResolvedValue({ id: `uuid-x` })
      await new Svc(p as never).ingest('u1', 'acc1', {
        buffer: Buffer.from('z'),
        filename: 'a',
        mimetype: mime,
      })
      const created = p.attachment.create.mock.calls[0]![0]
      expect(created.data.fileType).toBe(expected)
    }
  })
})

describe('AttachmentsService.getDownloadUrl', () => {
  it('404 unknown id', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.findUnique.mockResolvedValue(null)
    await expect(new Svc(p as never).getDownloadUrl('u1', 'acc1', 'a1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 cross-account IDOR', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.findUnique.mockResolvedValue({ id: 'a1', accountId: 'other' })
    await expect(new Svc(p as never).getDownloadUrl('u1', 'acc1', 'a1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('local mode: returns att.fileUrl directly', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.findUnique.mockResolvedValue({
      id: 'a1',
      accountId: 'acc1',
      fileUrl: 'http://localhost:3110/attachments-files/a1',
      storageKey: 'acc1/a1-file',
    })
    expect(await new Svc(p as never).getDownloadUrl('u1', 'acc1', 'a1')).toBe(
      'http://localhost:3110/attachments-files/a1',
    )
  })

  it('s3 mode: returns presigned URL via getSignedUrl', async () => {
    process.env.S3_BUCKET = 'mybucket'
    const Svc = await loadService()
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    p.attachment.findUnique.mockResolvedValue({
      id: 'a1',
      accountId: 'acc1',
      storageKey: 'acc1/a1-file',
      fileUrl: 's3://mybucket/acc1/a1-file',
    })
    const url = await new Svc(p as never).getDownloadUrl('u1', 'acc1', 'a1')
    expect(url).toBe('https://signed.example.com/x')
    expect(getSignedUrlSpy).toHaveBeenCalled()
  })
})

describe('AttachmentsService.openLocalStream', () => {
  it('404 attachment not found', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findUnique.mockResolvedValue(null)
    await expect(new Svc(p as never).openLocalStream('u1', 'a1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('403 when caller not a member of the attachment account', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findUnique.mockResolvedValue({ id: 'a1', accountId: 'acc1', storageKey: 'k' })
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(new Svc(p as never).openLocalStream('u1', 'a1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('400 when storageMode is s3', async () => {
    process.env.S3_BUCKET = 'mybucket'
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findUnique.mockResolvedValue({ id: 'a1', accountId: 'acc1', storageKey: 'k' })
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    await expect(new Svc(p as never).openLocalStream('u1', 'a1')).rejects.toThrow(
      /Use the presigned URL/,
    )
  })

  it('404 when file missing on disk', async () => {
    process.env.ATTACHMENTS_LOCAL_DIR = '/tmp/cosmika-test'
    statSpy.mockRejectedValueOnce(new Error('ENOENT'))
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findUnique.mockResolvedValue({ id: 'a1', accountId: 'acc1', storageKey: 'k' })
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    await expect(new Svc(p as never).openLocalStream('u1', 'a1')).rejects.toThrow(
      'File missing on disk',
    )
  })

  it('returns stream + att on happy path', async () => {
    process.env.ATTACHMENTS_LOCAL_DIR = '/tmp/cosmika-test'
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findUnique.mockResolvedValue({
      id: 'a1',
      accountId: 'acc1',
      storageKey: 'acc1/a1-file',
    })
    p.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    const result = await new Svc(p as never).openLocalStream('u1', 'a1')
    expect(result.att.id).toBe('a1')
    expect(createReadStreamSpy).toHaveBeenCalledWith('/tmp/cosmika-test/acc1/a1-file')
  })
})

describe('AttachmentsService.attachToMessage', () => {
  it('returns [] for empty input', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    expect(await new Svc(p as never).attachToMessage('acc1', 'msg1', [])).toEqual([])
    expect(p.attachment.findMany).not.toHaveBeenCalled()
  })

  it('400 when one or more attachments not found', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findMany.mockResolvedValueOnce([{ id: 'a1', messageId: null }])
    await expect(
      new Svc(p as never).attachToMessage('acc1', 'msg1', ['a1', 'a2']),
    ).rejects.toThrow(/One or more attachments not found/)
  })

  it('400 when an attachment is already linked to a different message', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findMany.mockResolvedValueOnce([
      { id: 'a1', messageId: 'otherMsg' },
    ])
    await expect(
      new Svc(p as never).attachToMessage('acc1', 'msg1', ['a1']),
    ).rejects.toThrow(/already linked to another message/)
  })

  it('OK when attachment already linked to the SAME message (idempotent)', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findMany
      .mockResolvedValueOnce([{ id: 'a1', messageId: 'msg1' }])
      .mockResolvedValueOnce([{ id: 'a1', messageId: 'msg1' }])
    p.attachment.updateMany.mockResolvedValue({ count: 1 })
    const rows = await new Svc(p as never).attachToMessage('acc1', 'msg1', ['a1'])
    expect(rows).toEqual([{ id: 'a1', messageId: 'msg1' }])
    expect(p.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1'] }, accountId: 'acc1' },
      data: { messageId: 'msg1' },
    })
  })

  it('updates draft (messageId=null) attachments and returns hydrated rows', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findMany
      .mockResolvedValueOnce([
        { id: 'a1', messageId: null },
        { id: 'a2', messageId: null },
      ])
      .mockResolvedValueOnce([
        { id: 'a1', messageId: 'msg1' },
        { id: 'a2', messageId: 'msg1' },
      ])
    p.attachment.updateMany.mockResolvedValue({ count: 2 })
    const rows = await new Svc(p as never).attachToMessage('acc1', 'msg1', ['a1', 'a2'])
    expect(rows).toHaveLength(2)
  })
})

describe('AttachmentsService.listForMessage', () => {
  it('queries attachments by messageId ordered by createdAt asc', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.findMany.mockResolvedValue([{ id: 'a1' }])
    const out = await new Svc(p as never).listForMessage('msg1')
    expect(out).toEqual([{ id: 'a1' }])
    expect(p.attachment.findMany).toHaveBeenCalledWith({
      where: { messageId: 'msg1' },
      orderBy: { createdAt: 'asc' },
    })
  })
})

describe('AttachmentsService.resolveOutboundMedia', () => {
  const ATT = {
    id: 'a1',
    accountId: 'acc1',
    storageKey: 'acc1/a1-photo.png',
    fileType: 'IMAGE',
    fileUrl: 'https://cdn.example.com/x',
    fileName: 'photo.png',
    mimeType: 'image/png',
  }

  it('s3 mode: hands over the presigned URL as a link', async () => {
    process.env.S3_BUCKET = 'cosmika-attachments'
    getSignedUrlSpy.mockResolvedValue('https://r2.example.com/acc1/a1-photo.png?sig=1')
    const Svc = await loadService()
    const out = await new Svc(makePrisma() as never).resolveOutboundMedia(
      ATT as never,
    )
    expect(out).toEqual({
      kind: 'link',
      url: 'https://r2.example.com/acc1/a1-photo.png?sig=1',
    })
    expect(s3SendSpy).not.toHaveBeenCalled()
  })

  it('s3 mode: falls back to bytes when the presigned URL is not public', async () => {
    process.env.S3_BUCKET = 'cosmika-attachments'
    // MinIO in dev — Meta's servers can't reach a loopback host.
    getSignedUrlSpy.mockResolvedValue('https://127.0.0.1:9000/acc1/a1-photo.png?sig=1')
    s3SendSpy.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    })
    const Svc = await loadService()
    const out = await new Svc(makePrisma() as never).resolveOutboundMedia(
      ATT as never,
    )
    expect(out).toEqual({
      kind: 'bytes',
      buffer: Buffer.from([1, 2, 3]),
      mimeType: 'image/png',
      fileName: 'photo.png',
    })
  })

  it.each([
    ['http (not https)', 'http://cdn.example.com/x'],
    ['localhost', 'https://localhost:9000/x'],
    ['*.local', 'https://minio.local/x'],
    ['RFC1918 /16', 'https://192.168.1.9/x'],
    ['RFC1918 /12', 'https://172.20.0.4/x'],
    ['RFC1918 /8', 'https://10.0.0.7/x'],
    ['link-local', 'https://169.254.169.254/x'],
    ['ipv6 loopback', 'https://[::1]/x'],
    ['0.0.0.0', 'https://0.0.0.0/x'],
    ['*.localhost', 'https://minio.localhost/x'],
    ['*.internal', 'https://storage.internal/x'],
    ['not a URL', 'not-a-url'],
  ])('s3 mode: %s is not publicly fetchable → bytes', async (_label, url) => {
    process.env.S3_BUCKET = 'cosmika-attachments'
    getSignedUrlSpy.mockResolvedValue(url)
    s3SendSpy.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([9]) },
    })
    const Svc = await loadService()
    const out = await new Svc(makePrisma() as never).resolveOutboundMedia(
      ATT as never,
    )
    expect(out.kind).toBe('bytes')
  })

  it('s3 mode: 404s when the object has no readable body', async () => {
    process.env.S3_BUCKET = 'cosmika-attachments'
    getSignedUrlSpy.mockResolvedValue('https://localhost/x')
    s3SendSpy.mockResolvedValue({})
    const Svc = await loadService()
    await expect(
      new Svc(makePrisma() as never).resolveOutboundMedia(ATT as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('local mode: reads the bytes off disk', async () => {
    process.env.ATTACHMENTS_LOCAL_DIR = '/tmp/cosmika-test'
    readFileSpy.mockResolvedValue(Buffer.from('png-bytes'))
    const Svc = await loadService()
    const out = await new Svc(makePrisma() as never).resolveOutboundMedia(
      ATT as never,
    )
    expect(readFileSpy).toHaveBeenCalledWith('/tmp/cosmika-test/acc1/a1-photo.png')
    expect(out).toEqual({
      kind: 'bytes',
      buffer: Buffer.from('png-bytes'),
      mimeType: 'image/png',
      fileName: 'photo.png',
    })
  })

  it('local mode: falls back to a placeholder when there is no name at all', async () => {
    const Svc = await loadService()
    const out = await new Svc(makePrisma() as never).resolveOutboundMedia({
      ...ATT,
      fileName: null,
      storageKey: '',
    } as never)
    expect(out).toMatchObject({ fileName: 'file' })
  })

  it('local mode: falls back to the storage key when fileName is null', async () => {
    const Svc = await loadService()
    const out = await new Svc(makePrisma() as never).resolveOutboundMedia({
      ...ATT,
      fileName: null,
      mimeType: null,
    } as never)
    expect(out).toMatchObject({
      mimeType: 'application/octet-stream',
      fileName: 'a1-photo.png',
    })
  })

  it('local mode: 404s when the file is gone from disk', async () => {
    readFileSpy.mockRejectedValue(new Error('ENOENT'))
    const Svc = await loadService()
    await expect(
      new Svc(makePrisma() as never).resolveOutboundMedia(ATT as never),
    ).rejects.toThrow(NotFoundException)
  })
})

describe('AttachmentsService.toDTO', () => {
  it('serialises every field with ISO createdAt', async () => {
    const Svc = await loadService()
    const svc = new Svc(makePrisma() as never)
    expect(
      svc.toDTO({
        id: 'a1',
        accountId: 'acc1',
        messageId: 'msg1',
        fileType: 'IMAGE',
        fileUrl: 'https://x',
        fileName: 'p.png',
        fileSize: 123,
        mimeType: 'image/png',
        createdAt: new Date('2026-04-01T00:00:00Z'),
      } as never),
    ).toEqual({
      id: 'a1',
      accountId: 'acc1',
      messageId: 'msg1',
      fileType: 'IMAGE',
      fileUrl: 'https://x',
      fileName: 'p.png',
      fileSize: 123,
      mimeType: 'image/png',
      createdAt: '2026-04-01T00:00:00.000Z',
    })
  })
})

describe('AttachmentsService.ingestFromChannel', () => {
  it('stores a contact file with no uploader and no membership check', async () => {
    process.env.ATTACHMENTS_LOCAL_DIR = '/tmp/cosmika-test'
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.create.mockResolvedValue({ id: UUID1 })
    await new Svc(p as never).ingestFromChannel('acc1', {
      buffer: Buffer.from('docx!'),
      fileName: 'Formulário - Reforma.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    // A contact is not an account member; asking would always fail.
    expect(p.accountMember.findUnique).not.toHaveBeenCalled()
    const created = p.attachment.create.mock.calls[0]![0]
    expect(created.data).toMatchObject({
      accountId: 'acc1',
      uploaderId: null,
      messageId: null,
      fileName: 'Formulário - Reforma.docx',
      fileSize: 5,
      fileType: 'FILE',
    })
    // The storage key is sanitized; the display name keeps its accents.
    expect(created.data.storageKey).toBe(`acc1/${UUID1}-Formul_rio_-_Reforma.docx`)
  })

  it('attaches straight to a message when given one (backfill)', async () => {
    const Svc = await loadService()
    const p = makePrisma()
    p.attachment.create.mockResolvedValue({ id: UUID1 })
    await new Svc(p as never).ingestFromChannel('acc1', { buffer: Buffer.from('x') }, 'msg-1')
    const created = p.attachment.create.mock.calls[0]![0]
    expect(created.data.messageId).toBe('msg-1')
    expect(created.data.fileName).toBeNull()
    expect(created.data.mimeType).toBeNull()
    expect(created.data.storageKey).toMatch(/-file$/)
  })

  it('rejects an empty file', async () => {
    const Svc = await loadService()
    await expect(
      new Svc(makePrisma() as never).ingestFromChannel('acc1', { buffer: Buffer.alloc(0) }),
    ).rejects.toThrow(/Empty file/)
  })
})
