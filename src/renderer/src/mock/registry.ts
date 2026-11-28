import type { ComponentType } from 'react'
import { V17TrayMock } from './mocks/v17-tray'
import { V19StatusDotMock } from './mocks/v19-status-dot'
import { V20ProxySubMock } from './mocks/v20-proxy-sub'
import { V21BoardDragMock } from './mocks/v21-board-drag'
import { V20ProxySubRealMock } from './mocks/v20-proxy-sub-real'
import { V21BoardDragRealMock } from './mocks/v21-board-drag-real'
import { V22RoomAdminMock } from './mocks/v22-room-admin'
import { V22GroupDragMock } from './mocks/v22-group-drag'
import { V23RoomCapMock } from './mocks/v23-room-cap'

/** Mock name (the ?mock= value and PNG file name) → component. */
export const MOCKS: Record<string, ComponentType> = {
  'v17-tray': V17TrayMock,
  'v19-status-dot': V19StatusDotMock,
  'v20-proxy-sub': V20ProxySubMock,
  'v21-board-drag': V21BoardDragMock,
  'v20-proxy-sub-real': V20ProxySubRealMock,
  'v21-board-drag-real': V21BoardDragRealMock,
  'v22-room-admin': V22RoomAdminMock,
  'v22-group-drag': V22GroupDragMock,
  'v23-room-cap': V23RoomCapMock
}
