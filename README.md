# 52hertz AFK

A Node.js / Mineflayer Minecraft **1.21.11** AFK management panel, published from
a cleaned Linux deployment snapshot. The supplied package version is **1.7.1**.

The manager supports offline-mode bot profiles, per-account SOCKS5 proxy pools,
automation, reconnection, activity logs, and a private web control panel. Workers
manage groups of up to 50 accounts, with a configured maximum of 500 accounts.
That limit is not a verified performance guarantee.

## Included source

- `src/`: bot management, workers, web UI, authentication, profiles, and workflows.
- `plugins/`: 16 built-in plugin manifests.
- `docs/PLUGIN_API.md`: trusted local JavaScript plugin API.
- `plugin-examples/`: an example plugin with no deployment credentials.
- `scripts/`: account generation and local data-management utilities.
- `deploy/`: generic systemd and Nginx configuration examples.

This is the **web-panel source distribution**. The original metadata also refers
to an Electron desktop application, but its `electron/` source and packaging
resources were not present in the snapshot. Use `npm run panel`; the inherited
`npm start` and `build:linux` commands require those missing desktop sources.

## Data removed before publication

The original deployment's account lists, all proxy lists and credentials,
configuration files, saved profiles, backups, administrator environment file,
TOTP enrollment state, and installed `node_modules` are excluded. The hardcoded
account list in the First Join preset was cleared. Deployment-specific branding
and the previous server address were removed from the public documentation.

Only empty account/proxy examples and a fresh localhost configuration are
provided. The original archive is not included in this repository or its history.

## Local setup

Requires **Node.js 22 or newer**. Install runtime dependencies without the
unavailable desktop packaging tools:

```bash
npm ci --omit=dev --ignore-scripts
cp config.example.json config.json
cp proxies.example.txt proxies.txt
cp .env.example .env
npm run generate -- 1
```

The final command creates one new random offline username in your local
`accounts.json`; no original usernames are distributed. The example configuration
targets `127.0.0.1:25565`, requests one account, and has empty join commands and
disabled scheduled messages. Change the local configuration for your own server.

Before starting the panel, fill in your local `.env`:

| Variable | Required value |
| --- | --- |
| `AFK_ADMIN_USER` | Your panel username |
| `AFK_ADMIN_PASSWORD_SCRYPT` | A 16-byte hex salt, `:`, and a 32-byte scrypt password hash in hex |
| `AFK_TOTP_SECRET` | Your own Base32-encoded authenticator secret |

The application does not load `.env` automatically. Export the variables before
starting, or use a service environment file. On Linux, after filling in `.env`:

```bash
chmod 600 .env accounts.json config.json proxies.txt
set -a
. ./.env
set +a
npm run panel
```

The panel binds to `127.0.0.1:3177` and uses secure authentication cookies. Put an
HTTPS reverse proxy in front of it for deployment. The examples under `deploy/`
need your own paths, service user, and TLS certificates; they are not an automatic
installation script. Bots are started from the authenticated panel.

Use the software on servers you own or are authorized to use it on. Offline
profiles do not provide Microsoft account authentication.

## Authentication and plugins

The panel includes scrypt password verification, TOTP, CSRF checks, and secure
session cookies. Keep `.env`, `.totp-enabled`, accounts, proxies, profiles, logs,
and certificates private; `.gitignore` excludes these local files.

External plugins are trusted JavaScript running with the launcher's permissions.
Their declared API permissions are not an operating-system sandbox. See
[the plugin guide](docs/PLUGIN_API.md).

## Validation and known limitations

The cleaned first-party JavaScript is checked for syntax, and the example
configuration is validated locally. No Minecraft server or proxy connections are
made as part of publication, and the Linux service and browser UI have not been
tested live here.

The supplied snapshot still contains previously identified implementation issues:
command logs do not mask future login-command passwords, the worker log-ID map
can outgrow the retained log list, and duplicate 60-character profile names can
prevent profile import from completing. The current web entry does not expose
that profile-import module. These issues were not changed as part of removing
private deployment data.

## Dependencies and license

The project uses Mineflayer, SOCKS, QRCode, and safe-regex2. Their licenses remain
with their respective projects; third-party installed dependencies are not
redistributed in this source tree. Both lockfiles from the supplied package are
retained.

No project license file was included in the original deployment archive, and no
new license has been assigned during this publication.
