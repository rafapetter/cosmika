import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Attachment, FileType as PrismaFileType } from '@cosmika/db'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

type StorageMode = 's3' | 'local'

/**
 * An attachment resolved into a form an external channel can consume.
 * `link` is a URL the channel's servers will fetch themselves; `bytes` is the
 * raw file, for channels that must be handed the content directly.
 */
export type OutboundMedia =
  | { kind: 'link'; url: string }
  | { kind: 'bytes'; buffer: Buffer; mimeType: string; fileName: string }

@Injectable()
export class AttachmentsService {
  private readonly storageMode: StorageMode
  private readonly s3: S3Client | null
  private readonly bucket: string | null
  private readonly localDir: string

  constructor(private readonly prisma: PrismaService) {
    const bucket = process.env.S3_BUCKET
    if (bucket) {
      this.storageMode = 's3'
      this.bucket = bucket
      this.s3 = new S3Client({
        region: process.env.S3_REGION ?? 'us-east-1',
        ...(process.env.S3_ENDPOINT
          ? {
              endpoint: process.env.S3_ENDPOINT,
              forcePathStyle: true,
            }
          : {}),
        ...(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY_ID,
                secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      })
    } else {
      this.storageMode = 'local'
      this.bucket = null
      this.s3 = null
    }
    this.localDir =
      process.env.ATTACHMENTS_LOCAL_DIR ??
      join(process.cwd(), 'tmp', 'attachments')
  }

  private async getMembership(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  /**
   * Server-proxied upload. Caller has already authenticated via AuthGuard.
   * Streams (or buffers) the file into storage, creates a draft Attachment
   * (messageId=null) owned by the account + uploader.
   */
  async ingest(
    userId: string,
    accountId: string,
    file: {
      filename?: string
      mimetype?: string
      buffer: Buffer
    },
  ): Promise<Attachment> {
    await this.getMembership(userId, accountId)
    if (!file.buffer.length) throw new BadRequestException(errBody('file_empty', 'Empty file'))
    const maxBytes = Number(process.env.ATTACHMENTS_MAX_BYTES ?? 25 * 1024 * 1024)
    if (file.buffer.length > maxBytes) {
      throw new BadRequestException(errBody('file_too_large', `File exceeds ${maxBytes} bytes`))
    }
    const id = randomUUID()
    const key = `${accountId}/${id}-${sanitize(file.filename ?? 'file')}`
    const fileUrl = await this.writeToStorage(id, key, file.buffer, file.mimetype)
    return this.prisma.attachment.create({
      data: {
        id,
        accountId,
        uploaderId: userId,
        storageKey: key,
        fileType: detectFileType(file.mimetype),
        fileUrl,
        fileName: file.filename ?? null,
        fileSize: file.buffer.length,
        mimeType: file.mimetype ?? null,
      },
    })
  }

  /**
   * Store a file a contact sent through a channel (WhatsApp today).
   *
   * No membership check: the caller is the channel ingest, not a user, and
   * the account was already resolved from the inbox the webhook hit.
   * `uploaderId` stays null, which is the schema's convention for contact
   * uploads. Pass `messageId` to attach immediately (backfill); leave it out
   * to create a draft the message transaction links.
   */
  async ingestFromChannel(
    accountId: string,
    file: { buffer: Buffer; mimeType?: string; fileName?: string },
    messageId?: string,
  ): Promise<Attachment> {
    if (!file.buffer.length) throw new BadRequestException(errBody('file_empty', 'Empty file'))
    const id = randomUUID()
    const key = `${accountId}/${id}-${sanitize(file.fileName ?? 'file')}`
    const fileUrl = await this.writeToStorage(id, key, file.buffer, file.mimeType)
    return this.prisma.attachment.create({
      data: {
        id,
        accountId,
        uploaderId: null,
        messageId: messageId ?? null,
        storageKey: key,
        fileType: detectFileType(file.mimeType),
        fileUrl,
        fileName: file.fileName ?? null,
        fileSize: file.buffer.length,
        mimeType: file.mimeType ?? null,
      },
    })
  }

  async getDownloadUrl(
    userId: string,
    accountId: string,
    id: string,
  ): Promise<string> {
    await this.getMembership(userId, accountId)
    const att = await this.prisma.attachment.findUnique({ where: { id } })
    if (!att || att.accountId !== accountId) throw new NotFoundException()
    return this.urlFor(att)
  }

  /**
   * Stream a local file out by attachmentId. Only used when storageMode='local'.
   * Caller must be an active member of the attachment's account.
   */
  async openLocalStream(
    userId: string,
    id: string,
  ): Promise<{ stream: Readable; att: Attachment }> {
    const att = await this.prisma.attachment.findUnique({ where: { id } })
    if (!att) throw new NotFoundException()
    await this.getMembership(userId, att.accountId)
    if (this.storageMode !== 'local') {
      throw new BadRequestException(errBody('file_use_presigned', 'Use the presigned URL instead'))
    }
    const path = join(this.localDir, att.storageKey)
    try {
      await stat(path)
    } catch {
      throw new NotFoundException('File missing on disk')
    }
    return { stream: createReadStream(path), att }
  }

  /**
   * Bulk-attach uploaded (draft) attachments to a message during message
   * creation. Validates that every attachment belongs to the same account
   * and is still draft (messageId=null).
   */
  async attachToMessage(
    accountId: string,
    messageId: string,
    attachmentIds: string[],
  ): Promise<Attachment[]> {
    if (attachmentIds.length === 0) return []
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: attachmentIds }, accountId },
    })
    if (rows.length !== attachmentIds.length) {
      throw new BadRequestException(errBody('attachment_not_found', 'One or more attachments not found'))
    }
    for (const r of rows) {
      if (r.messageId !== null && r.messageId !== messageId) {
        throw new BadRequestException(errBody('attachment_already_linked', `Attachment ${r.id} is already linked to another message`))
      }
    }
    await this.prisma.attachment.updateMany({
      where: { id: { in: attachmentIds }, accountId },
      data: { messageId },
    })
    return this.prisma.attachment.findMany({
      where: { id: { in: attachmentIds } },
    })
  }

  async listForMessage(messageId: string): Promise<Attachment[]> {
    return this.prisma.attachment.findMany({
      where: { messageId },
      orderBy: { createdAt: 'asc' },
    })
  }

  /**
   * Resolve an attachment into something an external channel can deliver.
   * Internal server-side path: the caller has already authorized access to the
   * owning conversation, so there's no membership check here.
   *
   * A presigned S3/R2 URL is handed over as a link when it's reachable from the
   * public internet, which spares us shipping the bytes twice. Local-disk mode
   * has no such URL — its `fileUrl` points at an auth-guarded API route — and
   * neither does an S3 endpoint on a private network (MinIO in dev), so both
   * fall back to raw bytes for the channel to upload itself.
   */
  async resolveOutboundMedia(att: Attachment): Promise<OutboundMedia> {
    const mimeType = att.mimeType ?? 'application/octet-stream'
    // `split('/').pop()` is typed `string | undefined` but never actually
    // undefined, so a `??` fallback there would be an untestable branch. Slice
    // to the last segment instead — that genuinely can come back empty.
    const keyTail = att.storageKey.slice(att.storageKey.lastIndexOf('/') + 1)
    const fileName = att.fileName ?? (keyTail || 'file')
    if (this.storageMode === 's3' && this.s3 && this.bucket) {
      const url = await this.urlFor(att)
      if (isPubliclyFetchable(url)) return { kind: 'link', url }
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: att.storageKey }),
      )
      const body = res.Body as
        | { transformToByteArray?: () => Promise<Uint8Array> }
        | undefined
      if (!body?.transformToByteArray) {
        throw new NotFoundException('Attachment body missing in storage')
      }
      return {
        kind: 'bytes',
        buffer: Buffer.from(await body.transformToByteArray()),
        mimeType,
        fileName,
      }
    }
    try {
      return {
        kind: 'bytes',
        buffer: await readFile(join(this.localDir, att.storageKey)),
        mimeType,
        fileName,
      }
    } catch {
      throw new NotFoundException('File missing on disk')
    }
  }

  toDTO(att: Attachment): {
    id: string
    accountId: string
    messageId: string | null
    fileType: PrismaFileType
    fileUrl: string
    fileName: string | null
    fileSize: number | null
    mimeType: string | null
    createdAt: string
  } {
    return {
      id: att.id,
      accountId: att.accountId,
      messageId: att.messageId,
      fileType: att.fileType,
      fileUrl: att.fileUrl,
      fileName: att.fileName,
      fileSize: att.fileSize,
      mimeType: att.mimeType,
      createdAt: att.createdAt.toISOString(),
    }
  }

  // ─── storage backend ────────────────────────────────────────────

  private async writeToStorage(
    id: string,
    key: string,
    buffer: Buffer,
    mimetype: string | undefined,
  ): Promise<string> {
    if (this.storageMode === 's3' && this.s3 && this.bucket) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
        }),
      )
      return `s3://${this.bucket}/${key}`
    }
    // local mode
    const path = join(this.localDir, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buffer)
    const apiBase = process.env.API_PUBLIC_URL ?? 'http://localhost:3110'
    return `${apiBase}/attachments-files/${id}`
  }

  private async urlFor(att: Attachment): Promise<string> {
    if (this.storageMode === 's3' && this.s3 && this.bucket) {
      return getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: att.storageKey }),
        { expiresIn: 60 * 60 }, // 1h
      )
    }
    return att.fileUrl
  }
}

/**
 * Can a third-party server (Meta's, in practice) actually GET this URL? Only
 * https on a host that resolves outside our own network — a presigned URL
 * pointing at a loopback or RFC1918 MinIO endpoint is useless to them.
 */
function isPubliclyFetchable(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === '::1' || host === '0.0.0.0') return false
  return !/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
    host,
  )
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
}

function detectFileType(mime: string | undefined): PrismaFileType {
  if (!mime) return 'FALLBACK'
  if (mime.startsWith('image/')) return 'IMAGE'
  if (mime.startsWith('video/')) return 'VIDEO'
  if (mime.startsWith('audio/')) return 'AUDIO'
  return 'FILE'
}
