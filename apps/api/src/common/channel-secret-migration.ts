import { WHATSAPP_STORED_SECRET_FIELDS } from '@cosmika/shared'

import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  loadSecretsKey,
} from './secret-crypto'

/**
 * Data migration for channel secrets, both directions.
 *
 * FORWARD (`encrypt`) converts values that are still plaintext. Running it
 * twice is a no-op: an already-wrapped value is counted as `alreadyDone` and
 * its row is not touched, so the job is safe to re-run after a partial
 * failure and safe to leave in a deploy runbook.
 *
 * REVERSE (`decrypt`) puts the values back in the clear. This exists so a
 * rollback stays a rollback. Once a value is encrypted the previous release
 * cannot read it, which would turn "redeploy the old image" into "restore a
 * database backup". With the reverse mode the rollback is: deploy the old
 * image, run this with `--decrypt`, and the old code finds exactly the rows
 * it wrote before.
 *
 * Both directions need the key: forward to write, reverse to read.
 *
 * A channel that fails on its own (a value encrypted under a different key,
 * say) is recorded in `failures` and the run continues. Aborting on the first
 * bad row during a rollback would leave the rest of the account unreadable by
 * the old code, which is the exact thing this is here to prevent.
 */

export type SecretMigrationMode = 'encrypt' | 'decrypt'

export type SecretMigrationOptions = {
  mode: SecretMigrationMode
  /** Report what would change and write nothing. */
  dryRun: boolean
  /** Restrict the run to one channel. */
  inboxId?: string
}

export type ChannelSecretReport = {
  inboxId: string
  name: string
  /** Names of the fields converted (or that a dry run would convert). */
  fields: string[]
  /** Fields already in the target form, left untouched. */
  alreadyDone: number
}

export type ChannelSecretFailure = {
  inboxId: string
  name: string
  /** A SecretCryptoError message. Never carries a value. */
  reason: string
}

export type SecretMigrationSummary = {
  mode: SecretMigrationMode
  dryRun: boolean
  inboxesScanned: number
  /** Channels with at least one field to convert. */
  inboxesChanged: number
  valuesChanged: number
  valuesAlreadyDone: number
  changes: ChannelSecretReport[]
  failures: ChannelSecretFailure[]
}

/** The slice of Prisma this needs, so the migration is unit-testable. */
export type SecretMigrationPrisma = {
  inbox: {
    findMany: (args: unknown) => Promise<
      Array<{ id: string; name: string; channelConfig: unknown }>
    >
    update: (args: unknown) => Promise<unknown>
  }
}

function configObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

export async function migrateChannelSecrets(
  prisma: SecretMigrationPrisma,
  options: SecretMigrationOptions,
): Promise<SecretMigrationSummary> {
  // Fail before touching a single row if the key is missing or malformed.
  loadSecretsKey()

  const inboxes = await prisma.inbox.findMany({
    where: {
      channelType: 'WHATSAPP',
      ...(options.inboxId ? { id: options.inboxId } : {}),
    },
    select: { id: true, name: true, channelConfig: true },
    orderBy: { createdAt: 'asc' },
  })

  const summary: SecretMigrationSummary = {
    mode: options.mode,
    dryRun: options.dryRun,
    inboxesScanned: inboxes.length,
    inboxesChanged: 0,
    valuesChanged: 0,
    valuesAlreadyDone: 0,
    changes: [],
    failures: [],
  }

  for (const inbox of inboxes) {
    const current = configObject(inbox.channelConfig)
    const next: Record<string, unknown> = { ...current }
    const fields: string[] = []
    let alreadyDone = 0
    let failed: string | null = null

    for (const field of WHATSAPP_STORED_SECRET_FIELDS) {
      const value = current[field]
      if (typeof value !== 'string' || value === '') continue
      const wrapped = isEncryptedSecret(value)
      const wanted = options.mode === 'encrypt'
      if (wrapped === wanted) {
        alreadyDone += 1
        continue
      }
      try {
        next[field] = wanted ? encryptSecret(value) : decryptSecret(value)
      } catch (err) {
        // encryptSecret / decryptSecret throw SecretCryptoError and nothing
        // else, and its message is written to be safe to print: it names the
        // key problem, never a value.
        failed = (err as SecretCryptoError).message
        break
      }
      fields.push(field)
    }

    summary.valuesAlreadyDone += alreadyDone

    if (failed) {
      summary.failures.push({
        inboxId: inbox.id,
        name: inbox.name,
        reason: failed,
      })
      continue
    }
    if (fields.length === 0) continue

    summary.inboxesChanged += 1
    summary.valuesChanged += fields.length
    summary.changes.push({
      inboxId: inbox.id,
      name: inbox.name,
      fields,
      alreadyDone,
    })

    if (options.dryRun) continue

    try {
      await prisma.inbox.update({
        where: { id: inbox.id },
        data: { channelConfig: next },
      })
    } catch (err) {
      // A Prisma error message can echo the query arguments, which here are
      // the secrets. Record the error class only.
      summary.inboxesChanged -= 1
      summary.valuesChanged -= fields.length
      summary.changes.pop()
      summary.failures.push({
        inboxId: inbox.id,
        name: inbox.name,
        reason: `write failed (${err instanceof Error ? err.name : 'unknown error'})`,
      })
    }
  }

  return summary
}

/** Human-readable summary for the CLI. Names channels, never values. */
export function formatSecretMigrationSummary(
  summary: SecretMigrationSummary,
): string {
  const verb = summary.mode === 'encrypt' ? 'encrypt' : 'decrypt'
  const lines: string[] = []
  lines.push(
    `mode: ${verb}${summary.dryRun ? ' (dry run, nothing was written)' : ''}`,
  )
  for (const change of summary.changes) {
    lines.push(
      `  ${summary.dryRun ? 'would convert' : 'converted'} ${change.fields.length} value(s) on "${change.name}" (${change.inboxId}): ${change.fields.join(', ')}`,
    )
  }
  for (const failure of summary.failures) {
    lines.push(
      `  FAILED "${failure.name}" (${failure.inboxId}): ${failure.reason}`,
    )
  }
  lines.push(
    `WhatsApp channels scanned: ${summary.inboxesScanned} | channels ${summary.dryRun ? 'to change' : 'changed'}: ${summary.inboxesChanged} | values ${summary.dryRun ? 'to convert' : 'converted'}: ${summary.valuesChanged} | already ${verb}ed: ${summary.valuesAlreadyDone} | failures: ${summary.failures.length}`,
  )
  return lines.join('\n')
}
