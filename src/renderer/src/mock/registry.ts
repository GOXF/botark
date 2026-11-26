import type { ComponentType } from 'react'
import { V17TrayMock } from './mocks/v17-tray'

/** Mock name (the ?mock= value and PNG file name) → component. */
export const MOCKS: Record<string, ComponentType> = {
  'v17-tray': V17TrayMock
}
