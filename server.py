"""Message Hub — Flask server with SQLite DB and connection-pooled API client"""
import base64
import contextlib
import html
import email as email_module
import imaplib
import json
import os
import re
import sqlite3
import threading
import time
import secrets
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import wraps
from datetime import datetime, timezone
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from urllib.parse import urlencode

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from flask import Flask, request, jsonify, send_from_directory, redirect

app = Flask(__name__, static_folder='public', static_url_path='')

QUO_BASE  = 'https://api.openphone.com/v1'
BASE_DIR = os.path.dirname(__file__)
VERSION_FILE = os.path.join(BASE_DIR, 'VERSION')
GMAIL_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
GMAIL_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'
GMAIL_OAUTH_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
HUB_OAUTH_STATE_TTL_SECONDS = 900
HUB_GMAIL_OAUTH_STATES = {}


def load_app_version():
    with contextlib.suppress(OSError):
        with open(VERSION_FILE, 'r', encoding='utf-8') as handle:
            version = handle.read().strip()
        if version:
            return version
    return '0.0.0'


DB_PATH   = os.environ.get('DB_PATH', os.path.join(BASE_DIR, 'quo_manager.db'))

# ── App version & changelog ───────────────────────────────────────────────────
APP_VERSION = load_app_version()
CHANGELOG = [
    {
        'version': '1.14.0',
        'date':    '2026-06-26',
        'features': [
            'Quo local sync now upgrades older connectors past the old 250-message cap so cached history is not cut off mid-month',
            'Gmail connectors now support Google login with server-side OAuth token storage and Gmail API sync, while keeping IMAP as a legacy fallback',
        ],
    },
    {
        'version': '1.13.0',
        'date':    '2026-06-26',
        'features': [
            'Connector cards and edit modals now show setup-readiness summaries so saved account details are easier to finish and verify',
            'Message Hub can now test saved Gmail and Quo connectors live, while Meta, TikTok, and webhook connectors report clear setup gaps before you wire platform-side settings',
        ],
    },
    {
        'version': '1.12.9',
        'date':    '2026-06-26',
        'features': [
            'GitHub Actions deploys now support Tailscale OpenID Connect via workload identity federation while keeping auth key fallback for safe rollout',
            'Deployment docs now call out the Tailscale OIDC client ID and audience values needed to replace long-lived GitHub secrets later',
        ],
    },
    {
        'version': '1.12.8',
        'date':    '2026-06-26',
        'features': [
            'TrueNAS release deploys now support an explicit Tailscale auth mode and default to the more compatible auth key path in auto mode',
            'OAuth-based Tailscale deploy guidance now calls out lowercase permitted tags such as tag:codex so GitHub Actions failures are easier to diagnose',
        ],
    },
    {
        'version': '1.12.7',
        'date':    '2026-06-26',
        'features': [
            'GitHub Actions now support current action majors, Tailscale OAuth clients, and smarter deploy prereq checks for tailnet-hosted TrueNAS boxes',
            'Meta connectors now handle Facebook and Instagram webhook verification plus inbound message normalization instead of treating every payload as a generic webhook',
            'Message Hub now surfaces real webhook callback URLs in the connector list so Meta setup is easier to finish from the app UI',
        ],
    },
    {
        'version': '1.12.6',
        'date':    '2026-06-25',
        'features': [
            'Fresh TrueNAS deployments now default to the Message Hub app and service identifiers instead of legacy quo-manager names',
            'TrueNAS deployment docs now distinguish the safe quo-manager upgrade path from the preferred message-hub default for new installs',
            'Windows service installs now default to MessageHub while still allowing QuoManager as an explicit compatibility override',
        ],
    },
    {
        'version': '1.12.5',
        'date':    '2026-06-25',
        'features': [
            'Updated public app metadata and manifest copy to better reflect Message Hub branding',
            'Release container now bundles the VERSION file so deployed health checks report the correct app version',
            'TrueNAS deployment helper now preserves existing live compose mounts correctly during first-cutover updates',
            'GitHub Actions release workflow now skips deploy steps safely when TrueNAS secrets are not configured',
        ],
    },
    {
        'version': '1.12.1',
        'date':    '2026-06-24',
        'features': [
            'Connector sync and ingest now route through a registry so new platforms can plug in without rewriting the hub',
            'Meta, TikTok, Quo, and custom webhook connectors continue to share the same saved server-side credential store',
        ],
    },
    {
        'version': '1.12.0',
        'date':    '2026-06-23',
        'features': [
            'Removed the app-wide login gate so the UI opens directly',
            'Saved Quo, Anthropic, and Vagaro credentials now live in server-side SQLite storage',
            'Webhook and sync flows can reuse stored API tokens without keeping them in browser localStorage',
        ],
    },
    {
        'version': '1.11.0',
        'date':    '2026-06-20',
        'features': [
            'Added modular connector setup for Gmail, Meta, TikTok, Quo, and custom webhooks',
            'Connector forms now support add/edit flows with per-platform fields and webhook paths',
            'Gmail IMAP and Quo local sync paths are wired in, with location tagging for Mississauga and Toronto',
        ],
    },
    {
        'version': '1.10.0',
        'date':    '2026-06-20',
        'features': [
            'Added a modular message hub with connectors for Gmail, Meta, TikTok, Quo, and custom sources',
            'Introduced a two-tag booking workflow for Mississauga and Toronto',
            'Local SQLite-backed hub state now tracks connectors, messages, and manual tag updates',
        ],
    },
    {
        'version': '1.9.6',
        'date':    '2026-06-06',
        'features': [
            'Mixed English/Arabic draft formatting controls for manual, AI prompt, and generated AI message editors',
            'Per-draft Auto/LTR/RTL direction buttons with automatic Arabic detection',
            'Improved textarea typography and alignment for bilingual SMS review',
        ],
    },
    {
        'version': '1.9.5',
        'date':    '2026-06-06',
        'features': [
            'Theme setting: follow system, dark, or light mode',
            'Added Message Hub app icon, favicon, and web app manifest',
            'Docker image metadata now identifies the app for hosts that read image labels',
        ],
    },
    {
        'version': '1.9.4',
        'date':    '2026-06-06',
        'features': [
            'AI bulk draft review can remove a contact after drafts are generated',
            'Each generated AI message has a send checkbox so only approved drafts are sent',
            'Bulk send button now counts only selected AI draft messages',
        ],
    },
    {
        'version': '1.9.3',
        'date':    '2026-06-06',
        'features': [
            'AI drafts now support multiple separate messages per contact',
            'Improved AI instructions so user wording, languages, and message count are followed more literally',
            'Bulk AI send can send multiple generated texts to each selected customer in sequence',
        ],
    },
    {
        'version': '1.9.2',
        'date':    '2026-06-06',
        'features': [
            'Improved bulk message editor with character/segment counters and draft status',
            'Autosave and restore manual bulk text plus AI prompt drafts',
            'Settings toggle for bulk draft autosave',
        ],
    },
    {
        'version': '1.9.1',
        'date':    '2026-06-06',
        'features': [
            'Fixed AI bulk draft failures when Claude returned truncated or imperfect JSON',
            'Reduced AI draft batch size and added per-contact fallback generation',
            'Improved AI JSON extraction/validation before showing drafts',
        ],
    },
    {
        'version': '1.9.0',
        'date':    '2026-06-05',
        'features': [
            'Expanded messaging API support: richer local message cache with from/to/user/status/raw payloads',
            'Message thread controls: refresh, load older messages, and inspect full Quo message details',
            'Send options for Quo inbox handling, including setInboxStatus=done',
            'Quo message webhook receiver for received/delivered message events',
            'Settings for message page size, local caching, and mark-sent-done behavior',
        ],
    },
    {
        'version': '1.8.5',
        'date':    '2026-06-05',
        'features': [
            'Contact quality buckets: Ready, Email-only, No phone, Phone-only, Unknown',
            'Sidebar quality filters keep email-only records out of the main working list by default',
            'Database cleanup can remove email-only local contacts in addition to Unknown contacts',
            'Cleanup audit now reports quality counts so the database is easier to understand',
        ],
    },
    {
        'version': '1.8.4',
        'date':    '2026-06-05',
        'features': [
            'More efficient sync: prunes stale local contacts that no longer appear in Quo',
            'Database cleanup can remove Unknown contacts from the local DB',
            'Settings panel now includes database cleanup audit and cleanup actions',
            'Cleanup reports duplicate groups after it runs',
        ],
    },
    {
        'version': '1.8.3',
        'date':    '2026-06-05',
        'features': [
            'Database cleanup audit for local orphaned cache rows and stale dismissed-duplicate records',
            'Safe cleanup endpoint removes only local DB orphans, not Quo contacts',
            'Duplicate scan now reports current duplicate groups after cleanup',
            'Fixed merge cleanup order so cached messages for deleted duplicate contacts are removed correctly',
        ],
    },
    {
        'version': '1.8.2',
        'date':    '2026-06-05',
        'features': [
            'Fixed Quo contact field parsing for phoneNumbers.value and emails.value',
            'Contacts with names stored in company now display by name instead of Unknown',
            'Added database reindex endpoint to repair already-synced contact rows without full API resync',
            'Improved frontend search/detail/duplicate views to use normalized phone and email fields',
        ],
    },
    {
        'version': '1.8.1',
        'date':    '2026-06-04',
        'features': [
            'Safer Quo API throttling: default lowered to 4 req/s to avoid 429 bursts',
            'Settings slider now supports 1–8 req/s with conservative defaults',
            'Retry behavior tuned to back off longer when Quo rate limits requests',
            'Rate-limit can be overridden with RATE_LIMIT_RPS for server/container deployments',
        ],
    },
    {
        'version': '1.8.0',
        'date':    '2026-06-03',
        'features': [
            'Settings panel — enable/disable features, tune sync, messaging, display, and AI',
            'Feature toggles: Vagaro Sync, Merge Duplicates, Verify Phones, AI Compose',
            'Live rate-limit slider updated on the server instantly',
            'Auto-sync age threshold configurable (1h / 6h / 24h / 1 week)',
            'Confirm-before-bulk-send safety dialog (toggleable)',
            'Claude model selector for AI Compose (Sonnet / Opus / Haiku)',
            'Contacts-per-page selector (25 / 50 / 75 / 100)',
        ],
    },
    {
        'version': '1.7.0',
        'date':    '2026-06-03',
        'features': [
            'Duplicate contact detection (by phone, email, and name)',
            'Side-by-side merge review — you verify every merge before it happens',
            'App version tracking and changelog',
        ],
    },
    {
        'version': '1.6.0',
        'date':    '2026-06-03',
        'features': [
            'Token-bucket rate limiter (9 req/s) — no more 429 errors',
            'Smart sync: skips enrichment for contacts already complete in list',
            'Verify Phones now runs server-side with 15 parallel workers',
            'Phone number shown prominently with click-to-copy in contact header',
            '⚠ warning badge on contacts missing a phone number',
        ],
    },
    {
        'version': '1.5.0',
        'date':    '2026-06-03',
        'features': [
            'Persistent SQLite database — contacts load instantly on relaunch',
            'Background sync via ThreadPoolExecutor (no UI blocking)',
            'Message thread caching — threads load from DB, refresh from API',
            '100-connection HTTP pool via requests.Session',
        ],
    },
    {
        'version': '1.4.0',
        'date':    '2026-06-02',
        'features': [
            'AI-powered personalized bulk messages (Claude API)',
            'Per-contact AI draft preview with edit-before-send',
            'Vagaro → Quo sync: CSV import + live webhook receiver',
            'Taskbar shortcut launcher (Brave app-mode, silent server start)',
        ],
    },
    {
        'version': '1.3.0',
        'date':    '2026-06-02',
        'features': [
            'Bulk messaging with tag-based filtering',
            'Tag filter chips in bulk view with contact counts',
            '↗ Quick bulk-message shortcut from sidebar tag filters',
        ],
    },
    {
        'version': '1.2.0',
        'date':    '2026-06-02',
        'features': [
            'Force Sync — fetches all pages + enriches every contact individually',
            'Two-phase sync: list stubs → enrich for full phone/email/tags',
            'Client-side search and tag filters across full contact dataset',
        ],
    },
    {
        'version': '1.1.0',
        'date':    '2026-06-02',
        'features': [
            'Contact management: create, edit, view with custom fields',
            'Message threads with send (Enter) and reply',
            'Multi-inbox selector',
            'Tag display on contacts and in detail view',
        ],
    },
    {
        'version': '1.0.0',
        'date':    '2026-06-02',
        'features': [
            'Initial release: Quo workspace connected via API key',
            'Contact list with search and pagination',
            'SMS message threads',
        ],
    },
]

# ── Rate limit: Quo API allows up to 10 req/sec per key ──────────────────────
# In practice, Quo can 429 on bursty sync/verify workloads well below 10/sec.
# Default to 4/sec with no burst; settings/env can tune this later.
RATE_LIMIT_RPS = float(os.environ.get('RATE_LIMIT_RPS', '4'))
RATE_BURST     = max(1, int(float(os.environ.get('RATE_BURST', RATE_LIMIT_RPS))))

# Workers only need to keep the bucket busy. Too many workers do not increase
# sustained throughput once the bucket is the bottleneck; they only add pressure.
SYNC_WORKERS   = int(os.environ.get('SYNC_WORKERS', '8'))
VERIFY_WORKERS = int(os.environ.get('VERIFY_WORKERS', '8'))

# ── Token-bucket rate limiter ─────────────────────────────────────────────────
class _TokenBucket:
    """Thread-safe token bucket. Call acquire() before every API request."""
    def __init__(self, rate: float, burst: int):
        self._rate   = rate
        self._burst  = burst
        self._tokens = float(burst)
        self._last   = time.monotonic()
        self._lock   = threading.Lock()

    def acquire(self):
        while True:
            with self._lock:
                now = time.monotonic()
                # Refill tokens proportional to elapsed time
                self._tokens = min(
                    self._burst,
                    self._tokens + (now - self._last) * self._rate
                )
                self._last = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return          # token granted — proceed immediately
                wait = (1.0 - self._tokens) / self._rate
            time.sleep(wait)        # sleep outside the lock

_bucket = _TokenBucket(rate=RATE_LIMIT_RPS, burst=RATE_BURST)

# ── Shared requests Session with connection pooling ───────────────────────────
_session = requests.Session()
_adapter = HTTPAdapter(
    pool_connections=100,
    pool_maxsize=100,
    max_retries=Retry(
        total=5,
        backoff_factor=1.5,
        status_forcelist=[429, 502, 503, 504],
        allowed_methods=["GET", "POST", "PATCH", "DELETE"],
        respect_retry_after_header=True,
    ),
)
_session.mount('https://', _adapter)
_session.headers.update({
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                   'AppleWebKit/537.36 (KHTML, like Gecko) '
                   'Chrome/125.0.0.0 Safari/537.36'),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
})

def quo_request(api_key: str, method: str, path: str,
                body: dict = None, params: dict = None):
    """Single Quo API call — rate-limited by token bucket, connection-pooled."""
    _bucket.acquire()           # wait here if we're at the rate limit
    url  = QUO_BASE + path
    resp = _session.request(
        method, url,
        params=params,
        json=body,
        headers={'Authorization': api_key},
        timeout=15,
    )
    try:
        return resp.json(), resp.status_code
    except Exception:
        return {'error': resp.text}, resp.status_code

# ── In-memory state ───────────────────────────────────────────────────────────
webhook_log = []
_vagaro_token_cache = {'token': None, 'expires': 0}

sync_state = {
    'running': False, 'phase': 'idle',
    'done': 0, 'total': 0, 'error': None,
}
verify_state = {
    'running': False, 'phase': 'idle',
    'done': 0, 'total': 0, 'fixed': 0, 'error': None,
}

# ── Database ──────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def _now_utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _credential_upsert(conn, key, value):
    value = '' if value is None else str(value).strip()
    if value:
        conn.execute(
            '''
            INSERT INTO app_credentials (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            ''',
            (key, value, _now_utc()),
        )
    else:
        conn.execute('DELETE FROM app_credentials WHERE key=?', (key,))


def _credential_get(conn, key, default=''):
    row = conn.execute('SELECT value FROM app_credentials WHERE key=?', (key,)).fetchone()
    if not row:
        return default
    value = row['value']
    return value if value is not None else default


def _credential_get_any(*keys, default=''):
    with get_db() as conn:
        for key in keys:
            value = _credential_get(conn, key, '')
            if value:
                return value
    return default


def _hub_connector_secret_key(connector_id, name):
    return f'hub_connector::{connector_id}::{name}'


def _hub_connector_secret_get(conn, connector_id, name, default=''):
    return _credential_get(conn, _hub_connector_secret_key(connector_id, name), default)


def _hub_connector_secret_set(conn, connector_id, name, value):
    _credential_upsert(conn, _hub_connector_secret_key(connector_id, name), value)


def _hub_prune_gmail_oauth_states():
    now = time.time()
    for state, payload in list(HUB_GMAIL_OAUTH_STATES.items()):
        if float(payload.get('expires_at') or 0) <= now:
            HUB_GMAIL_OAUTH_STATES.pop(state, None)


def _hub_issue_gmail_oauth_state(connector_id, return_to='/hub'):
    _hub_prune_gmail_oauth_states()
    state = secrets.token_urlsafe(24)
    HUB_GMAIL_OAUTH_STATES[state] = {
        'connector_id': connector_id,
        'return_to': return_to or '/hub',
        'expires_at': time.time() + HUB_OAUTH_STATE_TTL_SECONDS,
    }
    return state


def _hub_consume_gmail_oauth_state(state):
    _hub_prune_gmail_oauth_states()
    payload = HUB_GMAIL_OAUTH_STATES.pop(state, None)
    if not payload:
        return None
    if float(payload.get('expires_at') or 0) <= time.time():
        return None
    return payload


def _resolve_quo_api_key(body=None):
    body = body or {}
    for candidate in (body.get('apiKey'), body.get('quoKey')):
        value = str(candidate or '').strip()
        if value:
            return value
    header_value = str(request.headers.get('x-quo-api-key', '')).strip()
    if header_value:
        return header_value
    return _credential_get_any('quo_api_key')


def _resolve_vagaro_credentials(body=None):
    body = body or {}
    with get_db() as conn:
        client_id = str(body.get('clientId') or body.get('client_id') or '').strip() or _credential_get(conn, 'vagaro_client_id')
        client_secret = str(body.get('clientSecret') or body.get('client_secret') or '').strip() or _credential_get(conn, 'vagaro_client_secret')
        region = str(body.get('region') or '').strip() or _credential_get(conn, 'vagaro_region')
    return client_id, client_secret, region


def _resolve_anthropic_key(body=None):
    body = body or {}
    value = str(body.get('anthropicKey') or body.get('anthropic_key') or '').strip()
    if value:
        return value
    return _credential_get_any('anthropic_api_key')

def init_db():
    with get_db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS contacts (
                id          TEXT PRIMARY KEY,
                first_name  TEXT NOT NULL DEFAULT '',
                last_name   TEXT NOT NULL DEFAULT '',
                phone       TEXT NOT NULL DEFAULT '',
                email       TEXT NOT NULL DEFAULT '',
                company     TEXT NOT NULL DEFAULT '',
                role        TEXT NOT NULL DEFAULT '',
                tags        TEXT NOT NULL DEFAULT '[]',
                raw         TEXT NOT NULL DEFAULT '{}',
                quo_created TEXT,
                quo_updated TEXT,
                synced_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
            CREATE INDEX IF NOT EXISTS idx_contacts_name  ON contacts(first_name, last_name);

            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                contact_phone   TEXT NOT NULL DEFAULT '',
                phone_number_id TEXT NOT NULL DEFAULT '',
                direction       TEXT NOT NULL DEFAULT '',
                content         TEXT NOT NULL DEFAULT '',
                status          TEXT NOT NULL DEFAULT '',
                from_number     TEXT NOT NULL DEFAULT '',
                to_numbers      TEXT NOT NULL DEFAULT '[]',
                user_id         TEXT NOT NULL DEFAULT '',
                raw             TEXT NOT NULL DEFAULT '{}',
                msg_created     TEXT,
                msg_updated     TEXT,
                synced_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv
                ON messages(phone_number_id, contact_phone, msg_created);

            CREATE TABLE IF NOT EXISTS sync_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at    TEXT NOT NULL,
                completed_at  TEXT,
                contacts_done INTEGER DEFAULT 0,
                status        TEXT NOT NULL DEFAULT 'running',
                note          TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS app_credentials (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );

            -- Pairs the user has explicitly dismissed as "not duplicates"
            CREATE TABLE IF NOT EXISTS dismissed_duplicates (
                id1 TEXT NOT NULL,
                id2 TEXT NOT NULL,
                dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                PRIMARY KEY (id1, id2)
            );

            CREATE TABLE IF NOT EXISTS hub_connectors (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                kind         TEXT NOT NULL DEFAULT 'connector',
                enabled      INTEGER NOT NULL DEFAULT 1,
                status       TEXT NOT NULL DEFAULT 'idle',
                message_count INTEGER NOT NULL DEFAULT 0,
                last_sync    TEXT NOT NULL DEFAULT '',
                last_error   TEXT NOT NULL DEFAULT '',
                config       TEXT NOT NULL DEFAULT '{}',
                created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );

            CREATE TABLE IF NOT EXISTS hub_messages (
                id             TEXT PRIMARY KEY,
                connector_id   TEXT NOT NULL,
                source         TEXT NOT NULL DEFAULT '',
                sender         TEXT NOT NULL DEFAULT '',
                subject        TEXT NOT NULL DEFAULT '',
                preview        TEXT NOT NULL DEFAULT '',
                body           TEXT NOT NULL DEFAULT '',
                received_at    TEXT NOT NULL DEFAULT '',
                location_tag   TEXT NOT NULL DEFAULT '',
                location_reason TEXT NOT NULL DEFAULT '',
                status         TEXT NOT NULL DEFAULT 'needs_review',
                confidence     REAL NOT NULL DEFAULT 0,
                thread_id      TEXT NOT NULL DEFAULT '',
                raw            TEXT NOT NULL DEFAULT '{}',
                created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_hub_messages_connector ON hub_messages(connector_id);
            CREATE INDEX IF NOT EXISTS idx_hub_messages_location  ON hub_messages(location_tag);
            CREATE INDEX IF NOT EXISTS idx_hub_messages_status    ON hub_messages(status);

            CREATE TABLE IF NOT EXISTS hub_settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );
        ''')
        for col, spec in {
            'from_number': "TEXT NOT NULL DEFAULT ''",
            'to_numbers':  "TEXT NOT NULL DEFAULT '[]'",
            'user_id':     "TEXT NOT NULL DEFAULT ''",
            'raw':         "TEXT NOT NULL DEFAULT '{}'",
        }.items():
            try:
                conn.execute(f'ALTER TABLE messages ADD COLUMN {col} {spec}')
            except sqlite3.OperationalError as e:
                if 'duplicate column name' not in str(e).lower():
                    raise
        try:
            conn.execute('ALTER TABLE hub_connectors ADD COLUMN last_error TEXT NOT NULL DEFAULT \'\'')
        except sqlite3.OperationalError as e:
            if 'duplicate column name' not in str(e).lower():
                raise
    print(f'[db] Ready at {DB_PATH}')


HUB_LOCATION_TAGS = ('Mississauga', 'Toronto')
HUB_CONNECTOR_KIND_ALIASES = {
    'email': 'gmail',
    'sms': 'quo',
    'social': 'meta',
    'extensible': 'webhook',
}
HUB_CONNECTOR_KIND_DEFS = {
    'gmail': {
        'label': 'Gmail',
        'description': 'Pulls business inbox mail through Google login and the Gmail API, with IMAP left available as a legacy fallback.',
        'sync_supported': True,
        'ingest_supported': False,
        'default_config': {
            'transport': 'google_oauth',
            'mailbox': 'INBOX',
            'max_messages': 100,
        },
    },
    'quo': {
        'label': 'Quo',
        'description': 'Pulls the app’s local Quo message cache into the hub for booking triage.',
        'sync_supported': True,
        'ingest_supported': True,
        'default_config': {
            'mode': 'local_db',
            'limit': 0,
            'limit_locked': False,
        },
    },
    'meta': {
        'label': 'Meta',
        'description': 'Receives Facebook and Instagram message webhooks or API payloads.',
        'sync_supported': False,
        'ingest_supported': True,
        'default_config': {
            'mode': 'webhook',
            'channels': ['facebook', 'instagram'],
        },
    },
    'tiktok': {
        'label': 'TikTok',
        'description': 'Receives TikTok message webhooks or API payloads when your app is connected.',
        'sync_supported': False,
        'ingest_supported': True,
        'default_config': {
            'mode': 'webhook',
        },
    },
    'webhook': {
        'label': 'Custom webhook',
        'description': 'Generic intake for future platforms, automations, or forwarding rules.',
        'sync_supported': False,
        'ingest_supported': True,
        'default_config': {
            'mode': 'generic_webhook',
        },
    },
}

HUB_SAMPLE_CONNECTORS = [
    {
        'id': 'gmail',
        'name': 'Gmail',
        'kind': 'gmail',
        'enabled': 1,
        'status': 'connected',
        'message_count': 3,
        'last_sync': '2026-06-20T12:10:00Z',
        'config': {'transport': 'gmail_api', 'scope': 'business_inbox'},
    },
    {
        'id': 'meta',
        'name': 'Meta',
        'kind': 'meta',
        'enabled': 1,
        'status': 'connected',
        'message_count': 3,
        'last_sync': '2026-06-20T12:06:00Z',
        'config': {'transport': 'graph_api', 'channels': ['facebook', 'instagram']},
    },
    {
        'id': 'tiktok',
        'name': 'TikTok',
        'kind': 'tiktok',
        'enabled': 1,
        'status': 'connected',
        'message_count': 2,
        'last_sync': '2026-06-20T12:03:00Z',
        'config': {'transport': 'tiktok_messages', 'notes': 'Verify API access for your account type'},
    },
    {
        'id': 'quo',
        'name': 'Quo',
        'kind': 'quo',
        'enabled': 1,
        'status': 'connected',
        'message_count': 2,
        'last_sync': '2026-06-20T12:12:00Z',
        'config': {'transport': 'quo_webhook', 'inbox': 'main'},
    },
    {
        'id': 'webhook',
        'name': 'Custom webhook',
        'kind': 'webhook',
        'enabled': 0,
        'status': 'ready',
        'message_count': 0,
        'last_sync': '',
        'config': {'transport': 'generic_webhook', 'notes': 'Drop new sources in here later'},
    },
]

HUB_SAMPLE_MESSAGES = [
    {
        'id': 'hub-msg-001',
        'connector_id': 'gmail',
        'source': 'Gmail',
        'sender': 'Sofia M.',
        'subject': 'Booking for Toronto next week',
        'preview': 'Hi, can I book for downtown Toronto next Tuesday after 4pm?',
        'body': 'Hi, can I book for downtown Toronto next Tuesday after 4pm? I saw your service on Google and wanted to ask about availability.',
        'received_at': '2026-06-20T11:46:00Z',
        'location_tag': 'Toronto',
        'location_reason': 'Matched Toronto in the booking request',
        'status': 'needs_review',
        'confidence': 0.97,
        'thread_id': 'gmail-thread-001',
        'raw': {'channel': 'gmail', 'booking_location': 'Toronto'},
    },
    {
        'id': 'hub-msg-002',
        'connector_id': 'meta',
        'source': 'Instagram',
        'sender': '@kayla.rose',
        'subject': 'Mississauga appointment',
        'preview': 'Do you have anything available in Mississauga this Saturday morning?',
        'body': 'Do you have anything available in Mississauga this Saturday morning? I would like to book for myself and my sister.',
        'received_at': '2026-06-20T11:31:00Z',
        'location_tag': 'Mississauga',
        'location_reason': 'Matched Mississauga in the booking request',
        'status': 'needs_review',
        'confidence': 0.98,
        'thread_id': 'meta-thread-001',
        'raw': {'channel': 'instagram', 'booking_location': 'Mississauga'},
    },
    {
        'id': 'hub-msg-003',
        'connector_id': 'tiktok',
        'source': 'TikTok',
        'sender': 'Mina',
        'subject': 'Where can I book?',
        'preview': 'I am closer to Mississauga but can travel if Toronto is better for the appointment.',
        'body': 'I am closer to Mississauga but can travel if Toronto is better for the appointment. Please let me know which location has openings.',
        'received_at': '2026-06-20T11:18:00Z',
        'location_tag': 'Mississauga',
        'location_reason': 'Matched Mississauga mention first; manual review recommended',
        'status': 'needs_review',
        'confidence': 0.71,
        'thread_id': 'tiktok-thread-001',
        'raw': {'channel': 'tiktok', 'booking_location': 'Mississauga'},
    },
    {
        'id': 'hub-msg-004',
        'connector_id': 'quo',
        'source': 'Quo',
        'sender': 'J. Patel',
        'subject': 'Toronto booking update',
        'preview': 'Can I move my Toronto booking from 2pm to 5pm? ',
        'body': 'Can I move my Toronto booking from 2pm to 5pm? I am available later that day.',
        'received_at': '2026-06-20T11:05:00Z',
        'location_tag': 'Toronto',
        'location_reason': 'Matched Toronto in the reschedule request',
        'status': 'drafted',
        'confidence': 0.96,
        'thread_id': 'quo-thread-010',
        'raw': {'channel': 'quo', 'booking_location': 'Toronto'},
    },
    {
        'id': 'hub-msg-005',
        'connector_id': 'meta',
        'source': 'Facebook',
        'sender': 'Lena B.',
        'subject': 'Need help choosing',
        'preview': 'I am not sure whether I should book in Mississauga or Toronto.',
        'body': 'I am not sure whether I should book in Mississauga or Toronto. Which location has the earliest opening this week?',
        'received_at': '2026-06-20T10:54:00Z',
        'location_tag': '',
        'location_reason': 'Ambiguous location request',
        'status': 'needs_review',
        'confidence': 0.42,
        'thread_id': 'meta-thread-002',
        'raw': {'channel': 'facebook', 'booking_location': ''},
    },
    {
        'id': 'hub-msg-006',
        'connector_id': 'gmail',
        'source': 'Gmail',
        'sender': 'Olivia N.',
        'subject': 'Toronto first-time booking',
        'preview': 'Looking to book in Toronto next week for a consultation.',
        'body': 'Looking to book in Toronto next week for a consultation. Please send your earliest time slots.',
        'received_at': '2026-06-20T10:40:00Z',
        'location_tag': 'Toronto',
        'location_reason': 'Matched Toronto in the consultation request',
        'status': 'done',
        'confidence': 0.95,
        'thread_id': 'gmail-thread-002',
        'raw': {'channel': 'gmail', 'booking_location': 'Toronto'},
    },
    {
        'id': 'hub-msg-007',
        'connector_id': 'tiktok',
        'source': 'TikTok',
        'sender': 'Alyssa',
        'subject': 'Mississauga opening',
        'preview': 'I want to book in Mississauga if you have Friday afternoon.',
        'body': 'I want to book in Mississauga if you have Friday afternoon. I can leave work early.',
        'received_at': '2026-06-20T10:12:00Z',
        'location_tag': 'Mississauga',
        'location_reason': 'Matched Mississauga in the booking request',
        'status': 'needs_review',
        'confidence': 0.99,
        'thread_id': 'tiktok-thread-002',
        'raw': {'channel': 'tiktok', 'booking_location': 'Mississauga'},
    },
    {
        'id': 'hub-msg-008',
        'connector_id': 'quo',
        'source': 'Quo',
        'sender': 'Daniel C.',
        'subject': 'Quick question',
        'preview': 'Do you have a Mississauga appointment available this week?',
        'body': 'Do you have a Mississauga appointment available this week? I can come in anytime after 3pm.',
        'received_at': '2026-06-20T09:59:00Z',
        'location_tag': 'Mississauga',
        'location_reason': 'Matched Mississauga in the booking request',
        'status': 'done',
        'confidence': 0.98,
        'thread_id': 'quo-thread-011',
        'raw': {'channel': 'quo', 'booking_location': 'Mississauga'},
    },
]


def _json_load(text, fallback):
    try:
        value = json.loads(text or '')
        return value if value is not None else fallback
    except Exception:
        return fallback


def _json_dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _hub_now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _hub_profile(kind: str):
    canonical = _hub_canonical_connector_kind(kind)
    return HUB_CONNECTOR_KIND_DEFS.get(canonical, {
        'label': kind or 'Connector',
        'description': 'Generic connector',
        'sync_supported': False,
        'ingest_supported': False,
        'default_config': {},
    })


HUB_PRESERVE_ON_BLANK_CONFIG_KEYS = {
    'password',
    'api_key',
    'access_token',
    'verify_token',
    'webhook_secret',
}


def _hub_effective_gmail_transport(config):
    transport = str((config or {}).get('transport') or '').strip().lower()
    if transport in ('google_oauth', 'imap'):
        return transport
    if str((config or {}).get('username') or '').strip() or str((config or {}).get('password') or '').strip():
        return 'imap'
    return 'google_oauth'


def _hub_prepare_connector_config(conn, connector_id, kind, incoming_config, existing_config=None):
    profile = _hub_profile(kind)
    defaults = profile.get('default_config', {}) if isinstance(profile.get('default_config', {}), dict) else {}
    existing = existing_config if isinstance(existing_config, dict) else {}
    incoming = incoming_config if isinstance(incoming_config, dict) else {}
    merged = {**defaults, **existing}

    google_client_secret = str(incoming.get('google_client_secret') or '').strip()
    if google_client_secret:
        _hub_connector_secret_set(conn, connector_id, 'google_client_secret', google_client_secret)

    for key, value in incoming.items():
        if key == 'google_client_secret':
            continue
        if key in HUB_PRESERVE_ON_BLANK_CONFIG_KEYS and str(value or '').strip() == '':
            if existing.get(key):
                merged[key] = existing.get(key)
            continue
        merged[key] = value

    if kind == 'quo':
        try:
            merged['limit'] = int(merged.get('limit') or 0)
        except Exception:
            merged['limit'] = 0
        if 'limit' in incoming:
            merged['limit_locked'] = True
        elif 'limit_locked' not in merged:
            merged['limit_locked'] = False

    if kind == 'gmail':
        transport = _hub_effective_gmail_transport(merged)
        merged['transport'] = transport
        merged['mailbox'] = str(merged.get('mailbox') or 'INBOX').strip() or 'INBOX'
        try:
            merged['max_messages'] = max(1, min(500, int(merged.get('max_messages') or 100)))
        except Exception:
            merged['max_messages'] = 100
        google_client_id = str(merged.get('google_client_id') or '').strip()
        if google_client_id:
            merged['google_client_id'] = google_client_id
        else:
            merged.pop('google_client_id', None)
        merged.pop('google_client_secret', None)
        if transport == 'google_oauth':
            for key in ('host', 'port', 'ssl', 'username', 'password'):
                if key in merged and key not in incoming and key not in existing:
                    merged.pop(key, None)
        else:
            host = str(merged.get('host') or 'imap.gmail.com').strip() or 'imap.gmail.com'
            merged['host'] = host
            try:
                merged['port'] = int(merged.get('port') or 993)
            except Exception:
                merged['port'] = 993
            merged['ssl'] = bool(merged.get('ssl', True))

    return merged


HUB_CONNECTOR_SYNCERS = {}
HUB_CONNECTOR_INGESTERS = {}


def _hub_register_syncer(kind: str):
    def decorator(func):
        HUB_CONNECTOR_SYNCERS[kind] = func
        return func
    return decorator


def _hub_register_ingester(kind: str):
    def decorator(func):
        HUB_CONNECTOR_INGESTERS[kind] = func
        return func
    return decorator


def _hub_canonical_connector_kind(kind: str):
    value = (kind or '').strip().lower()
    return HUB_CONNECTOR_KIND_ALIASES.get(value, value)


def _hub_classify_location(text: str, raw: dict | None = None):
    blob = ' '.join([
        text or '',
        _field_value(raw or {}, 'booking_location', 'location', 'desired_location', 'desiredLocation'),
        _field_value(raw or {}, 'location_tag', 'locationTag'),
    ]).lower()
    if 'mississauga' in blob:
        reason = 'Matched Mississauga in message or metadata'
        if 'toronto' in blob:
            reason = 'Contains both locations; manual review recommended'
        return 'Mississauga', 0.96 if 'toronto' not in blob else 0.70, reason
    if 'toronto' in blob:
        return 'Toronto', 0.96, 'Matched Toronto in message or metadata'
    return '', 0.31, 'No explicit location match found'


def _hub_seed_if_needed(conn):
    connector_count = conn.execute('SELECT COUNT(*) AS n FROM hub_connectors').fetchone()['n']
    message_count = conn.execute('SELECT COUNT(*) AS n FROM hub_messages').fetchone()['n']
    if connector_count == 0:
        for item in HUB_SAMPLE_CONNECTORS:
            conn.execute(
                '''
                INSERT INTO hub_connectors (id, name, kind, enabled, status, message_count, last_sync, config, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    item['id'],
                    item['name'],
                    item['kind'],
                    item['enabled'],
                    item['status'],
                    item['message_count'],
                    item['last_sync'],
                    _json_dump(item.get('config', {})),
                    _hub_now(),
                ),
            )
    if message_count == 0:
        for item in HUB_SAMPLE_MESSAGES:
            conn.execute(
                '''
                INSERT INTO hub_messages (
                    id, connector_id, source, sender, subject, preview, body, received_at,
                    location_tag, location_reason, status, confidence, thread_id, raw, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    item['id'],
                    item['connector_id'],
                    item['source'],
                    item['sender'],
                    item['subject'],
                    item['preview'],
                    item['body'],
                    item['received_at'],
                    item['location_tag'],
                    item['location_reason'],
                    item['status'],
                    item['confidence'],
                    item['thread_id'],
                    _json_dump(item.get('raw', {})),
                    _hub_now(),
                ),
            )
    if connector_count == 0 or message_count == 0:
        for connector in HUB_SAMPLE_CONNECTORS:
            related = [m for m in HUB_SAMPLE_MESSAGES if m['connector_id'] == connector['id']]
            conn.execute(
                'UPDATE hub_connectors SET message_count=?, updated_at=? WHERE id=?',
                (len(related), _hub_now(), connector['id']),
            )


def _hub_decode_header(value):
    if not value:
        return ''
    parts = []
    for chunk, encoding in decode_header(value):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(encoding or 'utf-8', errors='replace'))
        else:
            parts.append(str(chunk))
    return ''.join(parts).strip()


def _hub_parse_datetime(value):
    if not value:
        return _hub_now()
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        return _hub_now()


def _hub_iso_from_timestamp(value):
    if value is None or value == '':
        return _hub_now()
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return _hub_now()
        if value.isdigit():
            value = int(value)
        else:
            return _hub_parse_datetime(value)
    if isinstance(value, (int, float)):
        try:
            timestamp = float(value)
            if timestamp > 1_000_000_000_000:
                timestamp /= 1000.0
            dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
            return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
        except Exception:
            return _hub_now()
    return _hub_now()


def _hub_strip_html(text):
    if not text:
        return ''
    text = re.sub(r'(?is)<(script|style).*?>.*?(</\1>)', ' ', text)
    text = re.sub(r'(?s)<[^>]+>', ' ', text)
    text = html.unescape(text) if hasattr(html, 'unescape') else text
    return re.sub(r'\s+', ' ', text).strip()


def _hub_extract_email_text(message):
    if not message:
        return ''
    texts = []
    html_texts = []
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_disposition() == 'attachment':
                continue
            content_type = part.get_content_type()
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or 'utf-8'
            try:
                text = payload.decode(charset, errors='replace')
            except Exception:
                text = payload.decode('utf-8', errors='replace')
            if content_type == 'text/plain':
                texts.append(text.strip())
            elif content_type == 'text/html':
                html_texts.append(_hub_strip_html(text))
    else:
        payload = message.get_payload(decode=True)
        if payload:
            charset = message.get_content_charset() or 'utf-8'
            try:
                text = payload.decode(charset, errors='replace')
            except Exception:
                text = payload.decode('utf-8', errors='replace')
            if message.get_content_type() == 'text/html':
                html_texts.append(_hub_strip_html(text))
            else:
                texts.append(text.strip())
    body = '\n'.join(texts).strip() or '\n'.join(html_texts).strip()
    return re.sub(r'\n{3,}', '\n\n', body).strip()


def _hub_gmail_redirect_uri():
    return request.url_root.rstrip('/') + '/hub/api/gmail/oauth/callback'


def _hub_gmail_decode_base64(value):
    data = str(value or '').strip()
    if not data:
        return ''
    padding = '=' * (-len(data) % 4)
    try:
        decoded = base64.urlsafe_b64decode((data + padding).encode('utf-8'))
        return decoded.decode('utf-8', errors='replace')
    except Exception:
        return ''


def _hub_gmail_extract_payload_text(payload):
    if not isinstance(payload, dict):
        return ''
    mime_type = str(payload.get('mimeType') or '').lower()
    body_data = ((payload.get('body') or {}) if isinstance(payload.get('body'), dict) else {}).get('data')
    text = _hub_gmail_decode_base64(body_data)
    parts = payload.get('parts') if isinstance(payload.get('parts'), list) else []
    plain_texts = []
    html_texts = []
    if text:
        if mime_type == 'text/html':
            html_texts.append(_hub_strip_html(text))
        elif mime_type.startswith('text/'):
            plain_texts.append(text.strip())
    for part in parts:
        nested = _hub_gmail_extract_payload_text(part)
        if not nested:
            continue
        nested_mime = str(part.get('mimeType') or '').lower()
        if nested_mime == 'text/html':
            html_texts.append(_hub_strip_html(nested))
        else:
            plain_texts.append(nested.strip())
    body = '\n'.join(item for item in plain_texts if item).strip()
    if body:
        return re.sub(r'\n{3,}', '\n\n', body).strip()
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(item for item in html_texts if item).strip()).strip()


def _hub_gmail_headers(payload):
    headers = {}
    for item in payload.get('headers') if isinstance(payload, dict) else []:
        name = str(item.get('name') or '').strip()
        if not name:
            continue
        headers[name.lower()] = _hub_decode_header(item.get('value') or '')
    return headers


def _hub_gmail_list_params(config, page_token=''):
    params = {
        'userId': 'me',
        'maxResults': max(1, min(500, int(config.get('max_messages') or 100))),
    }
    mailbox = str(config.get('mailbox') or 'INBOX').strip() or 'INBOX'
    mailbox_key = mailbox.upper()
    builtin = {
        'INBOX', 'SENT', 'SPAM', 'TRASH', 'IMPORTANT',
        'STARRED', 'UNREAD', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
        'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
    }
    if mailbox_key in builtin:
        params['labelIds'] = mailbox_key
    elif mailbox:
        params['q'] = f'label:{mailbox}'
    if page_token:
        params['pageToken'] = page_token
    return params


def _hub_gmail_api_json(method, path, access_token, params=None):
    response = _session.request(
        method,
        f'{GMAIL_API_BASE}{path}',
        params=params,
        headers={
            'Authorization': f'Bearer {access_token}',
            'Accept': 'application/json',
        },
        timeout=20,
    )
    data = {}
    with contextlib.suppress(Exception):
        data = response.json()
    if response.status_code >= 400:
        detail = ''
        if isinstance(data, dict):
            error_payload = data.get('error')
            if isinstance(error_payload, dict):
                detail = error_payload.get('message') or ''
            elif error_payload:
                detail = str(error_payload)
        raise ValueError(detail or f'Gmail API request failed with status {response.status_code}')
    return data if isinstance(data, dict) else {}


def _hub_gmail_refresh_access_token(conn, connector_id, config):
    client_id = str(config.get('google_client_id') or '').strip()
    client_secret = _hub_connector_secret_get(conn, connector_id, 'google_client_secret')
    refresh_token = _hub_connector_secret_get(conn, connector_id, 'google_refresh_token')
    if not client_id or not client_secret or not refresh_token:
        raise ValueError('Gmail Google login is not connected yet')
    response = requests.post(
        GMAIL_OAUTH_TOKEN_URL,
        data={
            'client_id': client_id,
            'client_secret': client_secret,
            'refresh_token': refresh_token,
            'grant_type': 'refresh_token',
        },
        timeout=20,
    )
    data = response.json() if response.content else {}
    if response.status_code >= 400:
        error_message = ''
        if isinstance(data, dict):
            error_message = data.get('error_description') or data.get('error') or ''
        raise ValueError(error_message or f'Unable to refresh Gmail access token ({response.status_code})')
    access_token = str((data or {}).get('access_token') or '').strip()
    if not access_token:
        raise ValueError('Gmail token refresh did not return an access token')
    return access_token


def _hub_gmail_finalize_oauth(conn, connector_id, config, token_data):
    refresh_token = str((token_data or {}).get('refresh_token') or '').strip()
    if refresh_token:
        _hub_connector_secret_set(conn, connector_id, 'google_refresh_token', refresh_token)
    access_token = str((token_data or {}).get('access_token') or '').strip()
    if not access_token:
        raise ValueError('Google did not return an access token')
    profile = _hub_gmail_api_json('GET', '/users/me/profile', access_token)
    email_address = str(profile.get('emailAddress') or '').strip()
    updated = dict(config)
    updated['transport'] = 'google_oauth'
    if email_address:
        updated['google_email'] = email_address
    updated['google_connected_at'] = _hub_now()
    return updated, email_address


def _hub_contact_name_from_raw(raw_contact):
    if not isinstance(raw_contact, dict):
        return ''
    default = raw_contact.get('defaultFields') or {}
    first = str(default.get('firstName') or '').strip()
    last = str(default.get('lastName') or '').strip()
    company = str(default.get('company') or '').strip()
    if first or last:
        return ' '.join(part for part in (first, last) if part)
    if company:
        return company
    return ''


def _hub_store_message(conn, message: dict):
    if not isinstance(message, dict):
        return False
    msg_id = str(message.get('id') or '').strip()
    connector_id = str(message.get('connector_id') or '').strip()
    if not msg_id or not connector_id:
        return False
    source = str(message.get('source') or connector_id).strip() or connector_id
    sender = str(message.get('sender') or '').strip()
    subject = str(message.get('subject') or '').strip()
    preview = str(message.get('preview') or '').strip()
    body = str(message.get('body') or '').strip()
    received_at = str(message.get('received_at') or _hub_now()).strip() or _hub_now()
    location_tag = str(message.get('location_tag') or '').strip()
    location_reason = str(message.get('location_reason') or '').strip()
    status = str(message.get('status') or 'needs_review').strip() or 'needs_review'
    try:
        confidence = float(message.get('confidence') or 0)
    except Exception:
        confidence = 0.0
    thread_id = str(message.get('thread_id') or '').strip()
    raw = message.get('raw') if isinstance(message.get('raw'), dict) else {}
    if not preview:
        preview = body[:180]
    conn.execute(
        '''
        INSERT INTO hub_messages (
            id, connector_id, source, sender, subject, preview, body, received_at,
            location_tag, location_reason, status, confidence, thread_id, raw, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            connector_id = excluded.connector_id,
            source = excluded.source,
            sender = excluded.sender,
            subject = excluded.subject,
            preview = excluded.preview,
            body = excluded.body,
            received_at = excluded.received_at,
            location_tag = CASE
                WHEN hub_messages.location_tag != '' THEN hub_messages.location_tag
                ELSE excluded.location_tag
            END,
            location_reason = CASE
                WHEN hub_messages.location_reason != '' THEN hub_messages.location_reason
                ELSE excluded.location_reason
            END,
            status = CASE
                WHEN hub_messages.status NOT IN ('', 'needs_review') THEN hub_messages.status
                ELSE excluded.status
            END,
            confidence = CASE
                WHEN hub_messages.confidence > 0 THEN hub_messages.confidence
                ELSE excluded.confidence
            END,
            thread_id = excluded.thread_id,
            raw = excluded.raw,
            updated_at = excluded.updated_at
        ''',
        (
            msg_id,
            connector_id,
            source,
            sender,
            subject,
            preview,
            body,
            received_at,
            location_tag,
            location_reason,
            status,
            confidence,
            thread_id,
            _json_dump(raw),
            _hub_now(),
        ),
    )
    return True


def _hub_touch_connector(conn, connector_id, **updates):
    fields = []
    params = []
    for key in ('status', 'last_sync', 'last_error', 'message_count', 'name', 'kind', 'enabled'):
        if key in updates and updates[key] is not None:
            fields.append(f'{key} = ?')
            params.append(updates[key])
    if 'config' in updates and updates['config'] is not None:
        fields.append('config = ?')
        params.append(_json_dump(updates['config']))
    if not fields:
        return
    fields.append('updated_at = ?')
    params.append(_hub_now())
    params.append(connector_id)
    conn.execute(f'UPDATE hub_connectors SET {", ".join(fields)} WHERE id = ?', params)


@_hub_register_syncer('quo')
def _hub_sync_quo_local(conn, connector):
    config = _json_load(connector['config'], {}) or {}
    try:
        limit = int(config.get('limit') or 0)
    except Exception:
        limit = 0
    # Older Quo connectors were seeded with a default cap of 250 messages.
    # If that cap was never explicitly set by the user, upgrade them to pull
    # the full cached history so older threads are not silently dropped.
    if limit == 250 and not bool(config.get('limit_locked')):
        limit = 0
    query = '''
        SELECT
            m.*, c.raw AS contact_raw
        FROM messages m
        LEFT JOIN contacts c ON c.phone = m.contact_phone
        ORDER BY COALESCE(m.msg_created, m.synced_at) DESC
    '''
    params = ()
    if limit > 0:
        query += '\nLIMIT ?'
        params = (limit,)
    rows = conn.execute(query, params).fetchall()
    inserted = 0
    for row in rows:
        raw_message = _json_load(row['raw'], {})
        raw_contact = _json_load(row['contact_raw'], {})
        sender = (
            _hub_contact_name_from_raw(raw_contact)
            or str(raw_message.get('sender') or raw_message.get('from') or row['contact_phone'] or row['from_number'] or '').strip()
            or row['contact_phone']
            or row['from_number']
            or 'Quo contact'
        )
        content = str(row['content'] or '').strip()
        body = content or str(raw_message.get('text') or raw_message.get('content') or '').strip()
        preview = body[:180]
        subject = 'Text message'
        if body:
            subject = body[:72] if len(body) <= 72 else f'{body[:69]}...'
        received_at = row['msg_created'] or row['synced_at'] or _hub_now()
        direction = str(row['direction'] or '').strip().lower()
        status = 'needs_review' if direction in ('in', 'inbound', 'incoming', '') else 'done'
        blob = ' '.join(filter(None, [subject, preview, body, sender]))
        location_tag, confidence, reason = _hub_classify_location(blob, raw_message)
        thread_id = ':'.join(filter(None, [row['phone_number_id'] or '', row['contact_phone'] or '']))
        message = {
            'id': f'quo-local:{row["id"]}',
            'connector_id': connector['id'],
            'source': 'Quo',
            'sender': sender,
            'subject': subject,
            'preview': preview,
            'body': body,
            'received_at': received_at,
            'location_tag': location_tag,
            'location_reason': reason,
            'status': status,
            'confidence': confidence,
            'thread_id': thread_id or f'quo-local:{row["id"]}',
            'raw': {
                'source': 'quo-local',
                'message': raw_message,
                'contact': raw_contact,
                'direction': row['direction'],
                'contact_phone': row['contact_phone'],
                'phone_number_id': row['phone_number_id'],
                'status': row['status'],
                'from_number': row['from_number'],
                'to_numbers': _json_load(row['to_numbers'], []),
                'user_id': row['user_id'],
                'msg_created': row['msg_created'],
                'msg_updated': row['msg_updated'],
            },
        }
        if _hub_store_message(conn, message):
            inserted += 1
    return inserted


@_hub_register_syncer('gmail')
def _hub_sync_gmail_imap(conn, connector):
    config = _json_load(connector['config'], {})
    transport = _hub_effective_gmail_transport(config)
    mailbox = str(config.get('mailbox') or 'INBOX').strip() or 'INBOX'
    max_messages = max(1, min(500, int(config.get('max_messages') or 100)))
    if transport == 'google_oauth':
        access_token = _hub_gmail_refresh_access_token(conn, connector['id'], config)
        inserted = 0
        seen = 0
        page_token = ''
        while True:
            listing = _hub_gmail_api_json('GET', '/users/me/messages', access_token, _hub_gmail_list_params(config, page_token))
            for item in listing.get('messages') or []:
                if seen >= max_messages:
                    break
                message_ref = _hub_gmail_api_json(
                    'GET',
                    f'/users/me/messages/{item.get("id")}',
                    access_token,
                    {'format': 'full'},
                )
                payload = message_ref.get('payload') if isinstance(message_ref, dict) else {}
                headers = _hub_gmail_headers(payload or {})
                subject = headers.get('subject') or 'Gmail message'
                sender_name, sender_addr = parseaddr(headers.get('from', ''))
                sender = sender_name or sender_addr or str(config.get('google_email') or 'Gmail sender')
                body = _hub_gmail_extract_payload_text(payload or {})
                preview = body[:180] or str(message_ref.get('snippet') or '')[:180] or subject[:180]
                received_at = _hub_parse_datetime(headers.get('date') or '')
                location_tag, confidence, reason = _hub_classify_location(' '.join([subject, sender, body]), {
                    'booking_location': body,
                    'source': 'gmail',
                })
                message_id = headers.get('message-id') or f'gmail:{connector["id"]}:{item.get("id")}'
                thread_id = message_ref.get('threadId') or message_id
                message = {
                    'id': f'gmail:{connector["id"]}:{item.get("id")}',
                    'connector_id': connector['id'],
                    'source': 'Gmail',
                    'sender': sender,
                    'subject': subject,
                    'preview': preview,
                    'body': body or preview,
                    'received_at': received_at,
                    'location_tag': location_tag,
                    'location_reason': reason,
                    'status': 'needs_review',
                    'confidence': confidence,
                    'thread_id': str(thread_id),
                    'raw': {
                        'source': 'gmail_api',
                        'gmail_id': item.get('id'),
                        'mailbox': mailbox,
                        'headers': headers,
                        'snippet': message_ref.get('snippet') or '',
                        'message_id': message_id,
                    },
                }
                if _hub_store_message(conn, message):
                    inserted += 1
                seen += 1
            if seen >= max_messages:
                break
            page_token = str(listing.get('nextPageToken') or '').strip()
            if not page_token:
                break
        return inserted

    host = str(config.get('host') or 'imap.gmail.com').strip()
    port = int(config.get('port') or 993)
    use_ssl = bool(config.get('ssl', True))
    username = str(config.get('username') or '').strip()
    password = str(config.get('password') or '').strip()
    if not username or not password:
        raise ValueError('Gmail connector requires either Google login or IMAP credentials')
    client = imaplib.IMAP4_SSL(host, port) if use_ssl else imaplib.IMAP4(host, port)
    try:
        client.login(username, password)
        typ, _ = client.select(mailbox)
        if typ != 'OK':
            raise ValueError(f'Unable to select mailbox {mailbox!r}')
        typ, data = client.uid('search', None, 'ALL')
        if typ != 'OK':
            raise ValueError('Unable to search Gmail mailbox')
        uids = [uid for uid in (data[0] or b'').split() if uid]
        if max_messages > 0:
            uids = uids[-max_messages:]
        inserted = 0
        for uid in uids:
            typ, fetched = client.uid('fetch', uid, '(RFC822)')
            if typ != 'OK' or not fetched:
                continue
            payload = fetched[0][1] if isinstance(fetched[0], tuple) and len(fetched[0]) > 1 else None
            if not payload:
                continue
            msg = email_module.message_from_bytes(payload)
            subject = _hub_decode_header(msg.get('Subject', ''))
            sender_name, sender_addr = parseaddr(msg.get('From', ''))
            sender = sender_name or sender_addr or username
            body = _hub_extract_email_text(msg)
            preview = body[:180] or subject[:180]
            received_at = _hub_parse_datetime(msg.get('Date', ''))
            location_tag, confidence, reason = _hub_classify_location(' '.join([subject, sender, body]), {
                'booking_location': body,
                'source': 'gmail',
            })
            message_id = msg.get('Message-ID') or f'gmail:{connector["id"]}:{uid.decode(errors="ignore")}'
            thread_id = msg.get('Thread-Id') or msg.get('X-GM-THRID') or message_id
            message = {
                'id': f'gmail:{connector["id"]}:{uid.decode(errors="ignore")}',
                'connector_id': connector['id'],
                'source': 'Gmail',
                'sender': sender,
                'subject': subject or 'Gmail message',
                'preview': preview,
                'body': body or preview,
                'received_at': received_at,
                'location_tag': location_tag,
                'location_reason': reason,
                'status': 'needs_review',
                'confidence': confidence,
                'thread_id': str(thread_id),
                'raw': {
                    'source': 'gmail_imap',
                    'uid': uid.decode(errors='ignore'),
                    'mailbox': mailbox,
                    'headers': {k: _hub_decode_header(v) for k, v in msg.items()},
                    'message_id': message_id,
                },
            }
            if _hub_store_message(conn, message):
                inserted += 1
        return inserted
    finally:
        with contextlib.suppress(Exception):
            client.logout()


def _hub_sync_connector(conn, connector_id):
    row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
    if not row:
        raise KeyError(connector_id)
    connector = _hub_connector_row(row)
    kind = _hub_canonical_connector_kind(connector.get('kind') or '')
    profile = _hub_profile(kind)
    if not profile.get('sync_supported'):
        raise ValueError(f'{connector["name"]} is set up as a {kind or "custom"} connector and currently uses webhook ingest only')

    _hub_touch_connector(conn, connector_id, status='syncing', last_error='')
    inserted = 0
    try:
        syncer = HUB_CONNECTOR_SYNCERS.get(kind)
        if not syncer:
            available = ', '.join(sorted(HUB_CONNECTOR_SYNCERS)) or 'none'
            raise ValueError(f'No sync adapter registered for connector kind {kind!r}. Available adapters: {available}')
        inserted = syncer(conn, connector)
        _hub_recount_connectors(conn)
        _hub_touch_connector(
            conn,
            connector_id,
            status='connected',
            last_sync=_hub_now(),
            last_error='',
        )
        return inserted
    except Exception as exc:
        _hub_touch_connector(
            conn,
            connector_id,
            status='error',
            last_error=str(exc),
            last_sync=_hub_now(),
        )
        raise


def _hub_meta_channel(payload, entry, event):
    object_kind = str(payload.get('object') or '').strip().lower()
    messaging_product = str(
        event.get('messaging_product')
        or entry.get('messaging_product')
        or ''
    ).strip().lower()
    if object_kind == 'instagram' or messaging_product == 'instagram':
        return 'Instagram'
    if object_kind in ('page', 'facebook') or messaging_product in ('messenger', 'facebook'):
        return 'Facebook'
    return 'Meta'


def _hub_meta_attachment_summary(attachments):
    parts = []
    for attachment in attachments[:3]:
        if not isinstance(attachment, dict):
            continue
        kind = str(attachment.get('type') or 'attachment').strip().lower() or 'attachment'
        payload = attachment.get('payload') if isinstance(attachment.get('payload'), dict) else {}
        title = str(payload.get('title') or payload.get('url') or '').strip()
        label = kind.replace('_', ' ').title()
        parts.append(f'{label}: {title}' if title else label)
    remaining = max(len(attachments) - len(parts), 0)
    if remaining:
        parts.append(f'+{remaining} more attachment{"s" if remaining != 1 else ""}')
    return '; '.join(parts)


def _hub_verify_meta_webhook(conn, connector):
    mode = str(request.args.get('hub.mode') or '').strip()
    challenge = str(request.args.get('hub.challenge') or '').strip()
    verify_token = str(request.args.get('hub.verify_token') or '').strip()
    expected_token = str((connector.get('config') or {}).get('verify_token') or '').strip()
    if mode != 'subscribe':
        raise ValueError('Meta webhook verification requires hub.mode=subscribe')
    if not expected_token:
        raise ValueError('Meta connector is missing a webhook verify token')
    if verify_token != expected_token:
        raise ValueError('Meta webhook verify token did not match the connector configuration')
    _hub_touch_connector(
        conn,
        connector['id'],
        status='connected',
        last_sync=_hub_now(),
        last_error='',
    )
    return challenge


@_hub_register_ingester('meta')
def _hub_ingest_meta(conn, connector, payload):
    if not isinstance(payload, dict):
        raise ValueError('Payload must be a JSON object')
    entries = payload.get('entry')
    if not isinstance(entries, list) or not entries:
        return _hub_ingest_payload(conn, connector, payload)

    inserted = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for event in entry.get('messaging') or []:
            if not isinstance(event, dict):
                continue
            message_data = event.get('message') if isinstance(event.get('message'), dict) else {}
            if message_data.get('is_echo'):
                continue

            sender_id = str((event.get('sender') or {}).get('id') or '').strip()
            recipient_id = str((event.get('recipient') or {}).get('id') or '').strip()
            channel = _hub_meta_channel(payload, entry, event)

            text = str(message_data.get('text') or '').strip()
            attachments = message_data.get('attachments') if isinstance(message_data.get('attachments'), list) else []
            attachment_summary = _hub_meta_attachment_summary(attachments)
            postback = event.get('postback') if isinstance(event.get('postback'), dict) else {}
            postback_title = str(postback.get('title') or '').strip()
            postback_payload = str(postback.get('payload') or '').strip()
            referral = event.get('referral') if isinstance(event.get('referral'), dict) else {}
            referral_text = str(referral.get('ref') or referral.get('source') or '').strip()

            body_parts = []
            if text:
                body_parts.append(text)
            if attachment_summary:
                body_parts.append(attachment_summary)
            if postback_title or postback_payload:
                body_parts.append(f'Postback: {postback_title or postback_payload}')
            if referral_text:
                body_parts.append(f'Referral: {referral_text}')

            body = ' '.join(part for part in body_parts if part).strip()
            if not body:
                continue

            timestamp = _hub_iso_from_timestamp(event.get('timestamp') or entry.get('time'))
            raw = {
                'source': 'meta',
                'channel': channel.lower(),
                'object': str(payload.get('object') or '').strip(),
                'entry_id': str(entry.get('id') or '').strip(),
                'sender_id': sender_id,
                'recipient_id': recipient_id,
                'event': event,
            }
            location_tag, confidence, reason = _hub_classify_location(
                ' '.join(filter(None, [channel, sender_id, body])),
                raw,
            )
            message_id = (
                str(message_data.get('mid') or '').strip()
                or str(postback.get('mid') or '').strip()
                or f'meta:{connector["id"]}:{sender_id or "unknown"}:{int(time.time() * 1000)}'
            )
            normalized = {
                'id': message_id,
                'connector_id': connector['id'],
                'source': channel,
                'sender': sender_id or channel,
                'subject': f'{channel} message',
                'preview': body[:180],
                'body': body,
                'received_at': timestamp,
                'location_tag': location_tag,
                'location_reason': reason,
                'status': 'needs_review',
                'confidence': confidence,
                'thread_id': sender_id or message_id,
                'raw': raw,
            }
            if _hub_store_message(conn, normalized):
                inserted += 1
    return inserted


@_hub_register_ingester('quo')
@_hub_register_ingester('tiktok')
@_hub_register_ingester('webhook')
def _hub_generic_ingest(conn, connector, payload):
    return _hub_ingest_payload(conn, connector, payload)


def _hub_ingest_payload(conn, connector, payload):
    if not isinstance(payload, dict):
        raise ValueError('Payload must be a JSON object')
    body = payload.get('body') or payload.get('text') or payload.get('message') or payload.get('content') or ''
    if isinstance(payload.get('data'), dict):
        inner = payload['data']
    else:
        inner = payload
    sender = (
        payload.get('sender')
        or inner.get('sender')
        or inner.get('from')
        or inner.get('username')
        or inner.get('profile_name')
        or connector['name']
    )
    subject = payload.get('subject') or inner.get('subject') or payload.get('type') or 'Incoming message'
    received_at = (
        payload.get('received_at')
        or payload.get('timestamp')
        or inner.get('timestamp')
        or _hub_now()
    )
    received_at = _hub_parse_datetime(received_at) if isinstance(received_at, str) else _hub_now()
    blob = ' '.join(filter(None, [subject, body, str(payload.get('caption') or ''), str(payload.get('booking_location') or '')]))
    location_tag, confidence, reason = _hub_classify_location(blob, payload)
    message = {
        'id': str(payload.get('id') or inner.get('id') or f'{connector["id"]}:{int(time.time() * 1000)}'),
        'connector_id': connector['id'],
        'source': connector['name'],
        'sender': str(sender).strip() or connector['name'],
        'subject': str(subject).strip() or 'Incoming message',
        'preview': str(body).strip()[:180],
        'body': str(body).strip() or str(subject).strip(),
        'received_at': received_at,
        'location_tag': location_tag,
        'location_reason': reason,
        'status': str(payload.get('status') or 'needs_review').strip() or 'needs_review',
        'confidence': confidence,
        'thread_id': str(payload.get('thread_id') or inner.get('thread_id') or payload.get('conversation_id') or ''),
        'raw': payload,
    }
    return _hub_store_message(conn, message)


def _hub_mask_secret(value, tail=4):
    text = str(value or '').strip()
    if not text:
        return ''
    if len(text) <= tail:
        return '•' * len(text)
    return f'{"•" * max(4, len(text) - tail)}{text[-tail:]}'


def _hub_describe_connector_setup(connector):
    kind = _hub_canonical_connector_kind(connector.get('kind') or '')
    config = connector.get('config') if isinstance(connector.get('config'), dict) else {}
    details = []
    missing = []

    if kind == 'gmail':
        transport = _hub_effective_gmail_transport(config)
        mailbox = str(config.get('mailbox') or 'INBOX').strip() or 'INBOX'
        max_messages = max(1, min(500, int(config.get('max_messages') or 100)))
        details.append(f'Mailbox: {mailbox}')
        details.append(f'Max messages per sync: {max_messages}')
        if transport == 'google_oauth':
            google_client_id = str(config.get('google_client_id') or '').strip()
            google_email = str(config.get('google_email') or '').strip()
            with get_db() as secrets_conn:
                client_secret_saved = bool(_hub_connector_secret_get(secrets_conn, connector.get('id', ''), 'google_client_secret'))
                refresh_saved = bool(_hub_connector_secret_get(secrets_conn, connector.get('id', ''), 'google_refresh_token'))
            details.append('Connection mode: Google login')
            if google_client_id:
                details.append(f'Google client ID saved: {google_client_id}')
            else:
                missing.append('Google client ID')
            if client_secret_saved:
                details.append('Google client secret saved on the server')
            else:
                missing.append('Google client secret')
            if google_email:
                details.append(f'Connected Google account: {google_email}')
            if refresh_saved:
                details.append('Google refresh token saved on the server')
                summary = 'Ready for Gmail API sync'
                readiness = 'ready'
            else:
                summary = 'Save the OAuth client, then connect this Gmail account with Google login'
                readiness = 'needs_setup' if missing else 'action_required'
        else:
            username = str(config.get('username') or '').strip()
            password = str(config.get('password') or '').strip()
            host = str(config.get('host') or 'imap.gmail.com').strip() or 'imap.gmail.com'
            if username:
                details.append(f'Username saved: {username}')
            else:
                missing.append('Gmail username')
            if password:
                details.append(f'App password saved: {_hub_mask_secret(password)}')
            else:
                missing.append('Gmail app password')
            details.append(f'Host: {host}:{int(config.get("port") or 993)}')
            if missing:
                summary = f'Missing {", ".join(missing)}'
                readiness = 'needs_setup'
            else:
                summary = 'Ready for a live IMAP login test'
                readiness = 'ready'
    elif kind == 'quo':
        mode = str(config.get('mode') or 'local_db').strip() or 'local_db'
        limit = int(config.get('limit') or 0)
        details.append(f'Mode: {mode}')
        details.append(f'Import limit: {"All cached messages" if limit <= 0 else limit}')
        if mode == 'api':
            api_key = str(config.get('api_key') or _credential_get_any('quo_api_key')).strip()
            if api_key:
                details.append(f'API key available: {_hub_mask_secret(api_key)}')
                summary = 'Ready for a live Quo API test'
                readiness = 'ready'
            else:
                summary = 'Missing Quo API key for API mode'
                readiness = 'needs_setup'
        else:
            details.append(f'Local database path: {DB_PATH}')
            summary = 'Ready to verify the local Quo cache'
            readiness = 'ready'
    elif kind == 'meta':
        channels = config.get('channels') if isinstance(config.get('channels'), list) else []
        verify_token = str(config.get('verify_token') or '').strip()
        access_token = str(config.get('access_token') or '').strip()
        page_id = str(config.get('page_id') or '').strip()
        instagram_id = str(config.get('instagram_id') or '').strip()
        if channels:
            details.append(f'Channels: {", ".join(channels)}')
        else:
            missing.append('at least one channel')
        if verify_token:
            details.append(f'Webhook verify token saved: {_hub_mask_secret(verify_token)}')
        else:
            missing.append('Meta webhook verify token')
        if page_id:
            details.append(f'Facebook page ID saved: {page_id}')
        if instagram_id:
            details.append(f'Instagram ID saved: {instagram_id}')
        if access_token:
            details.append(f'Access token saved: {_hub_mask_secret(access_token)}')
        if missing:
            summary = f'Missing {", ".join(missing)}'
            readiness = 'needs_setup'
        else:
            summary = 'Ready for Meta webhook verification'
            readiness = 'ready'
    elif kind == 'tiktok':
        access_token = str(config.get('access_token') or '').strip()
        app_id = str(config.get('app_id') or '').strip()
        webhook_secret = str(config.get('webhook_secret') or '').strip()
        if access_token:
            details.append(f'Access token saved: {_hub_mask_secret(access_token)}')
        if app_id:
            details.append(f'App ID saved: {app_id}')
        if webhook_secret:
            details.append(f'Webhook secret saved: {_hub_mask_secret(webhook_secret)}')
        if access_token or webhook_secret:
            summary = 'Core TikTok connector settings are saved'
            readiness = 'ready'
        else:
            summary = 'Add a TikTok access token or webhook secret'
            readiness = 'needs_setup'
    else:
        webhook_secret = str(config.get('webhook_secret') or '').strip()
        target_url = str(config.get('target_url') or '').strip()
        details.append('Webhook endpoint is available after saving this connector')
        if target_url:
            details.append(f'Expected source: {target_url}')
        if webhook_secret:
            details.append(f'Shared secret saved: {_hub_mask_secret(webhook_secret)}')
        summary = 'Ready to receive forwarded payloads'
        readiness = 'ready'

    return {
        'summary': summary,
        'details': details,
        'missing': missing,
        'readiness': readiness,
    }


def _hub_validate_connector(conn, connector):
    kind = _hub_canonical_connector_kind(connector.get('kind') or '')
    config = connector.get('config') if isinstance(connector.get('config'), dict) else {}
    setup = _hub_describe_connector_setup(connector)
    if setup['readiness'] not in ('ready',):
        _hub_touch_connector(
            conn,
            connector['id'],
            status='needs_setup',
            last_error=setup['summary'],
            last_sync=_hub_now(),
        )
        return {
            'ok': False,
            'mode': 'configuration',
            'status': 'needs_setup',
            'summary': setup['summary'],
            'details': setup['details'],
            'missing': setup['missing'],
        }

    if kind == 'gmail':
        mailbox = str(config.get('mailbox') or 'INBOX').strip() or 'INBOX'
        if _hub_effective_gmail_transport(config) == 'google_oauth':
            access_token = _hub_gmail_refresh_access_token(conn, connector['id'], config)
            profile = _hub_gmail_api_json('GET', '/users/me/profile', access_token)
            email_address = str(profile.get('emailAddress') or '').strip()
            listing = _hub_gmail_api_json('GET', '/users/me/messages', access_token, _hub_gmail_list_params(config))
            visible_count = len(listing.get('messages') or [])
            updated_config = dict(config)
            if email_address:
                updated_config['google_email'] = email_address
            updated_config['google_connected_at'] = updated_config.get('google_connected_at') or _hub_now()
            _hub_touch_connector(
                conn,
                connector['id'],
                status='connected',
                last_error='',
                last_sync=_hub_now(),
                config=updated_config,
            )
            return {
                'ok': True,
                'mode': 'live',
                'status': 'connected',
                'summary': f'Connected to Gmail as {email_address or "your Google account"}',
                'details': [
                    f'Google account: {email_address or "Connected"}',
                    f'Mailbox query: {mailbox}',
                    f'Fetched {visible_count} Gmail message reference(s) during the test',
                ],
                'missing': [],
            }

        host = str(config.get('host') or 'imap.gmail.com').strip() or 'imap.gmail.com'
        port = int(config.get('port') or 993)
        username = str(config.get('username') or '').strip()
        password = str(config.get('password') or '').strip()
        use_ssl = config.get('ssl', True) is not False
        client = None
        try:
            client = imaplib.IMAP4_SSL(host, port) if use_ssl else imaplib.IMAP4(host, port)
            login_response = client.login(username, password)
            select_status, select_data = client.select(mailbox, readonly=True)
            if select_status != 'OK':
                raise ValueError(f'Unable to open mailbox {mailbox}: {select_data!r}')
            message_count = 0
            if select_data and select_data[0]:
                with contextlib.suppress(Exception):
                    message_count = int(select_data[0])
            details = [
                f'Logged in as {username}',
                f'Mailbox opened: {mailbox}',
                f'Current message count reported by IMAP: {message_count}',
            ]
            if login_response:
                details.append('IMAP login succeeded')
            _hub_touch_connector(
                conn,
                connector['id'],
                status='connected',
                last_error='',
                last_sync=_hub_now(),
            )
            return {
                'ok': True,
                'mode': 'live',
                'status': 'connected',
                'summary': f'Connected to Gmail mailbox {mailbox}',
                'details': details,
                'missing': [],
            }
        finally:
            with contextlib.suppress(Exception):
                if client is not None:
                    client.logout()

    if kind == 'quo':
        mode = str(config.get('mode') or 'local_db').strip() or 'local_db'
        if mode == 'api':
            api_key = str(config.get('api_key') or _credential_get_any('quo_api_key')).strip()
            response_body, status_code = quo_request(api_key, 'GET', '/contacts', params={'limit': 1})
            if status_code not in (200, 201):
                error_message = f'Quo API returned {status_code}'
                if isinstance(response_body, dict) and response_body.get('error'):
                    error_message = f'{error_message}: {response_body["error"]}'
                _hub_touch_connector(
                    conn,
                    connector['id'],
                    status='error',
                    last_error=error_message,
                    last_sync=_hub_now(),
                )
                return {
                    'ok': False,
                    'mode': 'live',
                    'status': 'error',
                    'summary': error_message,
                    'details': setup['details'],
                    'missing': [],
                }
            count = len((response_body or {}).get('data') or [])
            _hub_touch_connector(
                conn,
                connector['id'],
                status='connected',
                last_error='',
                last_sync=_hub_now(),
            )
            return {
                'ok': True,
                'mode': 'live',
                'status': 'connected',
                'summary': 'Connected to the Quo API',
                'details': setup['details'] + [f'Fetched {count} contact record(s) from Quo during the test'],
                'missing': [],
            }

        tables = {row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        missing_tables = [name for name in ('messages', 'contacts') if name not in tables]
        if missing_tables:
            summary = f'Local Quo cache is missing table(s): {", ".join(missing_tables)}'
            _hub_touch_connector(
                conn,
                connector['id'],
                status='error',
                last_error=summary,
                last_sync=_hub_now(),
            )
            return {
                'ok': False,
                'mode': 'local',
                'status': 'error',
                'summary': summary,
                'details': setup['details'],
                'missing': missing_tables,
            }
        message_rows = conn.execute('SELECT COUNT(*) AS n FROM messages').fetchone()['n']
        contact_rows = conn.execute('SELECT COUNT(*) AS n FROM contacts').fetchone()['n']
        _hub_touch_connector(
            conn,
            connector['id'],
            status='connected',
            last_error='',
            last_sync=_hub_now(),
        )
        return {
            'ok': True,
            'mode': 'local',
            'status': 'connected',
            'summary': 'Local Quo cache is available',
            'details': setup['details'] + [
                f'Cached Quo contacts: {contact_rows}',
                f'Cached Quo messages: {message_rows}',
            ],
            'missing': [],
        }

    _hub_touch_connector(
        conn,
        connector['id'],
        status='ready',
        last_error='',
        last_sync=_hub_now(),
    )
    summary = setup['summary']
    if kind == 'meta':
        summary = 'Meta connector is configured for webhook setup'
    elif kind == 'tiktok':
        summary = 'TikTok connector settings are saved and ready for portal-side hookup'
    elif kind == 'webhook':
        summary = 'Webhook connector is ready to receive forwarded payloads'
    return {
        'ok': True,
        'mode': 'configuration',
        'status': 'ready',
        'summary': summary,
        'details': setup['details'],
        'missing': [],
    }


def _hub_connector_row(row):
    config = _json_load(row['config'], {})
    kind = _hub_canonical_connector_kind(row['kind'])
    profile = _hub_profile(kind)
    connector = {
        'id': row['id'],
        'name': row['name'],
        'kind': kind,
        'enabled': bool(row['enabled']),
        'status': row['status'],
        'message_count': row['message_count'],
        'last_sync': row['last_sync'],
        'last_error': row['last_error'] if 'last_error' in row.keys() else '',
        'config': config if isinstance(config, dict) else {},
        'updated_at': row['updated_at'],
        'sync_supported': bool(profile.get('sync_supported')),
        'ingest_supported': bool(profile.get('ingest_supported')),
        'description': profile.get('description', ''),
        'label': profile.get('label', row['kind']),
        'webhook_path': f'/hub/api/connectors/{row["id"]}/ingest',
        'default_config': profile.get('default_config', {}),
    }
    connector['setup'] = _hub_describe_connector_setup(connector)
    connector['test_supported'] = True
    return connector


def _hub_message_row(row):
    raw = _json_load(row['raw'], {})
    return {
        'id': row['id'],
        'connector_id': row['connector_id'],
        'source': row['source'],
        'sender': row['sender'],
        'subject': row['subject'],
        'preview': row['preview'],
        'body': row['body'],
        'received_at': row['received_at'],
        'location_tag': row['location_tag'],
        'location_reason': row['location_reason'],
        'status': row['status'],
        'confidence': row['confidence'],
        'thread_id': row['thread_id'],
        'raw': raw if isinstance(raw, dict) else {},
        'updated_at': row['updated_at'],
    }


def _hub_summary(messages):
    summary = {
        'total': len(messages),
        'needs_review': 0,
        'drafted': 0,
        'done': 0,
        'mississauga': 0,
        'toronto': 0,
        'unclear': 0,
    }
    for message in messages:
        status = message.get('status', '')
        tag = message.get('location_tag', '')
        if status in summary:
            summary[status] += 1
        elif status == 'needs_review':
            summary['needs_review'] += 1
        if tag == 'Mississauga':
            summary['mississauga'] += 1
        elif tag == 'Toronto':
            summary['toronto'] += 1
        else:
            summary['unclear'] += 1
    return summary


def _hub_fetch_state(conn, connector_id='', location_tag='', status='', search=''):
    query = 'SELECT * FROM hub_messages'
    clauses = []
    params = []
    if connector_id:
        clauses.append('connector_id = ?')
        params.append(connector_id)
    if location_tag:
        if location_tag == 'Unclear':
            clauses.append("(location_tag = '' OR location_tag IS NULL)")
        else:
            clauses.append('location_tag = ?')
            params.append(location_tag)
    if status:
        clauses.append('status = ?')
        params.append(status)
    if clauses:
        query += ' WHERE ' + ' AND '.join(clauses)
    query += ' ORDER BY received_at DESC, updated_at DESC'
    rows = conn.execute(query, params).fetchall()
    messages = [_hub_message_row(row) for row in rows]
    if search:
        needle = search.lower()
        messages = [
            m for m in messages if needle in ' '.join([
                m.get('source', ''),
                m.get('sender', ''),
                m.get('subject', ''),
                m.get('preview', ''),
                m.get('body', ''),
                m.get('location_tag', ''),
                m.get('status', ''),
            ]).lower()
        ]
    return messages


def _hub_recount_connectors(conn):
    counts = {
        row['connector_id']: row['n']
        for row in conn.execute(
            'SELECT connector_id, COUNT(*) AS n FROM hub_messages GROUP BY connector_id'
        ).fetchall()
    }
    now = _hub_now()
    rows = conn.execute('SELECT id FROM hub_connectors').fetchall()
    for row in rows:
        conn.execute(
            'UPDATE hub_connectors SET message_count=?, updated_at=? WHERE id=?',
            (int(counts.get(row['id'], 0)), now, row['id']),
        )

def _field_value(item: dict, *keys) -> str:
    """Quo has used both `value` and semantic keys like `number`/`address`."""
    if not isinstance(item, dict):
        return ''
    for key in keys:
        value = item.get(key)
        if value is not None:
            value = str(value).strip()
            if value:
                return value
    return ''

def _phone_value(item: dict) -> str:
    value = _field_value(item, 'number', 'value', 'phoneNumber', 'phone')
    if value.lower() in ('anonymous', 'unknown', 'none', 'null'):
        return ''
    return value

def _email_value(item: dict) -> str:
    return _field_value(item, 'address', 'value', 'email')

def extract_contact(contact: dict) -> dict:
    df   = contact.get('defaultFields') or {}
    cfs  = contact.get('customFields')  or []
    phone = next((v for v in (_phone_value(p) for p in df.get('phoneNumbers') or []) if v), '')
    email = next((v for v in (_email_value(e) for e in df.get('emails')      or []) if v), '')
    first_name = df.get('firstName') or ''
    last_name  = df.get('lastName')  or ''
    company    = df.get('company')   or ''
    if not first_name and not last_name and company:
        first_name = company
    tags  = []
    for cf in cfs:
        t, v = cf.get('type',''), cf.get('value')
        if t == 'multi-select' and isinstance(v, list): tags.extend(v)
        elif t == 'string' and v: tags.append(v)
    return {
        'id':          contact.get('id',''),
        'first_name':  first_name,
        'last_name':   last_name,
        'phone':       phone,
        'email':       email,
        'company':     company,
        'role':        df.get('role',   '') or '',
        'tags':        json.dumps(tags),
        'raw':         json.dumps(contact),
        'quo_created': contact.get('createdAt'),
        'quo_updated': contact.get('updatedAt'),
    }

def upsert_contact(conn, contact: dict):
    row = extract_contact(contact)
    conn.execute('''
        INSERT INTO contacts
            (id,first_name,last_name,phone,email,company,role,tags,raw,
             quo_created,quo_updated,synced_at)
        VALUES
            (:id,:first_name,:last_name,:phone,:email,:company,:role,:tags,:raw,
             :quo_created,:quo_updated,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        ON CONFLICT(id) DO UPDATE SET
            first_name=excluded.first_name, last_name=excluded.last_name,
            phone=excluded.phone,           email=excluded.email,
            company=excluded.company,       role=excluded.role,
            tags=excluded.tags,             raw=excluded.raw,
            quo_created=excluded.quo_created, quo_updated=excluded.quo_updated,
            synced_at=excluded.synced_at
    ''', row)

def row_to_contact(row) -> dict:
    return json.loads(row['raw']) if row and row['raw'] else {}

def _message_participant_phone(message: dict, own_number: str = '') -> str:
    own = (own_number or '').strip()
    from_num = (message.get('from') or '').strip()
    to_nums = message.get('to') or []
    if not isinstance(to_nums, list):
        to_nums = [to_nums]
    if from_num and from_num != own:
        return from_num
    return next((str(n).strip() for n in to_nums if str(n).strip() and str(n).strip() != own), '')

def _cache_message(conn, message: dict, contact_phone: str = '', phone_number_id: str = ''):
    msg_id = message.get('id')
    if not msg_id:
        return False
    pn_id = phone_number_id or message.get('phoneNumberId') or ''
    c_phone = contact_phone or _message_participant_phone(message)
    conn.execute('''
        INSERT INTO messages
            (id,contact_phone,phone_number_id,direction,content,status,
             from_number,to_numbers,user_id,raw,msg_created,msg_updated,synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        ON CONFLICT(id) DO UPDATE SET
            contact_phone=excluded.contact_phone,
            phone_number_id=excluded.phone_number_id,
            direction=excluded.direction,
            content=excluded.content,
            status=excluded.status,
            from_number=excluded.from_number,
            to_numbers=excluded.to_numbers,
            user_id=excluded.user_id,
            raw=excluded.raw,
            msg_created=excluded.msg_created,
            msg_updated=excluded.msg_updated,
            synced_at=excluded.synced_at
    ''', (
        msg_id, c_phone, pn_id, message.get('direction',''),
        message.get('text') or message.get('content') or '',
        message.get('status',''), message.get('from',''),
        json.dumps(message.get('to') or []), message.get('userId',''),
        json.dumps(message), message.get('createdAt'), message.get('updatedAt'),
    ))
    return True

def _contact_quality_from_values(first_name='', last_name='', company='',
                                 phone='', email='') -> str:
    has_name  = bool((first_name or '').strip() or (last_name or '').strip() or (company or '').strip())
    has_phone = bool((phone or '').strip())
    has_email = bool((email or '').strip())
    if has_name and has_phone:
        return 'ready'
    if has_email and not has_phone and not has_name:
        return 'email_only'
    if has_phone and not has_name and not has_email:
        return 'phone_only'
    if not has_name and not has_phone and not has_email:
        return 'unknown'
    if not has_phone:
        return 'no_phone'
    return 'incomplete'

def _contact_quality_counts(conn) -> dict:
    rows = conn.execute('SELECT first_name,last_name,company,phone,email FROM contacts').fetchall()
    counts = {
        'ready': 0, 'emailOnly': 0, 'phoneOnly': 0,
        'noPhone': 0, 'unknown': 0, 'incomplete': 0, 'total': len(rows),
    }
    for r in rows:
        q = _contact_quality_from_values(r['first_name'], r['last_name'],
                                         r['company'], r['phone'], r['email'])
        if q == 'ready': counts['ready'] += 1
        elif q == 'email_only': counts['emailOnly'] += 1
        elif q == 'phone_only': counts['phoneOnly'] += 1
        elif q == 'unknown': counts['unknown'] += 1
        elif q == 'no_phone': counts['noPhone'] += 1
        else: counts['incomplete'] += 1
        if q in ('email_only', 'unknown', 'no_phone', 'incomplete'):
            counts['noPhone'] += 0 if q == 'no_phone' else 0
    # noPhone should mean all contacts lacking a phone, regardless of why.
    counts['noPhone'] = sum(
        1 for r in rows if not (r['phone'] or '').strip()
    )
    return counts

# ── Background sync ───────────────────────────────────────────────────────────
def _has_phone(contact: dict) -> bool:
    phones = (contact.get('defaultFields') or {}).get('phoneNumbers') or []
    return any(_phone_value(p) for p in phones)

def _do_sync(api_key: str, log_id: int):
    global sync_state
    conn = get_db()
    try:
        # ── Phase 1: collect all stubs via paginated list ─────────────────
        # The list endpoint already includes defaultFields + customFields.
        # We save every contact from the list immediately and only enrich
        # the ones that came back without a phone number.
        stubs, page_token, page = [], None, 0
        while True:
            page += 1
            sync_state.update(phase=f'Fetching page {page}… ({len(stubs)} found)',
                              done=0, total=0)
            params = {'maxResults': 50}
            if page_token: params['pageToken'] = page_token
            data, status = quo_request(api_key, 'GET', '/contacts', params=params)
            if status not in (200, 201):
                raise RuntimeError(f'Quo API {status}: {data}')
            stubs.extend(data.get('data') or [])
            page_token = data.get('nextPageToken')
            if not page_token:
                break

        # Save everything we have from the list right away
        sync_state.update(phase='Saving list data…', total=len(stubs), done=0)
        with conn:
            for c in stubs:
                upsert_contact(conn, c)

            # Prune local contacts that no longer appear in Quo's full list.
            # This keeps the persistent DB from accumulating old/stale rows.
            current_ids = {c.get('id') for c in stubs if c.get('id')}
            if current_ids:
                existing_rows = conn.execute('SELECT id, phone FROM contacts').fetchall()
                stale = [r for r in existing_rows if r['id'] not in current_ids]
                for r in stale:
                    if r['phone']:
                        conn.execute('DELETE FROM messages WHERE contact_phone=?', (r['phone'],))
                    conn.execute('DELETE FROM contacts WHERE id=?', (r['id'],))
                    conn.execute('DELETE FROM dismissed_duplicates WHERE id1=? OR id2=?',
                                 (r['id'], r['id']))

        # ── Phase 2: enrich only contacts missing a phone number ───────────
        # This is the expensive step — skip it for contacts already complete.
        need_enrich = [s for s in stubs if not _has_phone(s)]
        total       = len(stubs)
        n_enrich    = len(need_enrich)
        already_ok  = total - n_enrich

        if n_enrich == 0:
            sync_state.update(phase=f'All {total} contacts already have phone numbers — no enrichment needed.',
                              done=total, total=total)
        else:
            sync_state.update(
                phase=f'{already_ok}/{total} complete from list. Enriching {n_enrich} missing phones…',
                done=already_ok, total=total
            )
            counter = [already_ok]
            lock    = threading.Lock()

            def fetch_one(stub):
                contact, _ = quo_request(api_key, 'GET', f'/contacts/{stub["id"]}')
                return contact.get('data') or stub

            with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as pool:
                futures = {pool.submit(fetch_one, s): s for s in need_enrich}
                for future in as_completed(futures):
                    contact = future.result()
                    with conn:
                        upsert_contact(conn, contact)
                    with lock:
                        counter[0] += 1
                        pct = round(counter[0] / total * 100)
                        sync_state.update(
                            done=counter[0],
                            phase=f'Enriched {counter[0] - already_ok}/{n_enrich} missing phones ({pct}% total)…'
                        )

        # ── Phase 3: mark sync complete ────────────────────────────────────
        with conn:
            conn.execute(
                "UPDATE sync_log SET completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),"
                "contacts_done=?,status='ok' WHERE id=?",
                (total, log_id)
            )

        sync_state.update(running=False, phase='done', done=total, total=total, error=None)
        print(f'[sync] Done — {total} total, {n_enrich} enriched, '
              f'{already_ok} from list, rate={RATE_LIMIT_RPS} req/s')

    except Exception as e:
        print(f'[sync] Error: {e}')
        sync_state.update(running=False, phase='error', error=str(e))
        try:
            with conn:
                conn.execute(
                    "UPDATE sync_log SET completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),"
                    "status='error',note=? WHERE id=?", (str(e), log_id)
                )
        except Exception: pass
    finally:
        conn.close()

# ── Background verify phones ──────────────────────────────────────────────────
def _do_verify(api_key: str):
    global verify_state
    conn = get_db()
    try:
        rows = conn.execute('SELECT id, phone FROM contacts').fetchall()
        total = len(rows)
        verify_state.update(total=total, done=0, fixed=0, phase=f'Verifying 0/{total}…')

        counter = [0]
        fixed   = [0]
        lock    = threading.Lock()

        def verify_one(row):
            old_phone = row['phone']
            contact, status = quo_request(api_key, 'GET', f'/contacts/{row["id"]}')
            if status != 200:
                return None, False
            full = contact.get('data')
            if not full:
                return None, False
            phones = (full.get('defaultFields') or {}).get('phoneNumbers') or []
            new_phone = next((v for v in (_phone_value(p) for p in phones) if v), '')
            changed = new_phone != old_phone
            return full, changed

        with ThreadPoolExecutor(max_workers=VERIFY_WORKERS) as pool:
            futures = {pool.submit(verify_one, dict(r)): dict(r) for r in rows}
            for future in as_completed(futures):
                full, changed = future.result()
                with lock:
                    if full:
                        upsert_contact(conn, full)
                        if changed:
                            fixed[0] += 1
                            conn.commit()
                    counter[0] += 1
                    pct = round(counter[0] / total * 100)
                    verify_state.update(
                        done=counter[0], fixed=fixed[0],
                        phase=f'Verified {counter[0]}/{total} ({pct}%) · {fixed[0]} updated'
                    )

        verify_state.update(running=False, phase='done',
                            done=total, fixed=fixed[0], error=None)
        print(f'[verify] Done — {total} checked, {fixed[0]} phone numbers updated')

    except Exception as e:
        print(f'[verify] Error: {e}')
        verify_state.update(running=False, phase='error', error=str(e))
    finally:
        conn.close()

# ── Routes: static ────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@app.route('/hub')
@app.route('/hub/')
def hub_index():
    return send_from_directory('public', 'hub.html')

@app.route('/health')
def health():
    return jsonify({'ok': True, 'version': APP_VERSION})


@app.route('/hub/api/bootstrap')
def hub_bootstrap():
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        _hub_recount_connectors(conn)
        connectors = [
            _hub_connector_row(row)
            for row in conn.execute('SELECT * FROM hub_connectors ORDER BY enabled DESC, name').fetchall()
        ]
        messages = _hub_fetch_state(conn)
    return jsonify({
        'connectors': connectors,
        'messages': messages,
        'summary': _hub_summary(messages),
        'location_tags': list(HUB_LOCATION_TAGS),
        'connector_kinds': [
            {'kind': kind, **profile}
            for kind, profile in HUB_CONNECTOR_KIND_DEFS.items()
        ],
    })


@app.route('/hub/api/messages')
def hub_messages():
    connector_id = request.args.get('connector', '').strip()
    location_tag = request.args.get('location', '').strip()
    status = request.args.get('status', '').strip()
    search = request.args.get('search', '').strip()
    limit = request.args.get('limit', '').strip()
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        messages = _hub_fetch_state(conn, connector_id, location_tag, status, search)
    if limit.isdigit():
        messages = messages[: int(limit)]
    return jsonify({'data': messages, 'total': len(messages)})


@app.route('/hub/api/connectors', methods=['GET', 'POST'])
def hub_connectors():
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        if request.method == 'GET':
            rows = conn.execute('SELECT * FROM hub_connectors ORDER BY enabled DESC, name').fetchall()
            return jsonify({'data': [_hub_connector_row(row) for row in rows]})

        payload = request.get_json(silent=True) or {}
        name = str(payload.get('name', '')).strip()
        kind = _hub_canonical_connector_kind(payload.get('kind', 'webhook')) or 'webhook'
        profile = _hub_profile(kind)
        connector_id = str(payload.get('id', '')).strip() or re.sub(r'[^a-z0-9_-]+', '-', name.lower()).strip('-') or f'custom-{int(time.time())}'
        incoming_config = payload.get('config')
        if not isinstance(incoming_config, dict):
            incoming_config = dict(profile.get('default_config') or {})
        enabled = 1 if payload.get('enabled', True) else 0
        status = str(payload.get('status', 'needs_setup' if not profile.get('sync_supported') else 'ready')).strip() or 'ready'
        if not name:
            return jsonify({'error': 'Connector name is required'}), 400
        existing = conn.execute('SELECT 1 FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        if existing:
            return jsonify({'error': 'Connector id already exists'}), 409
        config = _hub_prepare_connector_config(conn, connector_id, kind, incoming_config, {})
        conn.execute(
            '''
            INSERT INTO hub_connectors (id, name, kind, enabled, status, message_count, last_sync, last_error, config, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, '', '', ?, ?)
            ''',
            (connector_id, name, kind, enabled, status, _json_dump(config), _hub_now()),
        )
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        return jsonify({'ok': True, 'data': _hub_connector_row(row)}), 201


@app.route('/hub/api/connectors/<connector_id>', methods=['PATCH'])
def hub_connector_update(connector_id):
    payload = request.get_json(silent=True) or {}
    updates = []
    params = []
    allowed = {'name', 'kind', 'status', 'last_sync'}
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        existing_row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        if not existing_row:
            return jsonify({'error': 'Connector not found'}), 404
        existing_config = _json_load(existing_row['config'], {})
        next_kind = _hub_canonical_connector_kind(payload.get('kind', existing_row['kind']))
        if 'enabled' in payload:
            updates.append('enabled = ?')
            params.append(1 if payload.get('enabled') else 0)
        for key in allowed:
            if key in payload:
                if key == 'kind':
                    updates.append(f'{key} = ?')
                    params.append(_hub_canonical_connector_kind(payload.get(key, '')))
                    continue
                updates.append(f'{key} = ?')
                params.append(str(payload.get(key, '')).strip())
        if 'config' in payload:
            merged_config = _hub_prepare_connector_config(conn, connector_id, next_kind, payload.get('config', {}), existing_config)
            updates.append('config = ?')
            params.append(_json_dump(merged_config))
        if 'last_error' in payload:
            updates.append('last_error = ?')
            params.append(str(payload.get('last_error', '')).strip())
        if not updates:
            return jsonify({'error': 'No updates provided'}), 400
        updates.append('updated_at = ?')
        params.append(_hub_now())
        params.append(connector_id)
        cur = conn.execute(
            f'UPDATE hub_connectors SET {", ".join(updates)} WHERE id = ?',
            params,
        )
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        return jsonify({'ok': True, 'data': _hub_connector_row(row)})


@app.route('/hub/api/connectors/<connector_id>/gmail/oauth/start')
def hub_gmail_oauth_start(connector_id):
    return_to = str(request.args.get('return_to') or '/hub').strip() or '/hub'
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Connector not found'}), 404
        connector = _hub_connector_row(row)
        if connector.get('kind') != 'gmail':
            return jsonify({'error': 'Google login is only available for Gmail connectors'}), 400
        config = connector.get('config') if isinstance(connector.get('config'), dict) else {}
        client_id = str(config.get('google_client_id') or '').strip()
        client_secret = _hub_connector_secret_get(conn, connector_id, 'google_client_secret')
        if not client_id or not client_secret:
            return jsonify({'error': 'Save the Google client ID and client secret on this Gmail connector first'}), 400
        state = _hub_issue_gmail_oauth_state(connector_id, return_to)
        params = {
            'client_id': client_id,
            'redirect_uri': _hub_gmail_redirect_uri(),
            'response_type': 'code',
            'scope': GMAIL_OAUTH_SCOPE,
            'access_type': 'offline',
            'prompt': 'consent',
            'include_granted_scopes': 'true',
            'state': state,
        }
        return redirect(f'{GMAIL_OAUTH_AUTHORIZE_URL}?{urlencode(params)}')


@app.route('/hub/api/gmail/oauth/callback')
def hub_gmail_oauth_callback():
    error = str(request.args.get('error') or '').strip()
    code = str(request.args.get('code') or '').strip()
    state = str(request.args.get('state') or '').strip()
    state_payload = _hub_consume_gmail_oauth_state(state)
    if not state_payload:
        return 'This Gmail login link expired or is invalid. Please try connecting Gmail again from Message Hub.', 400
    connector_id = state_payload['connector_id']
    return_to = state_payload.get('return_to') or '/hub'
    if error:
        with get_db() as conn:
            _hub_touch_connector(conn, connector_id, status='needs_setup', last_error=f'Google login was not completed: {error}', last_sync=_hub_now())
        return redirect(return_to)
    if not code:
        return 'Google did not return an authorization code.', 400
    with get_db() as conn:
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        if not row:
            return 'Gmail connector not found.', 404
        connector = _hub_connector_row(row)
        config = connector.get('config') if isinstance(connector.get('config'), dict) else {}
        client_id = str(config.get('google_client_id') or '').strip()
        client_secret = _hub_connector_secret_get(conn, connector_id, 'google_client_secret')
        if not client_id or not client_secret:
            return 'Google client credentials are missing from this Gmail connector.', 400
        token_response = requests.post(
            GMAIL_OAUTH_TOKEN_URL,
            data={
                'code': code,
                'client_id': client_id,
                'client_secret': client_secret,
                'redirect_uri': _hub_gmail_redirect_uri(),
                'grant_type': 'authorization_code',
            },
            timeout=20,
        )
        token_data = token_response.json() if token_response.content else {}
        if token_response.status_code >= 400:
            error_message = ''
            if isinstance(token_data, dict):
                error_message = token_data.get('error_description') or token_data.get('error') or ''
            _hub_touch_connector(conn, connector_id, status='error', last_error=error_message or 'Google token exchange failed', last_sync=_hub_now())
            return redirect(return_to)
        updated_config, email_address = _hub_gmail_finalize_oauth(conn, connector_id, config, token_data)
        _hub_touch_connector(
            conn,
            connector_id,
            status='connected',
            last_error='',
            last_sync=_hub_now(),
            config=updated_config,
        )
    return redirect(return_to)


@app.route('/hub/api/connectors/<connector_id>/test', methods=['POST'])
def hub_connector_test(connector_id):
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Connector not found'}), 404
        connector = _hub_connector_row(row)
        try:
            result = _hub_validate_connector(conn, connector)
        except Exception as exc:
            summary = str(exc).strip() or 'Connector test failed'
            _hub_touch_connector(
                conn,
                connector_id,
                status='error',
                last_error=summary,
                last_sync=_hub_now(),
            )
            row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
            return jsonify({
                'ok': False,
                'error': summary,
                'result': {
                    'ok': False,
                    'mode': 'live',
                    'status': 'error',
                    'summary': summary,
                    'details': connector.get('setup', {}).get('details', []),
                    'missing': [],
                },
                'data': _hub_connector_row(row),
            }), 200
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        return jsonify({'ok': bool(result.get('ok')), 'result': result, 'data': _hub_connector_row(row)})


@app.route('/hub/api/messages/<message_id>', methods=['GET', 'PATCH'])
def hub_message_update(message_id):
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        row = conn.execute('SELECT * FROM hub_messages WHERE id=?', (message_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Message not found'}), 404
        if request.method == 'GET':
            return jsonify({'data': _hub_message_row(row)})

        payload = request.get_json(silent=True) or {}
        updates = []
        params = []
        if 'location_tag' in payload:
            raw_tag = str(payload.get('location_tag', '')).strip()
            if raw_tag not in HUB_LOCATION_TAGS and raw_tag != '':
                return jsonify({'error': f'location_tag must be one of {", ".join(HUB_LOCATION_TAGS)} or blank'}), 400
            updates.append('location_tag = ?')
            params.append(raw_tag)
        if 'status' in payload:
            updates.append('status = ?')
            params.append(str(payload.get('status', 'needs_review')).strip() or 'needs_review')
        if 'location_reason' in payload:
            updates.append('location_reason = ?')
            params.append(str(payload.get('location_reason', '')).strip())
        if 'confidence' in payload:
            try:
                confidence = float(payload.get('confidence', 0))
            except Exception:
                confidence = 0.0
            updates.append('confidence = ?')
            params.append(confidence)
        if 'raw' in payload:
            updates.append('raw = ?')
            params.append(_json_dump(payload.get('raw', {})))
        if not updates:
            return jsonify({'error': 'No updates provided'}), 400
        updates.append('updated_at = ?')
        params.append(_hub_now())
        params.append(message_id)
        conn.execute(f'UPDATE hub_messages SET {", ".join(updates)} WHERE id = ?', params)
        row = conn.execute('SELECT * FROM hub_messages WHERE id=?', (message_id,)).fetchone()
        return jsonify({'ok': True, 'data': _hub_message_row(row)})


@app.route('/hub/api/messages/<message_id>/classify', methods=['POST'])
def hub_message_classify(message_id):
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        row = conn.execute('SELECT * FROM hub_messages WHERE id=?', (message_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Message not found'}), 404
        message = _hub_message_row(row)
        raw = message.get('raw') or {}
        blob = ' '.join(filter(None, [
            message.get('subject', ''),
            message.get('preview', ''),
            message.get('body', ''),
            raw.get('booking_location', '') if isinstance(raw, dict) else '',
        ]))
        tag, confidence, reason = _hub_classify_location(blob, raw if isinstance(raw, dict) else {})
        conn.execute(
            '''
            UPDATE hub_messages
            SET location_tag = ?, location_reason = ?, confidence = ?, updated_at = ?
            WHERE id = ?
            ''',
            (tag, reason, confidence, _hub_now(), message_id),
        )
        row = conn.execute('SELECT * FROM hub_messages WHERE id=?', (message_id,)).fetchone()
        return jsonify({'ok': True, 'data': _hub_message_row(row)})


@app.route('/hub/api/connectors/<connector_id>/sync', methods=['POST'])
def hub_connector_sync(connector_id):
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Connector not found'}), 404
        try:
            inserted = _hub_sync_connector(conn, connector_id)
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        return jsonify({
            'ok': True,
            'data': _hub_connector_row(row),
            'inserted': inserted,
        })


@app.route('/hub/api/connectors/<connector_id>/ingest', methods=['GET', 'POST'])
def hub_connector_ingest(connector_id):
    with get_db() as conn:
        _hub_seed_if_needed(conn)
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Connector not found'}), 404
        connector = _hub_connector_row(row)
        if not connector.get('ingest_supported'):
            return jsonify({'error': f'{connector["name"]} does not accept webhook ingest'}), 400
        if request.method == 'GET':
            if connector.get('kind') != 'meta':
                return jsonify({'error': f'{connector["name"]} does not support GET webhook verification'}), 405
            try:
                challenge = _hub_verify_meta_webhook(conn, connector)
            except Exception as exc:
                _hub_touch_connector(
                    conn,
                    connector_id,
                    status='error',
                    last_error=str(exc),
                    last_sync=_hub_now(),
                )
                return jsonify({'ok': False, 'error': str(exc)}), 400
            return app.response_class(challenge, mimetype='text/plain')
        payload = request.get_json(silent=True) or {}
        try:
            ingester = HUB_CONNECTOR_INGESTERS.get(connector.get('kind') or '')
            if not ingester:
                available = ', '.join(sorted(HUB_CONNECTOR_INGESTERS)) or 'none'
                raise ValueError(f'No ingest adapter registered for connector kind {connector.get("kind")!r}. Available adapters: {available}')
            cached = ingester(conn, connector, payload)
            _hub_recount_connectors(conn)
            _hub_touch_connector(
                conn,
                connector_id,
                status='connected',
                last_sync=_hub_now(),
                last_error='',
            )
        except Exception as exc:
            _hub_touch_connector(
                conn,
                connector_id,
                status='error',
                last_error=str(exc),
                last_sync=_hub_now(),
            )
            return jsonify({'ok': False, 'error': str(exc)}), 400
        row = conn.execute('SELECT * FROM hub_connectors WHERE id=?', (connector_id,)).fetchone()
        return jsonify({'ok': True, 'data': _hub_connector_row(row), 'cached': bool(cached)})

# ── Routes: Quo API proxy (send-message, create/update contact, etc.) ─────────
@app.route('/api/<path:api_path>', methods=['GET','POST','PUT','PATCH','DELETE'])
def proxy(api_path):
    api_key = _resolve_quo_api_key()
    if not api_key:
        return jsonify({'error': 'No Quo API key configured'}), 401

    url    = f'{QUO_BASE}/{api_path}'
    params = request.args.to_dict(flat=False)   # preserves repeated keys (arrays)
    body   = request.get_json(silent=True)

    _bucket.acquire()
    resp = _session.request(
        request.method, url,
        params=params,
        json=body if request.method in ('POST','PUT','PATCH') else None,
        headers={'Authorization': api_key},
        timeout=15,
    )
    try:    return jsonify(resp.json()), resp.status_code
    except: return resp.text, resp.status_code

# ── Routes: DB — contacts ─────────────────────────────────────────────────────
@app.route('/db/contacts')
def db_contacts():
    search = request.args.get('search','').strip().lower()
    tag    = request.args.get('tag','').strip()
    with get_db() as conn:
        rows = conn.execute(
            'SELECT * FROM contacts ORDER BY first_name, last_name'
        ).fetchall()
    contacts = [row_to_contact(r) for r in rows if row_to_contact(r)]
    if search:
        contacts = [c for c in contacts if
            search in (c.get('defaultFields',{}).get('firstName','') or '').lower() or
            search in (c.get('defaultFields',{}).get('lastName', '') or '').lower() or
            search in (c.get('defaultFields',{}).get('company',  '') or '').lower() or
            search in next((_phone_value(p) for p in
                (c.get('defaultFields',{}).get('phoneNumbers') or [])), '').lower() or
            search in next((_email_value(e) for e in
                (c.get('defaultFields',{}).get('emails') or [])), '').lower()
        ]
    if tag:
        def has_tag(c):
            for cf in (c.get('customFields') or []):
                v = cf.get('value')
                if isinstance(v, list) and tag in v: return True
                if isinstance(v, str)  and tag == v: return True
            return False
        contacts = [c for c in contacts if has_tag(c)]
    return jsonify({'data': contacts, 'total': len(contacts)})

@app.route('/db/contacts/<contact_id>', methods=['GET'])
def db_get_contact(contact_id):
    with get_db() as conn:
        row = conn.execute('SELECT * FROM contacts WHERE id=?', (contact_id,)).fetchone()
    if not row: return jsonify({'error': 'Not found'}), 404
    return jsonify({'data': row_to_contact(row)})

@app.route('/db/contacts/<contact_id>', methods=['PUT'])
def db_upsert_contact(contact_id):
    contact = request.get_json(silent=True) or {}
    if not contact.get('id'): contact['id'] = contact_id
    with get_db() as conn:
        upsert_contact(conn, contact)
    return jsonify({'ok': True})

@app.route('/db/contacts/<contact_id>', methods=['DELETE'])
def db_delete_contact(contact_id):
    with get_db() as conn:
        conn.execute('DELETE FROM contacts WHERE id=?', (contact_id,))
    return jsonify({'ok': True})

# ── Routes: DB — messages ─────────────────────────────────────────────────────
@app.route('/db/messages')
def db_messages():
    pn_id   = request.args.get('phoneNumberId','')
    c_phone = request.args.get('contactPhone','')
    if not pn_id or not c_phone:
        return jsonify({'error': 'phoneNumberId and contactPhone required'}), 400
    with get_db() as conn:
        rows = conn.execute('''
            SELECT * FROM messages
            WHERE phone_number_id=? AND contact_phone=?
            ORDER BY msg_created ASC
        ''', (pn_id, c_phone)).fetchall()
    msgs = [{
        'id': r['id'],
        'direction': r['direction'],
        'text': r['content'],
        'status': r['status'],
        'from': r['from_number'],
        'to': json.loads(r['to_numbers'] or '[]'),
        'userId': r['user_id'],
        'createdAt': r['msg_created'],
        'updatedAt': r['msg_updated'],
        'phoneNumberId': r['phone_number_id'],
        'raw': json.loads(r['raw'] or '{}'),
        'syncedAt': r['synced_at'],
    } for r in rows]
    return jsonify({'data': msgs, 'cached': True})

@app.route('/db/messages/cache', methods=['POST'])
def db_cache_messages():
    body    = request.get_json(silent=True) or {}
    pn_id   = body.get('phoneNumberId','')
    c_phone = body.get('contactPhone','')
    messages= body.get('messages',[])
    if not pn_id or not c_phone:
        return jsonify({'error': 'phoneNumberId and contactPhone required'}), 400
    cached = 0
    with get_db() as conn:
        for m in messages:
            if _cache_message(conn, m, c_phone, pn_id):
                cached += 1
    return jsonify({'ok': True, 'cached': cached})

@app.route('/db/messages/cache-one', methods=['POST'])
def db_cache_one_message():
    body = request.get_json(silent=True) or {}
    message = body.get('message') or body.get('data') or body
    if isinstance(message, dict) and 'data' in message and isinstance(message['data'], dict):
        message = message['data']
    contact_phone = body.get('contactPhone','')
    phone_number_id = body.get('phoneNumberId','')
    if not isinstance(message, dict) or not message.get('id'):
        return jsonify({'error': 'message with id required'}), 400
    with get_db() as conn:
        cached = _cache_message(conn, message, contact_phone, phone_number_id)
    return jsonify({'ok': bool(cached), 'cached': 1 if cached else 0})

@app.route('/quo-webhook/messages', methods=['POST'])
def quo_messages_webhook():
    payload = request.get_json(silent=True) or {}
    event_type = payload.get('type') or ''
    obj = ((payload.get('data') or {}).get('object') or payload.get('object') or {})
    entry = {
        'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': 'quo',
        'type': event_type,
        'messageId': obj.get('id'),
        'status': obj.get('status'),
        'direction': obj.get('direction'),
    }
    webhook_log.insert(0, entry)
    if len(webhook_log) > 100:
        webhook_log.pop()
    cached = False
    if isinstance(obj, dict) and obj.get('id'):
        with get_db() as conn:
            cached = _cache_message(conn, obj)
    return jsonify({'ok': True, 'cached': cached})

# ── Routes: DB — sync ─────────────────────────────────────────────────────────
@app.route('/db/sync', methods=['POST'])
def db_sync():
    global sync_state
    if sync_state['running']:
        return jsonify({'ok': False, 'msg': 'Sync already running'}), 409
    body    = request.get_json(silent=True) or {}
    api_key = _resolve_quo_api_key(body)
    if not api_key:
        return jsonify({'error': 'No Quo API key configured'}), 400
    with get_db() as conn:
        cur    = conn.execute(
            "INSERT INTO sync_log (started_at,status) "
            "VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'),'running')"
        )
        log_id = cur.lastrowid
    sync_state = {'running':True,'phase':'Starting…','done':0,'total':0,'error':None}
    threading.Thread(target=_do_sync, args=(api_key, log_id), daemon=True).start()
    return jsonify({'ok': True, 'logId': log_id})

@app.route('/db/sync-status')
def db_sync_status():
    with get_db() as conn:
        last  = conn.execute(
            "SELECT * FROM sync_log WHERE status='ok' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        count = conn.execute('SELECT COUNT(*) AS n FROM contacts').fetchone()['n']
    return jsonify({
        **sync_state,
        'contactsInDb':  count,
        'lastSyncAt':    last['completed_at']  if last else None,
        'lastSyncCount': last['contacts_done'] if last else 0,
    })

@app.route('/db/stats')
def db_stats():
    with get_db() as conn:
        contacts = conn.execute('SELECT COUNT(*) AS n FROM contacts').fetchone()['n']
        messages = conn.execute('SELECT COUNT(*) AS n FROM messages').fetchone()['n']
        last     = conn.execute(
            "SELECT completed_at,contacts_done FROM sync_log WHERE status='ok' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        quality = _contact_quality_counts(conn)
    return jsonify({'contacts':contacts,'messages':messages,
                    'lastSync': dict(last) if last else None,
                    'quality': quality})

@app.route('/db/reindex-contacts', methods=['POST'])
def db_reindex_contacts():
    """Repair extracted DB columns from stored raw Quo JSON after mapper changes."""
    fixed = 0
    skipped = 0
    with get_db() as conn:
        rows = conn.execute('SELECT raw FROM contacts WHERE raw IS NOT NULL AND raw != ""').fetchall()
        with conn:
            for row in rows:
                try:
                    contact = json.loads(row['raw'])
                    upsert_contact(conn, contact)
                    fixed += 1
                except Exception:
                    skipped += 1
    return jsonify({'ok': True, 'fixed': fixed, 'skipped': skipped})

def _db_cleanup_counts(conn):
    """Return conservative cleanup counts for local-only orphaned records."""
    orphan_messages = conn.execute('''
        SELECT COUNT(*) AS n
        FROM messages m
        WHERE m.contact_phone = ''
           OR NOT EXISTS (
               SELECT 1 FROM contacts c WHERE c.phone = m.contact_phone
           )
    ''').fetchone()['n']
    orphan_dismissed = conn.execute('''
        SELECT COUNT(*) AS n
        FROM dismissed_duplicates d
        WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = d.id1)
           OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = d.id2)
    ''').fetchone()['n']
    empty_contacts = conn.execute('''
        SELECT COUNT(*) AS n
        FROM contacts
        WHERE COALESCE(first_name,'') = ''
          AND COALESCE(last_name,'') = ''
          AND COALESCE(company,'') = ''
          AND COALESCE(phone,'') = ''
          AND COALESCE(email,'') = ''
    ''').fetchone()['n']
    contacts = conn.execute('SELECT COUNT(*) AS n FROM contacts').fetchone()['n']
    messages = conn.execute('SELECT COUNT(*) AS n FROM messages').fetchone()['n']
    dismissed = conn.execute('SELECT COUNT(*) AS n FROM dismissed_duplicates').fetchone()['n']
    return {
        'contacts': contacts,
        'messages': messages,
        'dismissedDuplicates': dismissed,
        'orphanMessages': orphan_messages,
        'orphanDismissedDuplicates': orphan_dismissed,
        'unknownContacts': empty_contacts,
        'quality': _contact_quality_counts(conn),
    }

@app.route('/db/cleanup-audit')
def db_cleanup_audit():
    with get_db() as conn:
        return jsonify(_db_cleanup_counts(conn))

@app.route('/db/cleanup', methods=['POST'])
def db_cleanup():
    """Remove local DB orphans and optionally Unknown local contacts."""
    body = request.get_json(silent=True) or {}
    remove_unknown = bool(body.get('removeUnknownContacts'))
    remove_email_only = bool(body.get('removeEmailOnlyContacts'))
    with get_db() as conn:
        before = _db_cleanup_counts(conn)
        with conn:
            conn.execute('''
                DELETE FROM messages
                WHERE contact_phone = ''
                   OR NOT EXISTS (
                       SELECT 1 FROM contacts c WHERE c.phone = messages.contact_phone
                   )
            ''')
            conn.execute('''
                DELETE FROM dismissed_duplicates
                WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = dismissed_duplicates.id1)
                   OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = dismissed_duplicates.id2)
            ''')
            if remove_unknown:
                unknown_rows = conn.execute('''
                    SELECT id, phone FROM contacts
                    WHERE COALESCE(first_name,'') = ''
                      AND COALESCE(last_name,'') = ''
                      AND COALESCE(company,'') = ''
                      AND COALESCE(phone,'') = ''
                      AND COALESCE(email,'') = ''
                ''').fetchall()
                for row in unknown_rows:
                    if row['phone']:
                        conn.execute('DELETE FROM messages WHERE contact_phone=?', (row['phone'],))
                    conn.execute('DELETE FROM dismissed_duplicates WHERE id1=? OR id2=?',
                                 (row['id'], row['id']))
                    conn.execute('DELETE FROM contacts WHERE id=?', (row['id'],))
            if remove_email_only:
                email_only_rows = conn.execute('''
                    SELECT id, phone FROM contacts
                    WHERE COALESCE(email,'') != ''
                      AND COALESCE(phone,'') = ''
                      AND COALESCE(first_name,'') = ''
                      AND COALESCE(last_name,'') = ''
                      AND COALESCE(company,'') = ''
                ''').fetchall()
                for row in email_only_rows:
                    conn.execute('DELETE FROM dismissed_duplicates WHERE id1=? OR id2=?',
                                 (row['id'], row['id']))
                    conn.execute('DELETE FROM contacts WHERE id=?', (row['id'],))
        after = _db_cleanup_counts(conn)
        duplicate_groups = _duplicate_groups(conn)
    return jsonify({'ok': True, 'before': before, 'after': after,
                    'duplicates': {'total': len(duplicate_groups)}})

# ── Routes: verify phones ─────────────────────────────────────────────────────
@app.route('/db/verify', methods=['POST'])
def db_verify():
    global verify_state
    if verify_state['running']:
        return jsonify({'ok': False, 'msg': 'Verify already running'}), 409
    body    = request.get_json(silent=True) or {}
    api_key = _resolve_quo_api_key(body)
    if not api_key:
        return jsonify({'error': 'No Quo API key configured'}), 400
    verify_state = {'running':True,'phase':'Starting…','done':0,'total':0,'fixed':0,'error':None}
    threading.Thread(target=_do_verify, args=(api_key,), daemon=True).start()
    return jsonify({'ok': True})

@app.route('/db/verify-status')
def db_verify_status():
    return jsonify(verify_state)

# ── Vagaro webhook ────────────────────────────────────────────────────────────
@app.route('/vagaro-webhook', methods=['POST'])
def vagaro_webhook():
    quo_key  = _resolve_quo_api_key()
    if not quo_key: return jsonify({'error': 'Missing Quo API key'}), 401
    payload  = request.get_json(silent=True) or {}
    event    = payload.get('event', payload.get('type','unknown'))
    customer = payload.get('data') or payload.get('customer') or payload
    first    = customer.get('firstName','')
    last     = customer.get('lastName', '')
    email    = customer.get('email','')
    phone    = (customer.get('cellPhone') or customer.get('phoneNumber') or
                customer.get('mobilePhone') or customer.get('phone') or '')
    tags     = customer.get('tags') or customer.get('generalTags') or []
    entry    = {'time':time.strftime('%H:%M:%S'),'event':event,
                'name':f'{first} {last}'.strip(),'ok':False,'msg':''}
    if not first:
        entry['msg'] = 'No firstName — skipped'
        webhook_log.insert(0, entry)
        if len(webhook_log) > 100: webhook_log.pop()
        return jsonify({'skipped':True}), 200
    contact_body = {
        'defaultFields': {
            'firstName': first, 'lastName': last or None,
            **(({'emails':[{'address':email}]}) if email else {}),
            **(({'phoneNumbers':[{'number':phone}]}) if phone else {}),
        }
    }
    if tags: contact_body['customFields'] = [{'key':'tags','value':tags}]
    existing_id = None
    if phone:
        with get_db() as conn:
            row = conn.execute('SELECT id FROM contacts WHERE phone=? LIMIT 1',(phone,)).fetchone()
            if row: existing_id = row['id']
    if existing_id:
        res, status = quo_request(quo_key,'PATCH',f'/contacts/{existing_id}',contact_body)
        entry['msg'] = f'Updated {existing_id}'
    else:
        res, status = quo_request(quo_key,'POST','/contacts',contact_body)
        entry['msg'] = 'Created new contact'
    entry['ok'] = status in (200,201,202)
    if not entry['ok']:
        entry['msg'] = f'API error {status}: {res}'
    else:
        saved = res.get('data') or res
        if saved.get('id'):
            full, _ = quo_request(quo_key,'GET',f'/contacts/{saved["id"]}')
            with get_db() as conn:
                upsert_contact(conn, full.get('data') or saved)
    webhook_log.insert(0, entry)
    if len(webhook_log) > 100: webhook_log.pop()
    return jsonify({'ok':entry['ok'],'msg':entry['msg']}), 200

@app.route('/vagaro-webhook-log')
def get_webhook_log():
    return jsonify(webhook_log)

@app.route('/vagaro-test', methods=['POST'])
def vagaro_test():
    body = request.get_json(silent=True) or {}
    client_id, client_secret, region = _resolve_vagaro_credentials(body)
    token, err = _get_vagaro_token(client_id, client_secret, region)
    if token: return jsonify({'ok':True,'msg':'Connected to Vagaro!'})
    return jsonify({'ok':False,'msg':f'Vagaro auth failed: {err}'}), 401

def _get_vagaro_token(client_id, client_secret, region):
    now = time.time()
    if _vagaro_token_cache['token'] and _vagaro_token_cache['expires'] > now + 60:
        return _vagaro_token_cache['token'], None
    try:
        resp = _session.post(
            f'https://api.vagaro.com/{region}/api/v2/merchants/generate-access-token',
            json={'clientId':client_id,'clientSecretKey':client_secret,'scope':'customer'},
            timeout=10,
        )
        data  = resp.json()
        token = data.get('access_token') or data.get('accessToken') or data.get('token')
        if token:
            _vagaro_token_cache['token']   = token
            _vagaro_token_cache['expires'] = now + data.get('expires_in',3600)
        return token, None
    except Exception as e:
        return None, str(e)

# ── AI message composer ───────────────────────────────────────────────────────
CHUNK_SIZE = 8
AI_SYSTEM  = """You are a business texting assistant. Write short, natural, personalized SMS messages.

Rules:
- Follow the user's intent literally. Preserve requested facts, languages, tone, message count, and sequencing.
- If the user asks for multiple messages per contact, return multiple separate message strings for that contact.
- If the user asks for English and Arabic, produce a separate English message and a separate Arabic message unless they ask for one combined message.
- Do not mix languages inside one message unless the user explicitly asks for mixed-language wording.
- Use the customer's first name only where natural. Do not translate or transliterate the sender's name unless the user explicitly asks.
- Keep each message under 160 chars when possible. If important requested details require more, keep each under 300.
- No emojis unless the intent asks for them.
- No salesy buzzwords. Sound like a real person.
- Weave in tags/company context naturally only when relevant.
- Return ONLY a valid JSON array, no markdown or explanation

Format:
[
  {"id":"<id>","message":"<sms>"},
  {"id":"<id>","messages":["<sms 1>","<sms 2>"]}
]"""

def _extract_json_array(raw: str):
    text = (raw or '').strip()
    text = re.sub(r'^```(?:json)?\s*','', text)
    text = re.sub(r'\s*```$','', text).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find('[')
        end = text.rfind(']')
        if start < 0 or end <= start:
            raise
        data = json.loads(text[start:end+1])
    if not isinstance(data, list):
        raise ValueError('Claude response was not a JSON array')
    return data

def _valid_ai_messages(data, allowed_ids):
    allowed = set(str(x) for x in allowed_ids)
    clean = []
    for item in data:
        if not isinstance(item, dict):
            continue
        cid = str(item.get('id','')).strip()
        raw_messages = item.get('messages')
        if isinstance(raw_messages, list):
            messages = [str(m).strip()[:300] for m in raw_messages if str(m).strip()]
        else:
            msg = str(item.get('message','')).strip()
            messages = [msg[:300]] if msg else []
        if cid in allowed and messages:
            clean.append({'id': cid, 'messages': messages, 'message': '\n\n'.join(messages)})
    return clean

@app.route('/ai-compose', methods=['POST'])
def ai_compose():
    body          = request.get_json(silent=True) or {}
    anthropic_key = _resolve_anthropic_key(body)
    intent        = body.get('intent','').strip()
    contacts      = body.get('contacts',[])
    if not anthropic_key: return jsonify({'error':'Anthropic API key required'}),400
    if not intent:        return jsonify({'error':'Message intent required'}),400
    if not contacts:      return jsonify({'error':'No contacts provided'}),400
    model = body.get('model', 'claude-sonnet-4-5').strip() or 'claude-sonnet-4-5'
    try:
        import anthropic as ant
        client = ant.Anthropic(api_key=anthropic_key)
    except Exception as e:
        return jsonify({'error':f'Anthropic init failed: {e}'}),500
    all_messages = []

    def request_chunk(chunk):
        lines = []
        for c in chunk:
            parts = [f"ID:{c['id']}", f"Name:{c['name']}"]
            if c.get('company'): parts.append(f"Company:{c['company']}")
            if c.get('role'):    parts.append(f"Role:{c['role']}")
            if c.get('tags'):    parts.append(f"Tags:{','.join(c['tags'])}")
            lines.append(' | '.join(parts))
        user_msg = (f"User request:\n{intent}\n\nContacts:\n\n" +
                    '\n'.join(f"{j+1}. {l}" for j,l in enumerate(lines)) +
                    "\n\nReturn a valid JSON array only. Use exactly these IDs. "
                    "For each contact, use either {\"id\":\"...\",\"message\":\"...\"} for one text "
                    "or {\"id\":\"...\",\"messages\":[\"...\",\"...\"]} for multiple separate texts. "
                    "If the user asks for two messages, return two strings in messages. "
                    "Escape newlines and quotes inside strings.")
        resp = client.messages.create(
            model=model, max_tokens=4096,
            system=AI_SYSTEM, messages=[{'role':'user','content':user_msg}]
        )
        raw = ''.join(block.text for block in resp.content if getattr(block, 'text', None)).strip()
        parsed = _extract_json_array(raw)
        clean = _valid_ai_messages(parsed, [c['id'] for c in chunk])
        if len(clean) != len(chunk):
            got = {m['id'] for m in clean}
            missing = [c['id'] for c in chunk if str(c['id']) not in got]
            raise ValueError(f'Missing drafts for {len(missing)} contact(s): {", ".join(missing[:3])}')
        return clean

    for i in range(0, len(contacts), CHUNK_SIZE):
        chunk = contacts[i:i+CHUNK_SIZE]
        try:
            all_messages.extend(request_chunk(chunk))
        except Exception as e:
            # If a multi-contact response is malformed/truncated, retry each contact.
            # This costs a few more calls but prevents one bad JSON blob from blocking the send.
            for contact in chunk:
                try:
                    all_messages.extend(request_chunk([contact]))
                except Exception as single_error:
                    return jsonify({
                        'error': f'AI draft failed for {contact.get("name") or contact.get("id")}: {single_error}',
                    }), 500
    return jsonify({'messages':all_messages})

# ── Runtime settings ─────────────────────────────────────────────────────────
@app.route('/settings', methods=['POST'])
def update_settings():
    body = request.get_json(silent=True) or {}
    rps  = body.get('rateLimitRps')
    if rps is not None:
        rps = max(1, min(8, float(rps)))   # clamp 1–8; Quo 429s on aggressive bursts
        with _bucket._lock:
            _bucket._rate  = rps
            _bucket._burst = max(1, int(rps))
            _bucket._tokens = min(_bucket._tokens, float(_bucket._burst))
        print(f'[settings] Rate limit updated → {rps} req/s')
    return jsonify({'ok': True, 'rateLimitRps': _bucket._rate})


@app.route('/settings/credentials', methods=['GET', 'POST'])
def settings_credentials():
    with get_db() as conn:
        if request.method == 'GET':
            return jsonify({
                'data': {
                    'quoApiKeySaved': bool(_credential_get(conn, 'quo_api_key')),
                    'anthropicApiKeySaved': bool(_credential_get(conn, 'anthropic_api_key')),
                    'vagaroClientId': _credential_get(conn, 'vagaro_client_id'),
                    'vagaroRegion': _credential_get(conn, 'vagaro_region'),
                    'vagaroClientSecretSaved': bool(_credential_get(conn, 'vagaro_client_secret')),
                }
            })

        body = request.get_json(silent=True) or {}
        updates = {
            'quo_api_key': body.get('quoApiKey'),
            'anthropic_api_key': body.get('anthropicApiKey'),
            'vagaro_client_id': body.get('vagaroClientId'),
            'vagaro_client_secret': body.get('vagaroClientSecret'),
            'vagaro_region': body.get('vagaroRegion'),
        }
        with conn:
            for key, value in updates.items():
                value = '' if value is None else str(value).strip()
                if value:
                    _credential_upsert(conn, key, value)

        return jsonify({
            'ok': True,
            'data': {
                'quoApiKeySaved': bool(_credential_get(conn, 'quo_api_key')),
                'anthropicApiKeySaved': bool(_credential_get(conn, 'anthropic_api_key')),
                'vagaroClientId': _credential_get(conn, 'vagaro_client_id'),
                'vagaroRegion': _credential_get(conn, 'vagaro_region'),
                'vagaroClientSecretSaved': bool(_credential_get(conn, 'vagaro_client_secret')),
            },
        })

# ── Version ───────────────────────────────────────────────────────────────────
@app.route('/version')
def get_version():
    return jsonify({'version': APP_VERSION, 'changelog': CHANGELOG})

# ── Duplicate detection ───────────────────────────────────────────────────────
def _norm_name(first: str, last: str) -> str:
    """Lowercase, strip punctuation, collapse spaces."""
    raw = f'{first} {last}'.strip().lower()
    raw = re.sub(r"[^\w\s']", '', raw)
    return re.sub(r'\s+', ' ', raw).strip()

def _duplicate_groups(conn):
    rows = conn.execute(
        'SELECT id, first_name, last_name, phone, email, raw FROM contacts'
    ).fetchall()
    dismissed = conn.execute(
        'SELECT id1, id2 FROM dismissed_duplicates'
    ).fetchall()

    dismissed_pairs = {frozenset([r['id1'], r['id2']]) for r in dismissed}

    contacts = [
        {
            'id':         r['id'],
            'first_name': r['first_name'],
            'last_name':  r['last_name'],
            'phone':      r['phone'],
            'email':      r['email'],
            'raw':        json.loads(r['raw']) if r['raw'] else {},
        }
        for r in rows
    ]

    groups  = []
    seen    = set()   # frozensets of id pairs already in a group

    def add_group(reason, group):
        # Deduplicate: only add pairs not already grouped and not dismissed
        pair = frozenset(c['id'] for c in group)
        if pair in seen or pair in dismissed_pairs:
            return
        seen.add(pair)
        groups.append({
            'reason':   reason,
            'contacts': [c['raw'] for c in group],
        })

    # 1. Same phone number
    phone_map = {}
    for c in contacts:
        if c['phone']:
            phone_map.setdefault(c['phone'], []).append(c)
    for phone, group in phone_map.items():
        if len(group) > 1:
            add_group(f'Same phone: {phone}', group[:2])  # show pair at a time

    # 2. Same email
    email_map = {}
    for c in contacts:
        if c['email']:
            email_map.setdefault(c['email'].lower(), []).append(c)
    for email, group in email_map.items():
        if len(group) > 1:
            add_group(f'Same email: {email}', group[:2])

    # 3. Same normalized full name (only when non-trivial)
    name_map = {}
    for c in contacts:
        name = _norm_name(c['first_name'], c['last_name'])
        if name and len(name) > 2:
            name_map.setdefault(name, []).append(c)
    for name, group in name_map.items():
        if len(group) > 1:
            add_group(f'Same name: {name.title()}', group[:2])

    return groups

@app.route('/db/find-duplicates')
def find_duplicates():
    with get_db() as conn:
        groups = _duplicate_groups(conn)
    return jsonify({'groups': groups, 'total': len(groups)})

@app.route('/db/dismiss-duplicate', methods=['POST'])
def dismiss_duplicate():
    body = request.get_json(silent=True) or {}
    id1, id2 = body.get('id1'), body.get('id2')
    if not id1 or not id2:
        return jsonify({'error': 'id1 and id2 required'}), 400
    # Store canonically (smaller id first) so (A,B) == (B,A)
    a, b = sorted([id1, id2])
    with get_db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO dismissed_duplicates (id1, id2) VALUES (?,?)',
            (a, b)
        )
    return jsonify({'ok': True})

@app.route('/db/merge-contacts', methods=['POST'])
def merge_contacts():
    body      = request.get_json(silent=True) or {}
    api_key   = _resolve_quo_api_key(body)
    keep_id   = body.get('keepId')
    delete_id = body.get('deleteId')
    patch     = body.get('patch')    # fields to update on the keeper (optional)

    if not all([api_key, keep_id, delete_id]):
        return jsonify({'error': 'Quo API key, keepId and deleteId required'}), 400
    if keep_id == delete_id:
        return jsonify({'error': 'keepId and deleteId must be different'}), 400

    # 1. Apply any field updates to the keeper
    if patch:
        res, status = quo_request(api_key, 'PATCH', f'/contacts/{keep_id}', patch)
        if status not in (200, 201, 202):
            return jsonify({'error': f'Failed to update keeper: {res}', 'status': status}), 502

    # 2. Delete the duplicate from Quo
    _, del_status = quo_request(api_key, 'DELETE', f'/contacts/{delete_id}')
    deleted_from_quo = del_status in (200, 204)

    # 3. Re-fetch the keeper to get the freshest data, update DB
    full, _ = quo_request(api_key, 'GET', f'/contacts/{keep_id}')
    with get_db() as conn:
        delete_row = conn.execute(
            'SELECT phone FROM contacts WHERE id=?', (delete_id,)
        ).fetchone()
        delete_phone = delete_row['phone'] if delete_row else ''
        if full.get('data'):
            upsert_contact(conn, full['data'])
        conn.execute('DELETE FROM contacts WHERE id=?', (delete_id,))
        if delete_phone:
            conn.execute('DELETE FROM messages WHERE contact_phone=?', (delete_phone,))
        # Remove any dismissed-duplicate entries involving the deleted contact
        conn.execute('DELETE FROM dismissed_duplicates WHERE id1=? OR id2=?',
                     (delete_id, delete_id))

    return jsonify({
        'ok':             True,
        'deletedFromQuo': deleted_from_quo,
        'keeper':         full.get('data'),
    })

# ── Startup ───────────────────────────────────────────────────────────────────
init_db()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    host = os.environ.get('HOST', '0.0.0.0')
    print(f'Message Hub  →  http://{host}:{port}')
    print(f'Workers: sync={SYNC_WORKERS}, verify={VERIFY_WORKERS}')
    try:
        from waitress import serve
        print('Starting with waitress (production mode)')
        serve(app, host=host, port=port, threads=16)
    except ImportError:
        print('waitress not found — falling back to Flask dev server')
        app.run(host=host, port=port, debug=False)
