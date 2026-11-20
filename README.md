# npm-update-notifier

A small [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that tells you when a newer `@deepseek-ai/dsh` is on npm, and when the version you are running was published.

I wrote this for my own machine and figured I would MIT-license it in case it is useful to someone else. It is a personal project: it works for me, and that is the whole support policy.

## What it does

- Reads the installed `@deepseek-ai/dsh` version from the running CLI, asks the npm registry for the current `latest` dist-tag, and compares the two.
- **Settings → General → "DSH updates"** shows the installed version with its publish date, the latest npm version with its publish date, the last check time, an **Up to date** / **Update available** badge, a **Check now** button, and the upgrade command with a copy button.
- When a newer version exists, a dismissible notice appears in the top-right corner. Dismissing it hides it until an even newer version shows up.
- The Host caches checks for `checkIntervalMinutes` (default 60), so opening the app or leaving a page open does not hammer the registry. Open pages re-read the cache every 6 hours.

It is only really useful if DSH was installed from npm (`npm install -g @deepseek-ai/dsh`). A source checkout or a Desktop build still shows the registry data, but it will not tell you how to update that kind of installation.

## Install

From the local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-npm-update-notifier
```

Or in the Web GUI: **Plugins → Add plugin** and pick this directory. Restart DSH if the page does not pick the new bundle up immediately. Turn the bundle's row on if it was persisted as disabled.

## Configuration

The row can be tuned from your profile's `cordis.patch.yml`:

```yaml
- id: npm-update-notifier
  name: npm-update-notifier
  config:
    checkIntervalMinutes: 120
    timeoutMs: 8000
    registryUrl: https://registry.npmjs.org
    packageName: "@deepseek-ai/dsh"
```

| Field | Default | Meaning |
|---|---|---|
| `checkIntervalMinutes` | `60` | How long a successful check is reused. `0` checks on every request. |
| `timeoutMs` | `10000` | How long to wait for the registry. Clamped to 1–60 s. |
| `registryUrl` | `https://registry.npmjs.org` | Registry to query (for mirrors/proxies). |
| `packageName` | `@deepseek-ai/dsh` | Package to watch. Only useful for forks. |

## Notes and limitations

- The only network request is a `GET` for the registry packument. No telemetry, no analytics, no writes outside your profile.
- The update notice dismisses per browser and per version (`localStorage`).
- The upgrade command is guessed from the install path (`npm`, `pnpm`, or `yarn` global layouts). If it guesses wrong, run whatever you normally use.
- Prereleases are compared with proper semver ordering, so `latest` pointing at an `rc` still works.
- DSH internals change between releases; a future release may make this plugin stop loading. Updating or removing the plugin is the fix.
- Not affiliated with DeepSeek. "DeepSeek Harness" and `@deepseek-ai/dsh` belong to their respective owners.

## Development

```sh
node --test test/
```

The Host half is `index.js`, the browser half is `client.js`, and the loader patch is `cordis.patch.yml`.

## License

MIT. See [LICENSE](LICENSE).
