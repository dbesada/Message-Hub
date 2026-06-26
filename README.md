# Message Hub

Message Hub is a self-hosted messaging and booking triage app for small service businesses that need one place to review inbound conversations, tag booking intent by location, and keep connector credentials on the server instead of in the browser.

The current product combines:

- a modular message hub at `/hub`
- a legacy Quo operations surface at `/`
- Docker + GitHub Actions release automation
- TrueNAS deployment support for an always-on home-server setup

## What It Does

- Aggregates messages from multiple connectors into one triage view
- Tags booking requests as `Mississauga` or `Toronto`
- Supports manual review when a location is ambiguous
- Stores connector configuration and API credentials in SQLite on the server
- Exposes webhook ingest routes for supported connectors
- Supports pull-based sync for connectors such as Gmail via Google login and the local Quo cache
- Lets you test saved connector setup from the hub so missing account details are easier to spot
- Opens directly without an app-level login gate

## Current Connectors

The app is structured around a connector registry so new sources can be added without rewriting the hub UI.

Current connector types in the codebase:

- Gmail
  - Google login + Gmail API sync
  - IMAP app-password fallback for legacy setups
- Quo
  - local DB sync today
  - API-oriented settings are already represented in the UI
- Meta
  - verified Facebook / Instagram webhook ingest
  - token-oriented connector model for future Graph API expansion
- TikTok
  - webhook / token-oriented connector model
- Generic webhook
  - custom source ingestion

## Main Surfaces

### `/hub`

The new Message Hub workflow for triaging inbound conversations:

- connector list with add/edit/pause actions
- source filtering
- location tagging for `Mississauga` and `Toronto`
- summary counts
- webhook endpoints per connector
- sync actions for supported connectors

### `/`

The original Quo-oriented operational UI:

- contacts and messaging workflows
- duplicate review / merge tools
- webhook and sync utilities
- settings and saved credentials

## Credential Storage

The app intentionally saves credentials server-side in SQLite so they can be reused by sync jobs and webhook flows.

For Gmail auto-login, create a Google OAuth web client and add this callback URL on your Message Hub domain:

- `/hub/api/gmail/oauth/callback`

Examples already supported in code:

- Quo API key
- Anthropic API key
- Vagaro client credentials
- connector-specific secrets and tokens

## Stack

- Python
- Flask
- SQLite
- Vanilla HTML/CSS/JavaScript
- Docker
- GitHub Actions
- TrueNAS SCALE

## Local Development

### Requirements

- Python 3.11+
- pip

### Run locally

```powershell
git clone git@github.com:dbesada/Message-Hub.git
cd Message-Hub
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python server.py
```

Open:

- `http://localhost:3000/`
- `http://localhost:3000/hub`

### Environment variables

Common runtime settings:

- `PORT`
- `HOST`
- `DB_PATH`
- `RATE_LIMIT_RPS`
- `RATE_BURST`
- `SYNC_WORKERS`
- `VERIFY_WORKERS`

## Docker

Run with Docker Compose:

```powershell
cd Message-Hub
docker compose up --build -d
```

The compose file mounts persistent app data at:

- `/app/data`

## Deployment

This repo is set up for a GitHub-based release flow:

1. update the version metadata
2. commit and push
3. push a tag like `v1.12.2`
4. GitHub Actions builds and publishes the container image
5. TrueNAS can redeploy the app from GHCR

Relevant files:

- [`.github/workflows/container-ci.yml`](.github/workflows/container-ci.yml)
- [`.github/workflows/container-release.yml`](.github/workflows/container-release.yml)
- [`scripts/truenas-deploy.js`](scripts/truenas-deploy.js)
- [`scripts/release-version.ps1`](scripts/release-version.ps1)
- [`TRUENAS_CUSTOM_APP.md`](TRUENAS_CUSTOM_APP.md)

For Tailscale-hosted TrueNAS deploys, the release workflow supports:

- `TS_OIDC_CLIENT_ID`
- `TS_OIDC_AUDIENCE`
- `TS_OAUTH_CLIENT_ID`
- `TS_OAUTH_SECRET`
- optional repo variable `TAILSCALE_TAGS`
- optional repo variable `TAILSCALE_AUTH_MODE`
  - `auto` by default
  - `authkey` is preferred automatically when both auth methods exist
  - `oidc` uses Tailscale workload identity federation and GitHub's OpenID Connect token flow
  - `oauth` is available once your tailnet permits the tag you choose

`TAILSCALE_AUTHKEY` remains the safest compatibility path for unattended deploys. When you switch to OAuth, use a permitted lowercase tag such as `tag:codex`.

## Project Layout

- [`server.py`](server.py)
  - Flask backend, SQLite schema, connector registry, sync/ingest endpoints
- [`public/hub.html`](public/hub.html)
  - Message Hub UI shell
- [`public/hub.js`](public/hub.js)
  - connector and triage interactions
- [`public/index.html`](public/index.html)
  - original Quo operations UI
- [`public/app.js`](public/app.js)
  - legacy operations frontend logic

## Current Status

This repository is actively evolving from a Quo-specific manager into a broader, modular message operations hub.

Today, the codebase still contains both:

- older Quo-specific workflows
- newer connector-based Message Hub workflows

That is intentional for now while the newer hub replaces the older single-platform flow.

## Roadmap Direction

Near-term direction already reflected in the code and deployment work:

- continue expanding modular connectors
- keep credentials server-side
- improve unified inbox workflows
- make releases fully repeatable through GitHub Actions + Docker + TrueNAS
- keep Meta webhook intake verified and normalized so Facebook / Instagram DMs land in the same review queue as Gmail and Quo

## License

No license has been added yet. Treat the repository as proprietary until one is explicitly included.
