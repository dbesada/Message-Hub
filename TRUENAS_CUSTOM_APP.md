# Message Hub on TrueNAS SCALE as a Custom App

This is the recommended deployment path for an always-on Message Hub instance on TrueNAS SCALE.

The preferred release flow is now:

1. Commit the app to GitHub
2. Push a release tag like `v1.12.1`
3. GitHub Actions builds and publishes `ghcr.io/YOUR_GITHUB_OWNER/message-hub:1.12.1`
4. GitHub Actions optionally tells TrueNAS to redeploy that exact image
5. TrueNAS pulls that image directly

This removes the Windows Docker Desktop machine from the release path.

## What TrueNAS Will Run

- Container image: `ghcr.io/YOUR_GITHUB_OWNER/message-hub:1.12.1`
- Container port: `3000`
- Persistent database mount: `/app/data`
- SQLite database path inside container: `/app/data/quo_manager.db`
- Health check endpoint: `/health`

## One-Time Prep

Create a dataset for the app database:

1. TrueNAS UI -> **Datasets**
2. Pick your pool
3. Add dataset, for example:
   - Name: `apps/message-hub`
   - Purpose: Generic
4. The host path will look something like:
   - `/mnt/tank/apps/message-hub`

If you want to migrate your current local database, stop the Windows app first, then copy these three files into that dataset:

- `C:\AI\quo-webapp\quo_manager.db`
- `C:\AI\quo-webapp\quo_manager.db-wal`
- `C:\AI\quo-webapp\quo_manager.db-shm`

The `-wal` and `-shm` files matter when SQLite is using WAL mode.

## Release the Docker Image with GitHub Actions

The repository contains two workflows:

- `.github/workflows/container-ci.yml`
  - validates Python syntax
  - checks version metadata consistency
  - validates the TrueNAS deploy helper syntax
  - performs a Docker build without pushing
- `.github/workflows/container-release.yml`
  - publishes to GitHub Container Registry (`ghcr.io`)
  - pushes version tags from the repo's `VERSION` file
  - also updates the `latest` tag on release
  - can optionally redeploy the TrueNAS app after the image is published

Release process:

1. Update `VERSION`
2. Keep `truenas-deployment.json` and `package.json` on the same version
3. Commit the change
4. Create and push a git tag that matches the version:

```powershell
git tag v1.12.1
git push origin main --tags
```

To avoid hand-editing those files, you can use:

```powershell
.\scripts\release-version.ps1 -Version 1.12.2
```

GitHub Actions will publish:

```text
ghcr.io/YOUR_GITHUB_OWNER/message-hub:1.12.1
ghcr.io/YOUR_GITHUB_OWNER/message-hub:latest
```

Required repository settings:

- Actions enabled for the repo
- Package permissions left enabled for GitHub Container Registry

No Docker credentials are required for publishing to `ghcr.io` when the workflow uses `GITHUB_TOKEN`.
If the repository stays private, the container package will usually be private too. In that case, TrueNAS needs a registry credential for `ghcr.io` that uses a GitHub token with package read access.

## Optional: Fully Automatic TrueNAS Deploys

The repo now includes `scripts/truenas-deploy.js`, and the release workflow can call it automatically after each tagged release.

Set these GitHub repository values before enabling that flow:

Required secrets:

- `TRUENAS_API_KEY`
- `GHCR_PULL_USERNAME`
- `GHCR_PULL_TOKEN`

Required variable:

- `TRUENAS_HOST`
  - use the reachable API hostname for GitHub Actions
  - if your NAS is only reachable over Tailscale, set this to the Tailscale DNS name

Optional variables:

- `TRUENAS_APP_ID`
  - default: `quo-manager`
- `TRUENAS_SERVICE_NAME`
  - default: `quo-manager`
- `TRUENAS_PUBLIC_URL`
  - used to generate the icon URL label
- `TRUENAS_HOST_PATH`
  - only set this when you intentionally want to override the current mounted data path
- `TRUENAS_PRESERVE_DATA_PATH`
  - default behavior is to preserve the app's current data mount

Optional secret:

- `TAILSCALE_AUTHKEY`
  - if set, the GitHub Actions deploy job joins your tailnet before calling the TrueNAS API

For a first cutover from the old `quo-manager` app, keeping `TRUENAS_APP_ID=quo-manager` is the safest path.
That preserves the live app identity and, by default, preserves the current data mount too.

## TrueNAS Custom App Settings

Go to **Apps -> Discover Apps -> Custom App**.

Use these values:

| TrueNAS Field | Value |
| --- | --- |
| Application Name | `message-hub` |
| Image repository | `ghcr.io/YOUR_GITHUB_OWNER/message-hub` |
| Image tag | `1.12.1` |
| Container Port | `3000` |
| Node Port / Web Port | choose one, for example `3000` or `13000` |
| Restart Policy | `Unless Stopped` |

Environment variables:

| Name | Value |
| --- | --- |
| `PORT` | `3000` |
| `HOST` | `0.0.0.0` |
| `DB_PATH` | `/app/data/quo_manager.db` |

Storage:

| Mount Type | Host Path | Mount Path |
| --- | --- | --- |
| Host Path | `/mnt/YOUR_POOL/apps/message-hub` | `/app/data` |

After deploy, open:

```text
http://TRUENAS_IP:CHOSEN_NODE_PORT
```

The app opens directly. Save your Quo API key and other credentials inside the app's Settings modal.

## Updating Later

1. Update `VERSION`, `truenas-deployment.json`, and any changelog entry.
2. Commit and push.
3. Push the matching git tag, for example `v1.12.2`.
4. In TrueNAS, edit the app and change the image tag to the new version if it is not already set.
5. Redeploy.

The database stays on the mounted dataset and survives image updates.

## Backups

Because the DB lives on a TrueNAS dataset, protect it with snapshots.

Suggested snapshot schedule:

- Dataset: `apps/message-hub`
- Frequency: daily
- Retention: 30 days

## Remote Access

For access away from home, do not expose port `3000` directly to the internet.

Recommended options:

- Tailscale on TrueNAS, then access `http://TRUENAS_TAILSCALE_IP:PORT`
- Cloudflare Tunnel pointing to `http://127.0.0.1:PORT`
- Reverse proxy with HTTPS and access controls

Tailscale is the cleanest first step if this is only for your own computers.

## If You Want to Keep the Private TrueNAS Registry

GitHub-hosted runners cannot push to `192.168.x.x` addresses on your LAN.

If you want CI to publish directly to `192.168.50.230:5000`, use a self-hosted GitHub Actions runner on the same network as TrueNAS. Otherwise, use `ghcr.io` as the release registry and let TrueNAS pull from there.
