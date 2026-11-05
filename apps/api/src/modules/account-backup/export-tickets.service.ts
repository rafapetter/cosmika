import { randomBytes } from 'node:crypto'

import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { DataExportFormat, DataExportKind } from '@cosmika/shared'
import { Redis } from 'ioredis'

export type ExportTicket = {
  accountId: string
  userId: string
  kind: DataExportKind
  format: DataExportFormat
  from?: string
  to?: string
}

const TTL_SECONDS = 120
const key = (id: string) => `export-ticket:${id}`

/**
 * One-time download tickets. The web app authenticates with a bearer token,
 * which a plain link cannot carry; fetching the file into a Blob instead
 * would hold a whole account (1M+ messages) in browser memory. So the app
 * asks for a ticket (authenticated, audited) and points the browser at
 * /exports/download/<ticket>, which streams straight to disk. Redis, not
 * process memory, so it holds with more than one API instance.
 */
@Injectable()
export class ExportTicketsService implements OnModuleDestroy {
  private redis: Redis | null = null

  constructor(private readonly config: ConfigService) {}

  private client(): Redis {
    this.redis ??= new Redis(this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
      lazyConnect: true,
    })
    return this.redis
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined)
  }

  async issue(ticket: ExportTicket): Promise<string> {
    const id = randomBytes(24).toString('base64url')
    await this.client().set(key(id), JSON.stringify(ticket), 'EX', TTL_SECONDS)
    return id
  }

  /** Single use: the ticket is deleted as it is read. */
  async redeem(id: string): Promise<ExportTicket | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null
    const raw = await this.client().getdel(key(id))
    return raw ? (JSON.parse(raw) as ExportTicket) : null
  }
}
