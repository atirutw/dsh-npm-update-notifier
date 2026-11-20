# dsh-npm-update-notifier

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that reports newer `@deepseek-ai/dsh` releases from npm.

## Behavior

- Reads the installed `@deepseek-ai/dsh` version from the running CLI and compares it with the npm `latest` dist-tag.
- **Settings → General → "DSH updates"** shows the installed version and publish date, the latest npm version and publish date, the last check time, an **Up to date** / **Update available** badge, a **Check now** button, and the upgrade command with a copy button.
- When a newer version exists, a dismissible notice appears in the top-right corner. It reappears only for a newer version.
- Host checks are cached for `checkIntervalMinutes` (default 60). Open pages re-read the cache every 6 hours.

Built for npm-installed DSH. A source launch resolves too; a packaged Desktop build may not, and then the row reports that the installed package could not be located.

## Install

From the repository:

```sh
dsh plugin --profile web add git+https://github.com/atirutw/dsh-npm-update-notifier
```

From a clone:

```sh
dsh plugin --profile web add /path/to/dsh-npm-update-notifier
```

Or in the Web GUI: **Plugins → Add plugin**, then pick the checkout directory. Restart DSH if the bundle does not load immediately.

## Configuration

```yaml
- id: dsh-npm-update-notifier
  name: dsh-npm-update-notifier
  config:
    checkIntervalMinutes: 120
    timeoutMs: 8000
    registryUrl: https://registry.npmjs.org
    packageName: "@deepseek-ai/dsh"
```

| Field | Default | Meaning |
|---|---|---|
| `checkIntervalMinutes` | `60` | How long a successful check is reused. `0` checks on every request. |
| `timeoutMs` | `10000` | Registry timeout, clamped to 1–60 s. |
| `registryUrl` | `https://registry.npmjs.org` | Registry to query. |
| `packageName` | `@deepseek-ai/dsh` | Package to watch. |

## Notes

- The only network request is a `GET` for the npm packument. No telemetry.
- Notice dismissal is stored per browser and per version in `localStorage`.
- The upgrade command is inferred from the install path (`npm`, `pnpm`, or `yarn` global layouts).
- Prerelease versions are ordered with semver rules.
- Not affiliated with DeepSeek.

## Development

```sh
node --test
```

`index.js` is the Host half, `client.js` the browser half, `cordis.patch.yml` the loader patch.

## License

MIT. See [LICENSE](LICENSE).
