/**
 * npm-update-notifier — Client half.
 *
 * Reads the Host half's status route and adds two things to the web UI:
 *
 * - a "DSH updates" row in Settings → General showing the installed version,
 *   the latest npm release, and when each was published;
 * - a dismissible notice in the frame overlay when a newer release exists.
 *
 * No Harness Client package is imported: React is the only runtime module and
 * every control is local to this file.
 */
window.__ModuleLoader__.load({
  id: 'npm-update-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'npm-update-notifier'
    const STATUS_ROUTE = '/dsh-npm-update-notifier/status'
    const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
    const RETRY_DELAY_MS = 60 * 1000
    const RETRY_LIMIT = 2
    const DISMISS_KEY = 'dsh-npm-update-notifier:dismissed'

    const en = {
      'row.title': 'DSH updates',
      'row.installed': 'Installed {version} · published {published}',
      'row.installedNoDate': 'Installed {version}',
      'row.latest': 'Latest on npm: {version} · published {published}',
      'row.latestNoDate': 'Latest on npm: {version}',
      'row.missingInstall': "Couldn't locate the installed DSH package.",
      'row.error': 'Update check failed: {message}',
      'row.checked': 'Checked {when}',
      'row.checking': 'Checking…',
      'row.checkNow': 'Check now',
      'row.source.npm': 'npm install',
      'row.source.pnpm': 'pnpm install',
      'row.source.yarn': 'yarn install',
      'row.source.unknown': 'custom install',
      'row.updateWith': 'Update with',
      'status.upToDate': 'Up to date',
      'status.updateAvailable': 'Update available',
      'status.ahead': 'Local build',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'notice.title': 'DSH update available',
      'notice.body': 'Version {latest} is on npm, published {published}. You are running {installed}.',
      'notice.bodyNoDate': 'Version {latest} is on npm. You are running {installed}.',
      'notice.commandLabel': 'Update with',
      'notice.copyCommand': 'Copy update command',
      'notice.dismiss': 'Dismiss',
    }

    // ---------------------------------------------------------------------
    // Formatting helpers
    // ---------------------------------------------------------------------

    const absoluteDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

    function toTimestamp(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined
      const timestamp = Date.parse(iso)
      return Number.isNaN(timestamp) ? undefined : timestamp
    }

    /** "Nov 18, 2026" for a published ISO timestamp, or undefined. */
    function formatPublished(iso) {
      const timestamp = toTimestamp(iso)
      return timestamp === undefined ? undefined : absoluteDate.format(new Date(timestamp))
    }

    /** "2 days ago" for any ISO timestamp, or undefined. */
    function formatRelative(iso) {
      const timestamp = toTimestamp(iso)
      if (timestamp === undefined) return undefined
      const seconds = Math.round((timestamp - Date.now()) / 1000)
      const magnitude = Math.abs(seconds)
      if (magnitude < 60) return relativeTime.format(Math.round(seconds), 'second')
      if (magnitude < 60 * 60) return relativeTime.format(Math.round(seconds / 60), 'minute')
      if (magnitude < 24 * 60 * 60) return relativeTime.format(Math.round(seconds / (60 * 60)), 'hour')
      if (magnitude < 30 * 24 * 60 * 60) return relativeTime.format(Math.round(seconds / (24 * 60 * 60)), 'day')
      if (magnitude < 365 * 24 * 60 * 60) return relativeTime.format(Math.round(seconds / (30 * 24 * 60 * 60)), 'month')
      return relativeTime.format(Math.round(seconds / (365 * 24 * 60 * 60)), 'year')
    }

    function readDismissedVersion() {
      try {
        return window.localStorage.getItem(DISMISS_KEY) ?? undefined
      } catch {
        return undefined
      }
    }

    function writeDismissedVersion(version) {
      try {
        window.localStorage.setItem(DISMISS_KEY, version)
      } catch {
        // Private browsing and disabled storage: the notice simply shows again.
      }
    }

    async function copyText(text) {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return
      }
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.append(textarea)
      textarea.select()
      try {
        if (document.execCommand('copy') !== true) throw new Error('copy command was rejected')
      } finally {
        textarea.remove()
      }
    }

    // ---------------------------------------------------------------------
    // Status store: one fetch shared by the settings row and the notice.
    // ---------------------------------------------------------------------

    function createStatusStore() {
      let state = { phase: 'idle', payload: undefined, error: undefined }
      const listeners = new Set()
      let inflight
      let retryTimer
      let retryCount = 0
      let disposed = false

      const publish = (next) => {
        state = next
        for (const listener of [...listeners]) listener()
      }

      const scheduleRetry = () => {
        if (disposed || retryCount >= RETRY_LIMIT) return
        retryCount += 1
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined
          void load(false)
        }, RETRY_DELAY_MS)
      }

      const load = (force = false) => {
        if (disposed) return Promise.resolve(state)
        if (inflight !== undefined) return inflight
        publish({ ...state, phase: state.payload === undefined ? 'loading' : 'refreshing' })
        inflight = fetch(STATUS_ROUTE + (force ? '?refresh=1' : ''), {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            retryCount = 0
            publish({
              phase: 'ready',
              payload,
              error: typeof payload.error === 'string' && payload.error.length > 0 ? payload.error : undefined,
            })
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            publish({ phase: 'error', payload: state.payload, error: message })
            scheduleRetry()
          })
          .finally(() => {
            inflight = undefined
          })
        return inflight
      }

      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        load,
        dispose() {
          disposed = true
          if (retryTimer !== undefined) window.clearTimeout(retryTimer)
        },
      }
    }

    function useStatus(store) {
      const [state, setState] = React.useState(store.get)
      React.useEffect(() => store.subscribe(() => setState(store.get())), [store])
      return state
    }

    // ---------------------------------------------------------------------
    // Small shared controls
    // ---------------------------------------------------------------------

    function StatusPill({ tone, label }) {
      return h('span', { className: `dsh-nmu-pill dsh-nmu-pill-${tone}` }, label)
    }

    function CopyButton({ text, label, copiedLabel, className }) {
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => {
        if (!copied) return undefined
        const timer = window.setTimeout(() => setCopied(false), 2000)
        return () => window.clearTimeout(timer)
      }, [copied])
      return h(
        'button',
        {
          type: 'button',
          className: className ?? 'dsh-nmu-button',
          onClick: () => {
            copyText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          },
        },
        copied ? copiedLabel : label,
      )
    }

    // ---------------------------------------------------------------------
    // Settings → General row
    // ---------------------------------------------------------------------

    function UpdatesRow({ store, t }) {
      const state = useStatus(store)
      const payload = state.payload
      const installed = payload?.installed
      const latest = payload?.latest
      const busy = state.phase === 'loading' || state.phase === 'refreshing'
      const error = state.error ?? (typeof payload?.error === 'string' ? payload.error : undefined)
      const updateAvailable = payload?.updateAvailable === true && latest !== undefined
      const installedPublished = formatPublished(installed?.publishedAt)
      const latestPublished = formatPublished(latest?.publishedAt)
      const checked = formatRelative(payload?.checkedAt)
      const source = installed?.installKind
      const sourceLabel =
        source === 'npm'
          ? t('row.source.npm')
          : source === 'pnpm'
            ? t('row.source.pnpm')
            : source === 'yarn'
              ? t('row.source.yarn')
              : t('row.source.unknown')

      const status =
        error !== undefined || payload === undefined
          ? null
          : payload.relation === 'behind'
            ? h(StatusPill, { tone: 'update', label: t('status.updateAvailable') })
            : payload.relation === 'current'
              ? h(StatusPill, { tone: 'current', label: t('status.upToDate') })
              : payload.relation === 'ahead'
                ? h(StatusPill, { tone: 'neutral', label: t('status.ahead') })
                : null

      return h(
        'div',
        { className: 'dsh-nmu-row', role: 'group', 'aria-label': t('row.title') },
        h(
          'div',
          { className: 'dsh-nmu-row-text' },
          h('div', { className: 'dsh-nmu-row-title' }, t('row.title')),
          installed?.version !== undefined
            ? h(
                'div',
                { className: 'dsh-nmu-row-description' },
                installedPublished === undefined
                  ? t('row.installedNoDate', { version: installed.version })
                  : t('row.installed', { version: installed.version, published: installedPublished }),
              )
            : h('div', { className: 'dsh-nmu-row-description' }, t('row.missingInstall')),
          latest !== undefined
            ? h(
                'div',
                { className: 'dsh-nmu-row-description' },
                latestPublished === undefined
                  ? t('row.latestNoDate', { version: latest.version })
                  : t('row.latest', { version: latest.version, published: latestPublished }),
              )
            : null,
          error !== undefined ? h('div', { className: 'dsh-nmu-row-error', role: 'alert' }, t('row.error', { message: error })) : null,
          updateAvailable && typeof payload?.upgradeCommand === 'string'
            ? h(
                'div',
                { className: 'dsh-nmu-command' },
                h('span', { className: 'dsh-nmu-command-label' }, t('row.updateWith')),
                h('code', { className: 'dsh-nmu-command-text' }, payload.upgradeCommand),
                h(CopyButton, {
                  text: payload.upgradeCommand,
                  label: t('action.copy'),
                  copiedLabel: t('action.copied'),
                  className: 'dsh-nmu-button dsh-nmu-button-small',
                }),
              )
            : null,
          checked !== undefined
            ? h(
                'div',
                { className: 'dsh-nmu-row-meta' },
                installed?.version === undefined
                  ? t('row.checked', { when: checked })
                  : `${t('row.checked', { when: checked })} · ${sourceLabel}`,
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-nmu-row-controls' },
          status,
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-nmu-button',
              disabled: busy,
              'aria-busy': busy,
              onClick: () => {
                void store.load(true)
              },
            },
            busy ? t('row.checking') : t('row.checkNow'),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Frame-overlay notice
    // ---------------------------------------------------------------------

    function UpdateNotice({ store, t }) {
      const state = useStatus(store)
      const payload = state.payload
      const latest = payload?.latest
      const installed = payload?.installed
      const [dismissedFor, setDismissedFor] = React.useState(readDismissedVersion)

      const visible =
        payload?.updateAvailable === true && latest !== undefined && installed?.version !== undefined && dismissedFor !== latest.version
      if (!visible) return null

      const dismiss = () => {
        writeDismissedVersion(latest.version)
        setDismissedFor(latest.version)
      }
      const published = formatRelative(latest.publishedAt)

      return h(
        'div',
        { className: 'dsh-nmu-notice', role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'dsh-nmu-notice-head' },
          h('span', { className: 'dsh-nmu-notice-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-nmu-notice-title' }, t('notice.title')),
          h(
            'button',
            { type: 'button', className: 'dsh-nmu-notice-close', 'aria-label': t('notice.dismiss'), onClick: dismiss },
            '×',
          ),
        ),
        h(
          'p',
          { className: 'dsh-nmu-notice-body' },
          published === undefined
            ? t('notice.bodyNoDate', { latest: latest.version, installed: installed.version })
            : t('notice.body', { latest: latest.version, installed: installed.version, published }),
        ),
        typeof payload.upgradeCommand === 'string'
          ? h(
              'div',
              { className: 'dsh-nmu-notice-command' },
              h('span', { className: 'dsh-nmu-notice-command-label' }, t('notice.commandLabel')),
              h('code', { className: 'dsh-nmu-notice-command-text' }, payload.upgradeCommand),
              h(CopyButton, {
                text: payload.upgradeCommand,
                label: t('notice.copyCommand'),
                copiedLabel: t('action.copied'),
                className: 'dsh-nmu-notice-button dsh-nmu-notice-button-primary',
              }),
            )
          : null,
        h(
          'div',
          { className: 'dsh-nmu-notice-actions' },
          h('button', { type: 'button', className: 'dsh-nmu-notice-button', onClick: dismiss }, t('notice.dismiss')),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Styles (theme tokens only, so light and dark both work)
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-nmu-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.dsh-nmu-row-text { min-width: 0; }
.dsh-nmu-row-title { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.dsh-nmu-row-description { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-nmu-row-meta { margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-nmu-row-error { margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dsh-nmu-row-controls { display: flex; align-items: center; gap: 8px; flex: none; }
.dsh-nmu-command { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-width: 0; }
.dsh-nmu-command-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-nmu-command-text {
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  padding: 2px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-nmu-pill {
  font-size: 12px;
  line-height: 18px;
  padding: 1px 8px;
  border-radius: 9px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.dsh-nmu-pill-update {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
}
.dsh-nmu-pill-current {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
}
.dsh-nmu-pill-neutral {
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l2);
}
.dsh-nmu-button {
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-nmu-button:hover:not(:disabled) { background: var(--dsw-alias-bg-base); }
.dsh-nmu-button:disabled { cursor: default; opacity: .6; }
.dsh-nmu-button-small { padding: 1px 8px; }
.dsh-nmu-button:focus-visible,
.dsh-nmu-notice-button:focus-visible,
.dsh-nmu-notice-close:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dsh-nmu-notice {
  position: fixed;
  top: 56px;
  right: 16px;
  z-index: 40;
  width: min(360px, calc(100vw - 32px));
  box-sizing: border-box;
  padding: 12px 14px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  font-size: 13px;
  line-height: 18px;
}
.dsh-nmu-notice-head { display: flex; align-items: center; gap: 8px; }
.dsh-nmu-notice-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-nmu-notice-title { font-weight: 600; flex: 1 1 auto; min-width: 0; }
.dsh-nmu-notice-close {
  font: inherit;
  font-size: 16px;
  line-height: 16px;
  color: inherit;
  background: none;
  border: none;
  border-radius: 4px;
  padding: 2px 4px;
  cursor: pointer;
  opacity: .75;
}
.dsh-nmu-notice-close:hover { opacity: 1; }
.dsh-nmu-notice-body { margin: 6px 0 0; opacity: .85; }
.dsh-nmu-notice-command {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--dsw-alias-toast-label) 18%, transparent);
}
.dsh-nmu-notice-command-label { opacity: .7; font-size: 12px; }
.dsh-nmu-notice-command-text {
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-nmu-notice-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.dsh-nmu-notice-button {
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-toast-label);
  background: none;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-toast-label) 30%, transparent);
  border-radius: 6px;
  padding: 2px 10px;
  cursor: pointer;
}
.dsh-nmu-notice-button:hover { background: color-mix(in srgb, var(--dsw-alias-toast-label) 10%, transparent); }
.dsh-nmu-notice-button-primary { color: var(--dsw-alias-toast-action); border-color: var(--dsw-alias-toast-action); }
`

    function installStyles() {
      const id = 'npm-update-notifier/styles'
      const existing = document.querySelector(`style[data-dsh-nmu="${id}"]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.dshNmu = id
      tag.textContent = CSS
      document.head.append(tag)
      return () => tag.remove()
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const store = createStatusStore()
        const t = ctx.locale.bind(NS)

        ctx.effect(() => installStyles(), 'npm-update-notifier: styles')
        ctx.effect(() => ctx.locale.register(NS, { en }), 'npm-update-notifier: dictionaries')
        ctx.effect(() => () => store.dispose(), 'npm-update-notifier: status store')

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            { name: 'settings.general.item', id: NS, order: 35 },
            () => h(UpdatesRow, { store, t }),
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: `${NS}-notice` },
            () => h(UpdateNotice, { store, t }),
          ),
        )

        void store.load(false)
        ctx.effect(() => {
          const timer = window.setInterval(() => {
            void store.load(false)
          }, POLL_INTERVAL_MS)
          return () => window.clearInterval(timer)
        }, 'npm-update-notifier: poll timer')
      },
    }
  },
})
