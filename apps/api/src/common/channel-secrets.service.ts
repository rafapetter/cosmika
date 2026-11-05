import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { WHATSAPP_STORED_SECRET_FIELDS } from '@cosmika/shared'

import { PrismaService } from '../prisma/prisma.service'

import {
  SECRETS_KEY_ENV,
  SecretCryptoError,
  hasEncryptedSecret,
  loadSecretsKey,
  secretsKeyConfigured,
} from './secret-crypto'

/**
 * Boot-time contract for channel secrets. Fail fast and loudly here, so a key
 * problem never turns into a per-channel failure at the moment a customer
 * message needs sending.
 *
 * Three states refuse to start:
 *
 *  1. `COSMIKA_SECRETS_KEY` is set but does not decode to 32 bytes. Caught
 *     here rather than on the first outbound message, where it would surface
 *     as a customer-visible send failure hours after the deploy.
 *
 *  2. No key is set in production. Production is expected to carry one, and
 *     booting without it would quietly write new credentials in the clear.
 *
 *  3. No key is set and channels already hold encrypted values. Every send,
 *     every webhook signature check and every template sync on those channels
 *     would fail. This is the shape a bad rollback takes (new data, old
 *     environment), and a crash-loop with this message is far easier to
 *     diagnose than a channel that has silently gone deaf.
 *
 * Outside production, no key and nothing encrypted boots with a warning and
 * keeps the pre-encryption behaviour (plaintext in, plaintext out). That is
 * what lets a developer, a test run and a fresh clone work without handing
 * every machine a production-shaped secret.
 */
@Injectable()
export class ChannelSecretsBootCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChannelSecretsBootCheck.name)

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.verify()
  }

  async verify(): Promise<void> {
    if (secretsKeyConfigured()) {
      // Throws a SecretCryptoError naming the length problem and the command
      // that generates a good key. Never prints the value.
      loadSecretsKey()
      this.logger.log('channel secrets: encryption key loaded')
      return
    }

    if (process.env.NODE_ENV === 'production') {
      throw new SecretCryptoError(
        `${SECRETS_KEY_ENV} is not set. Generate 32 random bytes in base64 with "openssl rand -base64 32" (a 44-character value), put it in the API environment, and recreate the container.`,
      )
    }

    const inboxes = await this.prisma.inbox.findMany({
      where: { channelType: 'WHATSAPP' },
      select: { id: true, channelConfig: true },
    })
    const encrypted = inboxes.filter((inbox) =>
      hasEncryptedSecret(
        this.configObject(inbox.channelConfig),
        WHATSAPP_STORED_SECRET_FIELDS,
      ),
    )
    if (encrypted.length > 0) {
      throw new SecretCryptoError(
        `${encrypted.length} WhatsApp channel(s) hold encrypted credentials but ${SECRETS_KEY_ENV} is not set. Set the key, or roll the values back to plaintext with: node dist/scripts/channel-secrets.js --decrypt`,
      )
    }
    this.logger.warn(
      `channel secrets: ${SECRETS_KEY_ENV} is not set, so WhatsApp credentials stay in plaintext. Generate a key with "openssl rand -base64 32" and run: node dist/scripts/channel-secrets.js`,
    )
  }

  private configObject(raw: unknown): Record<string, unknown> {
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  }
}
