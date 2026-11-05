import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

// Minimal transactional mailer over the Resend HTTP API (no SDK dependency).
// When RESEND_API_KEY is unset (local dev, tests, stubs) sends are logged and
// skipped so flows depending on email still complete.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name)

  constructor(private readonly config: ConfigService) {}

  private apiKey(): string | null {
    const key = this.config.get<string>('RESEND_API_KEY')
    return key && key.length > 0 ? key : null
  }

  private from(): string {
    // Each install sends from its own verified domain; the fallback only keeps
    // local dev working and is refused by any real provider.
    return this.config.get<string>('EMAIL_FROM')?.trim() || 'Cosmika <no-reply@example.com>'
  }

  /** Returns true when the message was handed to the provider. */
  async send(to: string, subject: string, text: string): Promise<boolean> {
    const key = this.apiKey()
    if (!key) {
      this.logger.warn(`email skipped (no RESEND_API_KEY): to=${to} subject="${subject}"`)
      return false
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: this.from(), to: [to], subject, text }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      this.logger.error(`email send failed (${res.status}) for ${to}: ${body.slice(0, 200)}`)
      return false
    }
    return true
  }
}
