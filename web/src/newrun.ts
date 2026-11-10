/**
 * Each deploy replaces the forecast run on the server, so a page left open ends up
 * pointing at files that no longer exist. This notices a newer run and moves onto it.
 */
import { fetchLatest } from './data'
import { flushState } from './state'
import { notify } from './ui'

const POLL_MS = 10 * 60_000
const MIN_GAP_MS = 60_000

/** Reload onto the latest run, keeping layer and location but not the old run's time step. */
function reloadOntoLatest(): void {
  flushState() // the URL may be up to 150 ms behind the latest layer or location choice
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  params.delete('t')
  history.replaceState(null, '', `#${params.toString()}`)
  location.reload()
}

export function watchForNewRun(root: string, currentRunId: string) {
  let lastCheck = 0

  /** `reloadIfNewer` is for load failures: the old files are gone, so asking first is pointless. */
  async function check(opts: { reloadIfNewer?: boolean } = {}): Promise<void> {
    if (!opts.reloadIfNewer && Date.now() - lastCheck < MIN_GAP_MS) return
    lastCheck = Date.now()
    try {
      const latest = await fetchLatest(root)
      if (latest.run_id === currentRunId) return
      if (opts.reloadIfNewer) reloadOntoLatest()
      else notify('A newer forecast run is available.', { label: 'Load it', onClick: reloadOntoLatest }, { sticky: true })
    } catch {
      /* offline or mid-deploy; the next check will try again */
    }
  }

  window.setInterval(() => void check(), POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  return { check }
}
