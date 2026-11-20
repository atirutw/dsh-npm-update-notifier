import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyInstallKind,
  compareVersions,
  createStatusReader,
  findPackageRoot,
  normalizeOptions,
  packumentUrl,
  parsePackument,
  parseVersion,
  requestStatus,
  resolveInstallation,
  upgradeCommand,
} from '../index.js'

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'npm-update-notifier-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeManifest(directory, manifest) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest, null, 2))
}

test('parseVersion accepts release and prerelease versions', () => {
  assert.deepEqual(parseVersion('0.2.2'), { major: 0, minor: 2, patch: 2, prerelease: [] })
  assert.deepEqual(parseVersion('v1.0.0-rc.5'), { major: 1, minor: 0, patch: 0, prerelease: ['rc', '5'] })
  assert.deepEqual(parseVersion('1.0.0+build.7'), { major: 1, minor: 0, patch: 0, prerelease: [] })
  assert.equal(parseVersion('not-a-version'), undefined)
  assert.equal(parseVersion(undefined), undefined)
})

test('compareVersions follows semver ordering', () => {
  assert.equal(compareVersions('0.2.2-rc.5', '0.2.2-rc.5'), 0)
  assert.equal(compareVersions('0.2.2-rc.5', '0.2.2-rc.6'), -1)
  assert.equal(compareVersions('0.2.2-rc.10', '0.2.2-rc.9'), 1)
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.5'), 1)
  assert.equal(compareVersions('0.2.2-rc.5', '0.2.2'), -1)
  assert.equal(compareVersions('0.3.0', '0.2.9'), 1)
  assert.equal(compareVersions('0.2.2-alpha.1', '0.2.2-beta.1'), -1)
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(compareVersions('nope', '1.0.0'), undefined)
})

test('packumentUrl encodes scoped names without escaping the scope marker', () => {
  assert.equal(packumentUrl('https://registry.npmjs.org', '@deepseek-ai/dsh'), 'https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  assert.equal(packumentUrl('https://registry.example.test/npm/', 'plain-package'), 'https://registry.example.test/npm/plain-package')
})

test('normalizeOptions fills defaults and clamps bad values', () => {
  assert.deepEqual(normalizeOptions(undefined), {
    packageName: '@deepseek-ai/dsh',
    registryUrl: 'https://registry.npmjs.org',
    checkIntervalMinutes: 60,
    timeoutMs: 10_000,
  })
  const tuned = normalizeOptions({ checkIntervalMinutes: 5, timeoutMs: 500, registryUrl: 'https://mirror.test/npm/', packageName: '@scope/pkg' })
  assert.equal(tuned.checkIntervalMinutes, 5)
  assert.equal(tuned.timeoutMs, 1_000)
  assert.equal(tuned.registryUrl, 'https://mirror.test/npm')
  assert.equal(tuned.packageName, '@scope/pkg')
  assert.equal(normalizeOptions({ checkIntervalMinutes: -10 }).checkIntervalMinutes, 0)
  assert.equal(normalizeOptions({ registryUrl: 'not a url' }).registryUrl, 'https://registry.npmjs.org')
  assert.equal(normalizeOptions({ timeoutMs: 10 * 60_000 }).timeoutMs, 60_000)
})

test('classifyInstallKind reads global install layouts', () => {
  assert.equal(classifyInstallKind('/usr/local/lib/node_modules/@deepseek-ai/dsh'), 'npm')
  assert.equal(classifyInstallKind('/home/me/.local/share/pnpm/global/5/node_modules/@deepseek-ai/dsh'), 'pnpm')
  assert.equal(classifyInstallKind('/home/me/.local/share/pnpm/global/5/.pnpm/@deepseek-ai+dsh@0.2.2/node_modules/@deepseek-ai/dsh'), 'pnpm')
  assert.equal(classifyInstallKind('/home/me/.config/yarn/global/node_modules/@deepseek-ai/dsh'), 'yarn')
  assert.equal(classifyInstallKind('/home/me/projects/deepseek-harness/apps/cli'), 'unknown')
})

test('upgradeCommand matches the detected package manager', () => {
  assert.equal(upgradeCommand('npm'), 'npm install -g @deepseek-ai/dsh@latest')
  assert.equal(upgradeCommand('pnpm'), 'pnpm add -g @deepseek-ai/dsh@latest')
  assert.equal(upgradeCommand('yarn'), 'yarn global add @deepseek-ai/dsh@latest')
  assert.equal(upgradeCommand('unknown'), 'npm install -g @deepseek-ai/dsh@latest')
})

test('findPackageRoot walks up from a nested file', (t) => {
  const root = temporaryDirectory(t)
  const packageDirectory = join(root, 'prefix', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  writeManifest(packageDirectory, { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' })
  const found = findPackageRoot(join(packageDirectory, 'lib', 'bin.js'), '@deepseek-ai/dsh')
  assert.equal(found?.directory, packageDirectory)
  assert.equal(found?.version, '0.2.2-rc.5')
  assert.equal(findPackageRoot(join(root, 'somewhere', 'else.js'), '@deepseek-ai/dsh'), undefined)
})

test('resolveInstallation falls back to DSH_INSTALL_DIR', (t) => {
  const root = temporaryDirectory(t)
  const packageDirectory = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  writeManifest(packageDirectory, { name: '@deepseek-ai/dsh', version: '1.2.3' })

  const installation = resolveInstallation('@deepseek-ai/dsh', {
    argv: ['/usr/bin/node', join(root, 'missing-bin.js')],
    env: { DSH_INSTALL_DIR: packageDirectory },
  })
  assert.equal(installation.version, '1.2.3')
  assert.equal(installation.installKind, 'npm')
  assert.equal(installation.resolvedVia, 'DSH_INSTALL_DIR')

  const missing = resolveInstallation('@deepseek-ai/dsh', {
    argv: ['/usr/bin/node', join(root, 'missing-bin.js')],
    env: {},
  })
  assert.match(missing.error, /Could not find @deepseek-ai\/dsh/)
})

test('parsePackument extracts versions and publish dates', () => {
  const parsed = parsePackument(
    {
      'dist-tags': { latest: '0.2.2-rc.6', next: '0.2.2-rc.6' },
      time: { '0.2.2-rc.5': '2026-11-18T13:17:23.604Z', '0.2.2-rc.6': '2026-11-20T09:00:00.000Z', modified: '2026-11-20T09:00:00.000Z' },
    },
    '0.2.2-rc.5',
  )
  assert.deepEqual(parsed.latest, { version: '0.2.2-rc.6', publishedAt: '2026-11-20T09:00:00.000Z' })
  assert.equal(parsed.installedPublishedAt, '2026-11-18T13:17:23.604Z')
  assert.throws(() => parsePackument({ 'dist-tags': {} }, '0.2.2'), /latest/)
  assert.throws(() => parsePackument({ 'dist-tags': { latest: 'wat' } }, '0.2.2'), /valid version/)
})

function fakePackument(latest, publishedAt = '2026-11-20T09:00:00.000Z') {
  return {
    'dist-tags': { latest },
    time: { [latest]: publishedAt },
  }
}

function options(overrides = {}) {
  return { packageName: '@deepseek-ai/dsh', registryUrl: 'https://registry.npmjs.org', checkIntervalMinutes: 60, timeoutMs: 10_000, ...overrides }
}

test('requestStatus reports an available update and its command', async () => {
  const calls = []
  const status = await requestStatus({
    options: options(),
    installation: { version: '0.2.2-rc.5', installDir: '/usr/local/lib/node_modules/@deepseek-ai/dsh', installKind: 'npm', resolvedVia: 'process.argv[1]' },
    now: () => Date.parse('2026-11-20T16:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => fakePackument('0.2.2-rc.6') }
    },
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^https:\/\/registry\.npmjs\.org\/@deepseek-ai%2Fdsh$/)
  assert.equal(status.checkedAt, '2026-11-20T16:00:00.000Z')
  assert.equal(status.relation, 'behind')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.upgradeCommand, 'npm install -g @deepseek-ai/dsh@latest')
  assert.equal(status.latest.version, '0.2.2-rc.6')
  assert.equal(status.installed.version, '0.2.2-rc.5')
  assert.equal(status.error, null)
})

test('requestStatus reports same and ahead installations without an update', async () => {
  const same = await requestStatus({
    options: options(),
    installation: { version: '0.2.2-rc.5', installDir: '/x', installKind: 'npm', resolvedVia: 'process.argv[1]' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => fakePackument('0.2.2-rc.5') }),
  })
  assert.equal(same.relation, 'current')
  assert.equal(same.updateAvailable, false)
  assert.equal(same.upgradeCommand, undefined)

  const ahead = await requestStatus({
    options: options(),
    installation: { version: '0.3.0', installDir: '/x', installKind: 'npm', resolvedVia: 'process.argv[1]' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => fakePackument('0.2.2-rc.5') }),
  })
  assert.equal(ahead.relation, 'ahead')
  assert.equal(ahead.updateAvailable, false)
})

test('requestStatus keeps install information when the registry fails', async () => {
  const status = await requestStatus({
    options: options(),
    installation: { version: '0.2.2-rc.5', installDir: '/x', installKind: 'npm', resolvedVia: 'process.argv[1]' },
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
    },
  })
  assert.equal(status.installed.version, '0.2.2-rc.5')
  assert.match(status.error, /ENOTFOUND/)
  assert.equal(status.updateAvailable, false)
})

test('requestStatus reports an unlocatable installation as an error payload', async () => {
  let fetched = false
  const status = await requestStatus({
    options: options(),
    installation: { error: 'Could not find @deepseek-ai/dsh' },
    fetchImpl: async () => {
      fetched = true
      return { ok: true, status: 200, json: async () => fakePackument('0.2.2-rc.6') }
    },
  })
  assert.equal(fetched, false)
  assert.match(status.error, /Could not find/)
  assert.equal(status.installed.version, undefined)
})

test('createStatusReader caches successful checks and honors refresh', async () => {
  let fetches = 0
  let clock = 1_000
  const readStatus = createStatusReader({
    options: options({ checkIntervalMinutes: 10 }),
    installation: { version: '0.2.2-rc.5', installDir: '/x', installKind: 'npm', resolvedVia: 'process.argv[1]' },
    now: () => clock,
    fetchImpl: async () => {
      fetches += 1
      return { ok: true, status: 200, json: async () => fakePackument('0.2.2-rc.6') }
    },
  })

  const first = await readStatus(false)
  assert.equal(first.cached, false)
  assert.equal(fetches, 1)

  clock += 60_000
  const second = await readStatus(false)
  assert.equal(second.cached, true)
  assert.equal(fetches, 1)

  clock += 10 * 60_000
  const third = await readStatus(false)
  assert.equal(third.cached, false)
  assert.equal(fetches, 2)

  const forced = await readStatus(true)
  assert.equal(forced.cached, false)
  assert.equal(fetches, 3)
})
