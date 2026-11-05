'use client'

import { MessageSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'

export default function ConversationsEmptyState() {
  const t = useTranslations()
  return (
    <div className="flex flex-1 items-center justify-center bg-chat-canvas">
      <div className="max-w-xs space-y-3 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <MessageSquare className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium">{t('conversations.title')}</p>
        <p className="text-xs text-muted-foreground">
          {t('conversations.subtitle')}
        </p>
      </div>
    </div>
  )
}
