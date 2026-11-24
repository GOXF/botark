/** GOXF: the bot shown by a popped-out session window (`?popout=<botId>`), else null. */
export const popoutBotId: string | null =
  typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('popout')

// A popped window mirrors the main window's store; only the main window may write persisted state.
if (popoutBotId && typeof Storage !== 'undefined') {
  const { setItem, removeItem } = Storage.prototype
  Storage.prototype.setItem = function (key: string, value: string) {
    if (this !== window.localStorage) setItem.call(this, key, value)
  }
  Storage.prototype.removeItem = function (key: string) {
    if (this !== window.localStorage) removeItem.call(this, key)
  }
}
