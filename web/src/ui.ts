/** A single transient message above the timeline, optionally with one action button. */

interface Action {
  label: string
  onClick(): void
}

let timer: number | undefined

export function notify(text: string, action?: Action, opts: { sticky?: boolean } = {}): void {
  const toast = document.getElementById('toast')!
  const button = document.getElementById('toast-action') as HTMLButtonElement
  document.getElementById('toast-text')!.textContent = text
  button.hidden = !action
  if (action) {
    button.textContent = action.label
    button.onclick = action.onClick
  }
  toast.hidden = false
  window.clearTimeout(timer)
  if (!opts.sticky) timer = window.setTimeout(() => (toast.hidden = true), 6000)
}
