import { SettingsNav } from '../../components/settings-nav'

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col">
      <SettingsNav />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
