/** Stop waiting promptly even when the underlying operation cannot be aborted. */
export async function abortable<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
  })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return start()
    })
    const value = await Promise.race([aborted, operation])
    signal.throwIfAborted()
    return value
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
