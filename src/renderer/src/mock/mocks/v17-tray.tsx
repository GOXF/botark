import { useState, type ReactNode } from 'react'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useT } from '@/lib/i18n'

/**
 * v17 托盘：设置「常规与安全」第一张卡片，新增「点关闭按钮时」一行。
 * Row markup copies GeneralSettingsSection (settings row pattern).
 */
export function V17TrayMock() {
  const tr = useT()
  const [theme, setTheme] = useState('system')
  const [locale, setLocale] = useState('zh')
  const [close, setClose] = useState('tray')
  const [start, setStart] = useState('board')

  return (
    <div className="flex w-[780px] flex-col gap-5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('General & Security')}</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          {tr('Adjust the appearance, manage sidebar groups, and clear local credentials.')}
        </p>
      </div>

      <div className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-soft">
        <Row title={tr('Appearance')} description={tr('Grok Bot Sand Light and Sand Dark themes')}>
          <SegmentedControl
            size="sm"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: 'system', label: tr('Match system') },
              { value: 'light', label: tr('Light') },
              { value: 'dark', label: tr('Dark') }
            ]}
          />
        </Row>
        <Row title={tr('Language')} description={tr('Choose the display language')}>
          <SegmentedControl
            size="sm"
            value={locale}
            onValueChange={setLocale}
            options={[
              { value: 'zh', label: '简体中文' },
              { value: 'en', label: 'English' }
            ]}
          />
        </Row>
        <Row
          title={
            <>
              点关闭按钮时
              <span className="ml-2 inline-flex h-5 items-center rounded-full bg-accent-50 px-2 align-[1px] text-[11px] font-medium text-accent-700 dark:text-accent-400">
                新
              </span>
            </>
          }
          description="Windows/Linux 生效；Mac 一直是隐藏窗口"
        >
          <SegmentedControl
            size="sm"
            value={close}
            onValueChange={setClose}
            options={[
              { value: 'tray', label: '最小化到托盘' },
              { value: 'quit', label: '直接退出' }
            ]}
          />
        </Row>
        <Row title="启动时打开" description="打开 BotArk 时先看哪一页">
          <SegmentedControl
            size="sm"
            value={start}
            onValueChange={setStart}
            options={[
              { value: 'board', label: '任务' },
              { value: 'sessions', label: '会话' },
              { value: 'collab', label: '协作' },
              { value: 'last', label: '上次的页面' }
            ]}
          />
        </Row>
      </div>

      <p className="px-1 text-[12px] leading-5 text-ink-muted">
        托盘菜单是系统原生菜单，这里画不出来。Windows 上右键托盘图标会弹出两项：「打开 BotArk」「退出 BotArk」。
      </p>
    </div>
  )
}

function Row({ title, description, children }: { title: ReactNode; description: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <p className="text-[12px] text-ink-muted">{description}</p>
      </div>
      {children}
    </div>
  )
}
