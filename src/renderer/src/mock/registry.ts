import type { ComponentType } from 'react'
import { V17TrayMock } from './mocks/v17-tray'
import { V19StatusDotMock } from './mocks/v19-status-dot'
import { V20ProxySubMock } from './mocks/v20-proxy-sub'

/** Mock name (the ?mock= value and PNG file name) → component. */
export const MOCKS: Record<string, ComponentType> = {
  'v17-tray': V17TrayMock,
  'v19-status-dot': V19StatusDotMock,
  'v20-proxy-sub': V20ProxySubMock
}
