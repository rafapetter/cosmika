import { createHash, randomBytes } from 'node:crypto'

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { ApiKey } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertAdmin(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
  }

  private hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex')
  }

  /** Format: cosmika_<prefix>_<secret>. Prefix is shown in UI; secret is hashed. */
  private generate(): { prefix: string; secret: string; token: string } {
    const prefix = randomBytes(4).toString('hex') // 8 chars
    const secret = randomBytes(24).toString('base64url')
    return { prefix, secret, token: `cosmika_${prefix}_${secret}` }
  }

  async list(userId: string, accountId: string): Promise<ApiKey[]> {
    await this.assertAdmin(userId, accountId)
    return this.prisma.apiKey.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async create(
    userId: string,
    accountId: string,
    name: string,
  ): Promise<{ row: ApiKey; token: string }> {
    await this.assertAdmin(userId, accountId)
    const { prefix, secret, token } = this.generate()
    const row = await this.prisma.apiKey.create({
      data: {
        accountId,
        name,
        prefix,
        secretHash: this.hash(token),
      },
    })
    return { row, token }
  }

  async revoke(userId: string, accountId: string, id: string): Promise<void> {
    await this.assertAdmin(userId, accountId)
    const existing = await this.prisma.apiKey.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    })
  }

  /**
   * Resolve a token to an account id (called from AuthGuard). Returns null on
   * any failure — bad shape, unknown prefix, hash mismatch, revoked. The
   * caller treats null as "not authenticated".
   */
  async resolveToken(token: string): Promise<{ accountId: string } | null> {
    const m = /^cosmika_([0-9a-f]{8})_/.exec(token)
    if (!m) return null
    const prefix = m[1]
    const row = await this.prisma.apiKey.findUnique({
      where: { prefix },
    })
    if (!row || row.revokedAt) return null
    if (row.secretHash !== this.hash(token)) return null
    // Fire-and-forget lastUsedAt update — not critical-path.
    void this.prisma.apiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined)
    return { accountId: row.accountId }
  }

  toDTO(k: ApiKey) {
    return {
      id: k.id,
      accountId: k.accountId,
      name: k.name,
      prefix: k.prefix,
      revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
      lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
      createdAt: k.createdAt.toISOString(),
    }
  }
}
