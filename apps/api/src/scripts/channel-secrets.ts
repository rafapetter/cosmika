/* eslint-disable no-console */
import { prisma } from '@cosmika/db'

import {
  formatSecretMigrationSummary,
  migrateChannelSecrets,
  type SecretMigrationPrisma,
} from '../common/channel-secret-migration'
import { SECRETS_KEY_ENV, SecretCryptoError } from '../common/secret-crypto'

/**
 * CLI for the channel-secret data migration.
 *
 * It lives under `src/` (not a top-level `scripts/` folder) on purpose: the
 * production image is built with `pnpm install --prod`, so no `tsx` and no
 * TypeScript are available there, and only `apps/api/dist` is copied in.
 * Being part of the Nest build means it ships as plain compiled JS next to
 * the server and runs with the container's own `node`:
 *
 *   # forward, after the new code is live
 *   docker exec -w /workspace/apps/api <api> node dist/scripts/channel-secrets.js --dry-run
 *   docker exec -w /workspace/apps/api <api> node dist/scripts/channel-secrets.js
 *
 *   # reverse, as part of a rollback to the previous image
 *   docker exec -w /workspace/apps/api <api> node dist/scripts/channel-secrets.js --decrypt
 *
 * Locally (TypeScript available):
 *   pnpm --filter @cosmika/api exec tsx src/scripts/channel-secrets.ts --dry-run
 *
 * Exit code is 1 when any channel failed, so a deploy step can gate on it.
 */

type Parsed = {
  mode: 'encrypt' | 'decrypt'
  dryRun: boolean
  inboxId?: string
  help: boolean
  unknown: string[]
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    mode: 'encrypt',
    dryRun: false,
    help: false,
    unknown: [],
  }
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') parsed.dryRun = true
    else if (arg === '--decrypt') parsed.mode = 'decrypt'
    else if (arg === '--encrypt') parsed.mode = 'encrypt'
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg.startsWith('--inbox=')) parsed.inboxId = arg.slice(8)
    else parsed.unknown.push(arg)
  }
  return parsed
}

const USAGE = `Usage: node dist/scripts/channel-secrets.js [options]

Converts the stored WhatsApp credentials of every channel between plaintext
and encrypted-at-rest. Safe to run twice: values already in the target form
are skipped, not rewritten.

Options:
  -n, --dry-run     report what would change, write nothing
      --encrypt     plaintext -> encrypted (default)
      --decrypt     encrypted -> plaintext (use when rolling back)
      --inbox=<id>  restrict the run to one channel
  -h, --help        this text

Requires ${SECRETS_KEY_ENV} (32 random bytes, base64: openssl rand -base64 32).`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (args.unknown.length > 0) {
    console.error(`unknown argument(s): ${args.unknown.join(', ')}\n`)
    console.error(USAGE)
    return 2
  }

  // PrismaClient's generated methods are generic over their argument type,
  // which does not structurally match the narrow slice the migration asks
  // for. The shapes it actually passes are valid Prisma arguments; see
  // SecretMigrationPrisma.
  const summary = await migrateChannelSecrets(prisma as unknown as SecretMigrationPrisma, {
    mode: args.mode,
    dryRun: args.dryRun,
    inboxId: args.inboxId,
  })
  console.log(formatSecretMigrationSummary(summary))
  return summary.failures.length > 0 ? 1 : 0
}

main()
  .then(async (code) => {
    await prisma.$disconnect()
    process.exit(code)
  })
  .catch(async (err: unknown) => {
    // A SecretCryptoError message is written to be safe to print: it names
    // the key problem, never a value.
    console.error(
      err instanceof SecretCryptoError
        ? `channel-secrets: ${err.message}`
        : `channel-secrets failed: ${err instanceof Error ? err.name : 'unknown error'}`,
    )
    await prisma.$disconnect()
    process.exit(1)
  })
