import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

/**
 * Electron's patched `fs` treats any `*.asar` file as a folder, so hashing, copying or deleting a staged
 * `resources/app.asar` hangs or fails. `original-fs` is the unpatched one; plain Node (tests) has no such
 * module and its `fs` is already unpatched.
 */
function load(): typeof nodeFs {
  try {
    return createRequire(import.meta.url)('original-fs') as typeof nodeFs
  } catch {
    return nodeFs
  }
}

export const fs: typeof nodeFs = load()
