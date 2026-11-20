/**
 * dsh-npm-update-notifier — Client half.
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
  id: 'dsh-npm-update-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-npm-update-notifier'
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
      'row.checkingStatus': 'Checking npm for updates…',
      'row.missingInstall': "Couldn't locate the installed DSH package.",
      'row.error': 'Update check failed.',
      'row.checked': 'Checked {when}',
      'row.checking': 'Checking…',
      'row.checkNow': 'Check now',
      'row.source.npm': 'installed with npm',
      'row.source.pnpm': 'installed with pnpm',
      'row.source.yarn': 'installed with yarn',
      'row.source.unknown': 'install method unknown',
      'status.upToDate': 'Up to date',
      'status.updateAvailable': 'Update available',
      'status.ahead': 'Local build',
      'error.timeout': 'The npm registry did not answer in time.',
      'error.http': 'The npm registry answered HTTP {status}.',
      'error.network': 'Could not reach the npm registry.',
      'error.registry': 'The npm registry returned an unexpected response.',
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

    function toTimestamp(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined
      const timestamp = Date.parse(iso)
      return Number.isNaN(timestamp) ? undefined : timestamp
    }

    /** "Nov 18, 2026" for a published ISO timestamp, or undefined. */
    function formatPublished(iso, locale) {
      const timestamp = toTimestamp(iso)
      if (timestamp === undefined) return undefined
      try {
        return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(timestamp))
      } catch {
        return undefined
      }
    }

    /** "2 days ago" for any ISO timestamp, or undefined. */
    function formatRelative(iso, locale) {
      const timestamp = toTimestamp(iso)
      if (timestamp === undefined) return undefined
      const seconds = Math.round((timestamp - Date.now()) / 1000)
      const magnitude = Math.abs(seconds)
      const [value, unit] =
        magnitude < 60
          ? [seconds, 'second']
          : magnitude < 60 * 60
            ? [seconds / 60, 'minute']
            : magnitude < 24 * 60 * 60
              ? [seconds / (60 * 60), 'hour']
              : magnitude < 30 * 24 * 60 * 60
                ? [seconds / (24 * 60 * 60), 'day']
                : magnitude < 365 * 24 * 60 * 60
                  ? [seconds / (30 * 24 * 60 * 60), 'month']
                  : [seconds / (365 * 24 * 60 * 60), 'year']
      try {
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(value), unit)
      } catch {
        return undefined
      }
    }

    /** "Nov 18, 2026, 8:17 PM" for a tooltip, or undefined. */
    function formatDateTime(iso, locale) {
      const timestamp = toTimestamp(iso)
      if (timestamp === undefined) return undefined
      try {
        return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))
      } catch {
        return undefined
      }
    }

    /** Turn a Host error string into short user copy plus the raw detail. */
    function describeError(error, t) {
      if (typeof error !== 'string' || error.length === 0) return undefined
      if (error.startsWith('Could not find ')) return { message: t('row.missingInstall'), detail: error }
      if (/did not answer within/.test(error)) return { message: t('error.timeout'), detail: error }
      const http = /HTTP (\d{3})/.exec(error)
      if (http !== null) return { message: t('error.http', { status: http[1] }), detail: error }
      if (/registry response|dist-tag|valid version|JSON|unexpected/i.test(error)) {
        return { message: t('error.registry'), detail: error }
      }
      return { message: t('error.network'), detail: error }
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

    function useLocale(ctx) {
      const [snapshot, setSnapshot] = React.useState(() => ctx.locale.getSnapshot())
      React.useEffect(() => ctx.locale.subscribe(() => setSnapshot(ctx.locale.getSnapshot())), [ctx])
      return snapshot.active
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

    function UpdatesRow({ store, t, locale }) {
      const state = useStatus(store)
      const payload = state.payload
      const installed = payload?.installed
      const latest = payload?.latest
      const busy = state.phase === 'loading' || state.phase === 'refreshing'
      const error = state.error ?? (typeof payload?.error === 'string' ? payload.error : undefined)
      const updateAvailable = payload?.updateAvailable === true && latest !== undefined
      const installedPublished = formatPublished(installed?.publishedAt, locale)
      const latestPublished = formatPublished(latest?.publishedAt, locale)
      const checked = formatRelative(payload?.checkedAt, locale)
      const checkedTitle = formatDateTime(payload?.checkedAt, locale)
      const source = installed?.installKind
      const sourceLabel =
        source === 'npm'
          ? t('row.source.npm')
          : source === 'pnpm'
            ? t('row.source.pnpm')
            : source === 'yarn'
              ? t('row.source.yarn')
              : t('row.source.unknown')
      const installMissing = payload !== undefined && installed?.version === undefined
      const errorView = error !== undefined && !installMissing ? describeError(error, t) : undefined

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
            : installMissing
              ? h('div', { className: 'dsh-nmu-row-description' }, t('row.missingInstall'))
              : error === undefined
                ? h('div', { className: 'dsh-nmu-row-description' }, t('row.checkingStatus'))
                : null,
          latest !== undefined && payload?.relation !== 'current'
            ? h(
                'div',
                { className: 'dsh-nmu-row-description' },
                latestPublished === undefined
                  ? t('row.latestNoDate', { version: latest.version })
                  : t('row.latest', { version: latest.version, published: latestPublished }),
              )
            : null,
          errorView !== undefined
            ? h('div', { className: 'dsh-nmu-row-error', role: 'alert', title: errorView.detail }, errorView.message)
            : null,
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
                { className: 'dsh-nmu-row-meta', title: checkedTitle },
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

    function UpdateNotice({ store, t, locale }) {
      const state = useStatus(store)
      const payload = state.payload
      const latest = payload?.latest
      const installed = payload?.installed
      const [dismissedFor, setDismissedFor] = React.useState(readDismissedVersion)

      const visible =
        payload?.updateAvailable === true && latest !== undefined && installed?.version !== undefined && dismissedFor !== latest.version
      const published = visible ? formatRelative(latest.publishedAt, locale) : undefined
      const publishedTitle = visible ? formatPublished(latest.publishedAt, locale) : undefined
      const body = !visible
        ? ''
        : published === undefined
          ? t('notice.bodyNoDate', { latest: latest.version, installed: installed.version })
          : t('notice.body', { latest: latest.version, installed: installed.version, published })

      const dismiss = () => {
        if (!visible) return
        writeDismissedVersion(latest.version)
        setDismissedFor(latest.version)
      }

      return h(
        React.Fragment,
        null,
        // Persistent live region: keeps the announcement node mounted so a
        // later update is announced instead of appearing silently.
        h('div', { className: 'dsh-nmu-sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, body),
        visible
          ? h(
              'div',
              { className: 'dsh-nmu-notice' },
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
              h('p', { className: 'dsh-nmu-notice-body', title: publishedTitle }, body),
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
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Styles (theme tokens only, so light and dark both work)
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-nmu-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
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
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  padding: 2px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-nmu-pill {
  font-size: 12px;
  line-height: 18px;
  padding: 1px 8px;
  border-radius: var(--dsw-radius-sm);
  white-space: nowrap;
  border: 1px solid transparent;
}
.dsh-nmu-pill-update {
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 10%, transparent);
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  box-sizing: border-box;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  padding: 0 10px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-nmu-button:hover:not(:disabled) { background: var(--dsw-alias-bg-base); }
.dsh-nmu-button:disabled { cursor: default; opacity: .6; }
.dsh-nmu-button-small { min-height: 26px; padding: 0 8px; }
.dsh-nmu-button:focus-visible,
.dsh-nmu-notice-button:focus-visible,
.dsh-nmu-notice-close:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));
  outline-offset: 2px;
}
.dsh-nmu-notice {
  position: fixed;
  top: var(--dsh-frame-overlay-top, 12px);
  right: 12px;
  width: min(380px, calc(100vw - 24px));
  box-sizing: border-box;
  padding: 12px 16px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  box-shadow: var(--dsw-shadow-lv3);
  font-size: 14px;
  line-height: 22px;
}
.dsh-nmu-notice-head { display: flex; align-items: center; gap: 8px; }
.dsh-nmu-notice-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-nmu-notice-title { font-weight: 600; flex: 1 1 auto; min-width: 0; }
.dsh-nmu-notice-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px -6px -4px 0;
  flex: none;
  font: inherit;
  font-size: 18px;
  line-height: 1;
  color: inherit;
  background: none;
  border: none;
  border-radius: var(--dsw-radius-sm);
  padding: 0;
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
.dsh-nmu-notice-command-label { opacity: .7; font-size: 12px; line-height: 18px; }
.dsh-nmu-notice-command-text {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-nmu-notice-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  box-sizing: border-box;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-toast-label);
  background: none;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-toast-label) 30%, transparent);
  border-radius: var(--dsw-radius-sm);
  padding: 0 10px;
  cursor: pointer;
}
.dsh-nmu-notice-button:hover { background: color-mix(in srgb, var(--dsw-alias-toast-label) 10%, transparent); }
.dsh-nmu-notice-button-primary { color: var(--dsw-alias-toast-action); border-color: var(--dsw-alias-toast-action); }
`

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.dshNmu = 'dsh-npm-update-notifier/styles'
      tag.textContent = CSS
      document.head.append(tag)
      return () => tag.remove()
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const store = createStatusStore()
        const t = ctx.locale.bind(NS)

        ctx.effect(() => installStyles(), 'dsh-npm-update-notifier: styles')
        ctx.effect(() => ctx.locale.register(NS, { en }), 'dsh-npm-update-notifier: dictionaries')
        ctx.effect(() => () => store.dispose(), 'dsh-npm-update-notifier: status store')

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register({ name: 'settings.general.item', id: NS, order: 35 }, () => {
            const locale = useLocale(ctx)
            return h(UpdatesRow, { store, t, locale })
          }),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: `${NS}-notice` }, () => {
            const locale = useLocale(ctx)
            return h(UpdateNotice, { store, t, locale })
          }),
        )

        void store.load(false)
        ctx.effect(() => {
          const timer = window.setInterval(() => {
            void store.load(false)
          }, POLL_INTERVAL_MS)
          return () => window.clearInterval(timer)
        }, 'dsh-npm-update-notifier: poll timer')
      },
    }
  },
})
