'use client'

import { usePathname } from 'next/navigation'

import { ConversationListPane } from './_list-pane'

export default function ConversationsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? ''
  // On narrow screens we switch between list and detail. /conversations[?…]
  // shows the list; /conversations/<id> shows the detail (and hides the list).
  const onDetail = /\/conversations\/[^/]+/.test(pathname)
  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className={onDetail ? 'hidden md:flex' : 'flex'}>
        <ConversationListPane />
      </div>
      <div
        className={`min-w-0 flex-1 overflow-hidden ${
          onDetail ? 'flex' : 'hidden md:flex'
        }`}
      >
        {children}
      </div>
    </div>
  )
}
