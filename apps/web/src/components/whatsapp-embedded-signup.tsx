'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import type { EmbeddedSignupConfigDTO, InboxDTO } from '@cosmika/shared'
import { Button } from '@cosmika/ui'

import { ApiError, api } from '../lib/api'
import { apiErrorText } from '../lib/api-error'
import {
  createSignupSession,
  embeddedSignupLoginOptions,
  loadFacebookSdk,
  parseEmbeddedSignupMessage,
  type SignupReady,
} from '../lib/embedded-signup'

/**
 * Meta normally sends the finish message before the login callback. If the
 * code arrives and the ids do not follow within this window, the code is
 * about to expire anyway, so the screen says so instead of spinning forever.
 */
export const FINISH_MESSAGE_WAIT_MS = 20_000

type Phase = 'idle' | 'opening' | 'finishing'

/**
 * "Conectar WhatsApp": Embedded Signup with CosmoBots as the Tech Provider.
 * Renders nothing unless the API says the feature is on, so the new channel
 * screen looks exactly as before while the flag is off.
 */
export function WhatsappEmbeddedSignup({
  token,
  accountId,
  name,
  onConnected,
}: {
  token: string
  accountId: string
  /** The channel name typed on the page, if any. */
  name?: string
  onConnected: (inbox: InboxDTO) => void
}) {
  const t = useTranslations()
  const [config, setConfig] = useState<EmbeddedSignupConfigDTO | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    let alive = true
    api
      .getEmbeddedSignupConfig(token, accountId)
      .then((c) => alive && setConfig(c))
      .catch(() => alive && setConfig({ enabled: false }))
    return () => {
      alive = false
      cleanup.current?.()
    }
  }, [token, accountId])

  if (!config?.enabled || !config.appId || !config.configId || !config.graphApiVersion) {
    return null
  }
  const { appId, configId, graphApiVersion } = config

  async function submit({ code, finish }: SignupReady) {
    if (!finish.phoneNumberId) {
      setPhase('idle')
      setNotice({ tone: 'error', text: t('errors.whatsapp_es_phone_required') })
      return
    }
    setPhase('finishing')
    try {
      const inbox = await api.completeEmbeddedSignup(token, accountId, {
        code,
        event: finish.event,
        wabaId: finish.wabaId,
        phoneNumberId: finish.phoneNumberId,
        ...(finish.businessId && { businessId: finish.businessId }),
        ...(name?.trim() && { name: name.trim() }),
      })
      onConnected(inbox)
    } catch (err) {
      setPhase('idle')
      setNotice({
        tone: 'error',
        text: err instanceof ApiError ? apiErrorText(t, err) : t('auth.generic_error'),
      })
    }
  }

  async function start() {
    setNotice(null)
    setPhase('opening')
    let FB
    try {
      FB = await loadFacebookSdk(appId, graphApiVersion)
    } catch {
      setPhase('idle')
      setNotice({ tone: 'error', text: t('inboxes.embedded_signup.error_sdk') })
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const finishUp = () => {
      window.removeEventListener('message', onMessage)
      if (timer) clearTimeout(timer)
      cleanup.current = null
    }
    const session = createSignupSession({
      ready: (r) => {
        finishUp()
        void submit(r)
      },
      stopped: (m) => {
        finishUp()
        setPhase('idle')
        if (m.kind === 'error') {
          // What Meta's support asks for. Never the customer's data.
          console.warn('[embedded-signup] error', {
            error_code: m.errorCode,
            session_id: m.sessionId,
          })
          setNotice({
            tone: 'error',
            text: t('inboxes.embedded_signup.error_meta', {
              code: m.errorCode ?? '-',
              session: m.sessionId ?? '-',
            }),
          })
        } else {
          if (m.kind === 'cancel') {
            console.info('[embedded-signup] cancelled', { current_step: m.currentStep })
          }
          setNotice({ tone: 'info', text: t('inboxes.embedded_signup.cancelled') })
        }
      },
    })
    function onMessage(event: MessageEvent) {
      const msg = parseEmbeddedSignupMessage(event.origin, event.data)
      if (msg) session.onMessage(msg)
    }
    window.addEventListener('message', onMessage)
    cleanup.current = finishUp

    FB.login((response) => {
      const code = response.authResponse?.code
      session.onLogin(code)
      if (code && cleanup.current) {
        timer = setTimeout(() => {
          finishUp()
          setPhase('idle')
          setNotice({ tone: 'error', text: t('inboxes.embedded_signup.error_timeout') })
        }, FINISH_MESSAGE_WAIT_MS)
      }
    }, embeddedSignupLoginOptions(configId))
  }

  const busy = phase !== 'idle'
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('inboxes.embedded_signup.title')}</p>
        <p className="text-xs text-muted-foreground">{t('inboxes.embedded_signup.hint')}</p>
      </div>
      <Button type="button" onClick={() => void start()} disabled={busy}>
        {phase === 'finishing'
          ? t('inboxes.embedded_signup.finishing')
          : phase === 'opening'
            ? t('inboxes.embedded_signup.opening')
            : t('inboxes.embedded_signup.connect')}
      </Button>
      {notice ? (
        <p
          className={notice.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('inboxes.embedded_signup.manual_below')}</p>
    </div>
  )
}
