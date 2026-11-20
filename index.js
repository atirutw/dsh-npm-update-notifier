/**
 * dsh-npm-update-notifier — Host half.
 *
 * Figures out which `@deepseek-ai/dsh` installation is running, asks the npm
 * registry about the current `latest` dist-tag, and serves one small JSON
 * document for the Client half:
 *
 *   GET /dsh-npm-update-notifier/status[?refresh=1]
 *
 * The Client half renders that document in Settings → General and as a
 * dismissible update notice. Nothing is written anywhere; the only data that
 * leaves the machine is a plain GET to the configured registry.
 *
 * @module dsh-npm-update-notifier
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-npm-update-notifier'

/** The route the Client half polls. Keep in sync with `client.js`. */
export const STATUS_ROUTE = '/dsh-npm-update-notifier/status'

/** The registry package this plugin watches by default. */
const DEFAULT_PACKAGE_NAME = '@deepseek-ai/dsh'

const DEFAULT_OPTIONS = Object.freeze({
  packageName: DEFAULT_PACKAGE_NAME,
  registryUrl: 'https://registry.npmjs.org',
  checkIntervalMinutes: 60,
  timeoutMs: 10_000,
})

const PLUGIN_VERSION = readPluginVersion()

/** Read this package's own version without requiring JSON import attributes. */
function readPluginVersion() {
  try {
    const manifestUrl = new URL('./package.json', import.meta.url)
    const manifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Coerce the row `config` into the options this plugin actually understands. */
export function normalizeOptions(config) {
  const input = config !== null && typeof config === 'object' ? config : {}

  const packageName =
    typeof input.packageName === 'string' && input.packageName.trim().length > 0
      ? input.packageName.trim()
      : DEFAULT_OPTIONS.packageName

  let registryUrl = DEFAULT_OPTIONS.registryUrl
  if (typeof input.registryUrl === 'string' && input.registryUrl.trim().length > 0) {
    try {
      const parsed = new URL(input.registryUrl.trim())
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        registryUrl = parsed.toString().replace(/\/+$/, '')
      }
    } catch {
      // Keep the default; a malformed URL must not break the whole plugin.
    }
  }

  const checkIntervalMinutes = clampNumber(input.checkIntervalMinutes, DEFAULT_OPTIONS.checkIntervalMinutes, 0, 24 * 60)
  const timeoutMs = clampNumber(input.timeoutMs, DEFAULT_OPTIONS.timeoutMs, 1_000, 60_000)

  return { packageName, registryUrl, checkIntervalMinutes, timeoutMs }
}

function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

/** Strip the leading `v` and split a semver string. Returns undefined when invalid. */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare two semver strings (build metadata ignored, prerelease rules from
 * semver 2.0.0). Returns -1, 0, 1, or undefined when either side is invalid.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const difference = Number(left) - Number(right)
      if (difference !== 0) return difference < 0 ? -1 : 1
    } else if (leftNumeric) {
      return -1
    } else if (rightNumeric) {
      return 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/** Read a package manifest, returning undefined instead of throwing. */
function readManifest(directory) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return manifest !== null && typeof manifest === 'object' ? manifest : undefined
  } catch {
    return undefined
  }
}

/** Walk up from `file` looking for the package manifest with `packageName`. */
export function findPackageRoot(file, packageName) {
  let directory
  try {
    directory = dirname(realpathSync(file))
  } catch {
    directory = dirname(file)
  }
  for (let depth = 0; depth < 16; depth += 1) {
    const manifest = readManifest(directory)
    if (manifest !== undefined && manifest.name === packageName && typeof manifest.version === 'string') {
      return { directory, version: manifest.version }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/** Guess how an installation directory was produced from its path shape. */
export function classifyInstallKind(directory) {
  const normalized = directory.split(sep).join('/')
  if (/(^|\/)\.pnpm\//.test(normalized)) return 'pnpm'
  if (/(^|\/)pnpm\/global\//.test(normalized)) return 'pnpm'
  if (/(^|\/)yarn\/(global|link)\//.test(normalized)) return 'yarn'
  if (/(^|\/)node_modules\/@deepseek-ai\/dsh$/.test(normalized)) return 'npm'
  return 'unknown'
}

/**
 * Locate the running `@deepseek-ai/dsh` package.
 *
 * Tried in order: the executed CLI file (`process.argv[1]`), the package name
 * resolved from that file, then `DSH_INSTALL_DIR` (set for tool shells, and a
 * useful hint elsewhere). Returns `{ version, installDir, installKind, resolvedVia }`
 * or `{ error }` — never throws.
 */
export function resolveInstallation(packageName = DEFAULT_PACKAGE_NAME, environment = {}) {
  const argv = Array.isArray(environment.argv) ? environment.argv : process.argv
  const env = environment.env ?? process.env
  const attempts = []

  const argvPath = typeof argv[1] === 'string' && argv[1].length > 0 ? argv[1] : undefined
  if (argvPath !== undefined) {
    const found = findPackageRoot(argvPath, packageName)
    if (found !== undefined) return describeInstallation(found, 'process.argv[1]')
    attempts.push(`process.argv[1] (${argvPath})`)

    for (const base of [argvPath, safeRealpath(argvPath)]) {
      if (typeof base !== 'string') continue
      try {
        const requireFrom = createRequire(base)
        const manifestPath = requireFrom.resolve(`${packageName}/package.json`)
        const directory = dirname(manifestPath)
        const manifest = readManifest(directory)
        if (manifest !== undefined && manifest.name === packageName && typeof manifest.version === 'string') {
          return describeInstallation({ directory, version: manifest.version }, `resolved from ${base}`)
        }
      } catch {
        // Try the next anchor.
      }
    }
  }

  const configuredDir = typeof env.DSH_INSTALL_DIR === 'string' ? env.DSH_INSTALL_DIR : undefined
  if (configuredDir !== undefined && configuredDir.length > 0) {
    const manifest = readManifest(configuredDir)
    if (manifest !== undefined && manifest.name === packageName && typeof manifest.version === 'string') {
      return describeInstallation({ directory: configuredDir, version: manifest.version }, 'DSH_INSTALL_DIR')
    }
    attempts.push(`DSH_INSTALL_DIR (${configuredDir})`)
  }

  return {
    error: `Could not find ${packageName} from the running process (tried ${attempts.length === 0 ? 'no candidates' : attempts.join(', ')}).`,
  }
}

function safeRealpath(file) {
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}

function describeInstallation(found, resolvedVia) {
  return {
    version: found.version,
    installDir: found.directory,
    installKind: classifyInstallKind(found.directory),
    resolvedVia,
  }
}

/** The shell command that would upgrade this installation. */
export function upgradeCommand(installKind, packageName = DEFAULT_PACKAGE_NAME) {
  const specifier = `${packageName}@latest`
  switch (installKind) {
    case 'pnpm':
      return `pnpm add -g ${specifier}`
    case 'yarn':
      return `yarn global add ${specifier}`
    default:
      return `npm install -g ${specifier}`
  }
}

/** Build the packument URL for a scoped package without double-escaping the scope. */
export function packumentUrl(registryUrl, packageName) {
  const base = registryUrl.replace(/\/+$/, '')
  const escaped = encodeURIComponent(packageName).replace(/^%40/, '@')
  return `${base}/${escaped}`
}

function isoOrUndefined(value) {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString()
}

/**
 * Extract what the plugin needs from a full npm packument.
 * @returns `{ latest: { version, publishedAt }, installedPublishedAt }`
 */
export function parsePackument(packument, installedVersion) {
  if (packument === null || typeof packument !== 'object') throw new Error('registry response was not a JSON object')
  const distTags = packument['dist-tags']
  const latestVersion = distTags !== null && typeof distTags === 'object' ? distTags.latest : undefined
  if (typeof latestVersion !== 'string' || latestVersion.length === 0) {
    throw new Error('registry response has no "latest" dist-tag')
  }
  if (parseVersion(latestVersion) === undefined) throw new Error(`registry "latest" tag is not a valid version (${latestVersion})`)
  const time = packument.time !== null && typeof packument.time === 'object' ? packument.time : {}
  return {
    latest: { version: latestVersion, publishedAt: isoOrUndefined(time[latestVersion]) },
    installedPublishedAt: typeof installedVersion === 'string' ? isoOrUndefined(time[installedVersion]) : undefined,
  }
}

function describeFetchFailure(error, timeoutMs) {
  if (error !== null && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `the npm registry did not answer within ${Math.round(timeoutMs / 1000)}s`
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 0 ? message : 'network request failed'
}

/**
 * One registry check: no caching, no side effects. Exported so tests can drive
 * it with a fake fetch and clock.
 */
export async function requestStatus({ options, installation, fetchImpl = globalThis.fetch, now = Date.now }) {
  const checkedAt = new Date(now()).toISOString()
  const installed = installation !== undefined && typeof installation.error !== 'string'
    ? {
        version: installation.version,
        publishedAt: undefined,
        installKind: installation.installKind,
        installDir: installation.installDir,
      }
    : { version: undefined, installKind: 'unknown' }

  if (installation !== undefined && typeof installation.error === 'string') {
    return {
      schema: 1,
      checkedAt,
      registryUrl: options.registryUrl,
      packageName: options.packageName,
      installed,
      latest: undefined,
      updateAvailable: false,
      relation: 'unknown',
      cached: false,
      error: installation.error,
    }
  }

  const url = packumentUrl(options.registryUrl, options.packageName)
  let packument
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': `dsh-npm-update-notifier/${PLUGIN_VERSION}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (!response.ok) throw new Error(`the npm registry answered HTTP ${response.status}`)
    packument = await response.json()
  } catch (error) {
    return {
      schema: 1,
      checkedAt,
      registryUrl: options.registryUrl,
      packageName: options.packageName,
      installed,
      latest: undefined,
      updateAvailable: false,
      relation: 'unknown',
      cached: false,
      error: describeFetchFailure(error, options.timeoutMs),
    }
  }

  let parsed
  try {
    parsed = parsePackument(packument, installed.version)
  } catch (error) {
    return {
      schema: 1,
      checkedAt,
      registryUrl: options.registryUrl,
      packageName: options.packageName,
      installed,
      latest: undefined,
      updateAvailable: false,
      relation: 'unknown',
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const comparison = installed.version === undefined ? undefined : compareVersions(parsed.latest.version, installed.version)
  const relation = comparison === undefined ? 'unknown' : comparison > 0 ? 'behind' : comparison < 0 ? 'ahead' : 'current'
  const updateAvailable = relation === 'behind'
  const hasLocalVersion = installed.version !== undefined
  // Only suggest a command for an install kind we can actually upgrade; an
  // unknown layout must not be told to run a global npm install.
  const command =
    hasLocalVersion && updateAvailable && installed.installKind !== 'unknown'
      ? upgradeCommand(installed.installKind, options.packageName)
      : undefined

  return {
    schema: 1,
    checkedAt,
    registryUrl: options.registryUrl,
    packageName: options.packageName,
    installed: {
      ...installed,
      publishedAt: parsed.installedPublishedAt,
    },
    latest: {
      version: parsed.latest.version,
      publishedAt: parsed.latest.publishedAt,
      distTag: 'latest',
    },
    updateAvailable,
    relation,
    upgradeCommand: command,
    cached: false,
    error: null,
  }
}

/**
 * Wrap {@link requestStatus} with the small cache the route needs: a fresh
 * successful answer is reused until `checkIntervalMinutes` elapses; failures
 * are retried at most once a minute.
 */
export function createStatusReader({ options, installation, fetchImpl = globalThis.fetch, now = Date.now }) {
  let last
  let fetchedAt = 0
  let inflight

  const ttl = () => {
    const millis = options.checkIntervalMinutes * 60_000
    if (last !== undefined && typeof last.error === 'string' && last.error.length > 0) return Math.min(millis, 60_000)
    return millis
  }

  const read = (force = false) => {
    if (force !== true && last !== undefined && now() - fetchedAt < ttl()) {
      return Promise.resolve({ ...last, cached: true })
    }
    if (inflight !== undefined) return inflight
    inflight = requestStatus({ options, installation, fetchImpl, now })
      .then((payload) => {
        last = payload
        fetchedAt = now()
        return payload
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  return read
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

/** Host plugin entry point. */
export function apply(ctx, config) {
  const options = normalizeOptions(config)
  const installation = resolveInstallation(options.packageName)
  const readStatus = createStatusReader({ options, installation })

  // Warm the cache once at load so the first page fetch is instant. A failure
  // is stored in the cached payload and shown in the UI, so it needs no log.
  void readStatus(false).catch(() => {})

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: async (request, response) => {
          const connection = ctx.get('connection')
          if (connection !== undefined && typeof connection.requestRejection === 'function') {
            const rejection = connection.requestRejection(request)
            if (rejection !== undefined) {
              response.statusCode = rejection
              response.end()
              return
            }
          }
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.statusCode = 405
            response.setHeader('allow', 'GET, HEAD')
            response.end()
            return
          }
          const url = new URL(typeof request.url === 'string' ? request.url : STATUS_ROUTE, 'http://localhost')
          const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true'
          try {
            const payload = await readStatus(force)
            const body = JSON.stringify(payload)
            response.statusCode = 200
            response.setHeader('content-type', 'application/json; charset=utf-8')
            response.setHeader('cache-control', 'no-store')
            response.end(request.method === 'HEAD' ? undefined : body)
          } catch (error) {
            sendJson(response, 500, {
              schema: 1,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }),
    'dsh-npm-update-notifier: status route',
  )
}

export const inject = ['webServer']
