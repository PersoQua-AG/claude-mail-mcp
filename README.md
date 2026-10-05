# claude-mail-mcp

Self-hosted **IMAP / SMTP / CalDAV connector for Claude** with multi-account support. A Streamable HTTP MCP server that lets [Claude.ai](https://claude.ai) read and write your email + calendar against any RFC-compliant mailbox.

> Built because every other Claude email connector targets Gmail. This one is for the rest of us — Mailbox.org, Fastmail, iCloud, Mailcow, iRedMail, Migadu, Nextcloud, your own Postfix box. If your provider speaks IMAP, SMTP and CalDAV, this works. One connector, all your inboxes.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E=20-brightgreen.svg)](https://nodejs.org)

---

## What it does

Exposes 15 MCP tools to Claude:

**Accounts (1)**

| Tool | Purpose |
|------|---------|
| `list_accounts` | List all configured mailboxes — id, label, default flag, From, CalDAV-enabled. Never returns credentials. |

**Mail (10)**

| Tool | Purpose |
|------|---------|
| `list_folders` | Enumerate IMAP mailboxes (`INBOX`, `Sent`, …) |
| `list_messages` | Newest N messages in a folder |
| `search_messages` | Server-side IMAP search (from/to/subject/body/date/flags) |
| `get_message` | Full body + headers + attachment metadata (with `index` and `inline`), embedded parts of forwarded messages included |
| `get_attachment` | Save one attachment to `ATTACHMENT_DIR` and return its path |
| `send_message` | Send via SMTP, optionally copy to Sent folder |
| `create_draft` | Build RFC-822 and APPEND to Drafts |
| `mark_read` | Toggle `\Seen` flag |
| `move_message` | Move between folders |
| `delete_message` | Delete (destructive — prefer move to Trash) |

**Calendar (4)**

| Tool | Purpose |
|------|---------|
| `list_calendars` | Discover CalDAV calendars |
| `list_events` | Events in a time window (recurrences expanded) |
| `create_event` | Add new event (writes to CalDAV) |
| `find_free_slot` | Compute free intervals across one or more calendars |

Every tool accepts an optional `account: "<id>"` parameter to pick a mailbox; omit it to use the default account. So "list unread in INBOX of work account" vs "compare today's calendar across work and personal" both work in one connector.

---

## Why bring-your-own-server?

Hosted email-AI services need full mailbox access. That's a lot of trust to hand to a vendor. This connector flips the model: **you run it, you hold the credentials, no third party between Claude and your inbox**.

- One Node process per mailbox
- Credentials in a single `.env` file
- One Bearer token gates every MCP call
- Add the URL to Claude.ai once, done

---

## Quick start

```bash
git clone https://github.com/maxx3250/claude-mail-mcp.git
cd claude-mail-mcp
npm install
cp .env.example .env
# Generate an AUTH_TOKEN and fill it into .env:
#   echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
npm run build
npm start
```

The server boots with **no mailboxes configured** — that's fine. Add them via the OAuth shim's `/settings` UI (see [Deployment](docs/DEPLOYMENT.md)) or hand-craft an `accounts.json`:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "main",
      "label": "Main",
      "default": true,
      "imap": { "host": "imap.mailbox.org", "port": 993, "user": "you@example.com", "pass": "secret", "tls": true },
      "smtp": { "host": "smtp.mailbox.org", "port": 465, "user": "you@example.com", "pass": "secret", "tls": true },
      "mail": { "defaultFrom": "you@example.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    }
  ]
}
```

Save as `/root/.config/mail-mcp/accounts.json` (chmod 600), or set `ACCOUNTS_FILE=./accounts.json` in `.env` for local dev. The backend re-reads via `fs.watch`, no restart needed.

Smoke test:

```bash
curl http://localhost:3220/health
# {"status":"ok","server":"claude-mail-mcp","version":"0.2.0","accounts":[{…}],…}
```

---

## Connecting from Claude.ai

The server speaks the **Streamable HTTP MCP transport**. To use it from Claude.ai (web), you need an OAuth 2.1 + DCR + PKCE layer in front because Claude.ai does not support raw Bearer auth.

The recommended setup mirrors what [claude-meta-mcp](https://github.com/maxx3250/claude-meta-mcp) uses:

1. Terminate TLS with nginx / Caddy on a public hostname (e.g. `mcp-mail.yourdomain.com`)
2. Put a tiny **OAuth shim** in front that issues short-lived Bearer tokens after a basic-auth login
3. Add the public URL as a Custom Connector in Claude.ai (Settings → Connectors → Add custom)

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full nginx + systemd + shim recipe.

For local testing without a shim, you can call `/mcp` directly with `Authorization: Bearer <AUTH_TOKEN>` from any MCP client that supports custom headers (Claude Desktop config, or a stdio bridge).

---

## Provider notes

### App passwords (mandatory on 2FA accounts)

| Provider | IMAP host | SMTP host | App password page |
|----------|-----------|-----------|---------------------|
| Mailbox.org | `imap.mailbox.org:993` | `smtp.mailbox.org:465` | App passwords aren't needed; main password works |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | <https://app.fastmail.com/settings/security/devicekeys> |
| iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:587` (STARTTLS) | <https://appleid.apple.com> → App-Specific Passwords |
| Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` | <https://myaccount.google.com/apppasswords> |
| Mailcow / iRedMail / Postfix | your server | your server | n/a |

### CalDAV endpoints

| Provider | URL |
|----------|-----|
| Fastmail | `https://caldav.fastmail.com/dav/principals/user/USER@fastmail.com/` |
| Mailbox.org | `https://dav.mailbox.org/caldav/` |
| iCloud | `https://caldav.icloud.com/` |
| Nextcloud | `https://cloud.example.com/remote.php/dav/principals/users/USER/` |

If your provider doesn't speak CalDAV, leave `CALDAV_URL` empty and the calendar tools won't be registered. Mail still works.

---

## Architecture

```
Claude.ai (web)
    │  HTTPS + OAuth 2.1
    ▼
nginx (TLS, /health passthrough)
    │
    ├──▶ /mcp/* ─▶ OAuth shim (Port 3212)  ──▶ Bearer ──▶ this server (Port 3220)
    └──▶ /health ────────────────────────────────────────▶ this server (Port 3220)

this server
    ├── ImapClient   ──▶  imapflow  ──▶  IMAP server (993/143)
    ├── SmtpClient   ──▶  nodemailer ─▶  SMTP server (465/587)
    └── CalDavClient ──▶  tsdav     ──▶  CalDAV server
```

Everything is one Node process. IMAP holds a single long-lived connection with per-call mailbox locks. SMTP and CalDAV are stateless per call.

---

## Security model

See **[SECURITY.md](SECURITY.md)** for the threat model and **[docs/HARDENING.md](docs/HARDENING.md)** for the full operator checklist.

Defaults in one sentence: TLS via Let's Encrypt + HSTS + rate-limited htpasswd + OAuth 2.1 with CSRF guard + non-root systemd unit with `ProtectSystem=strict` + kernel-level loopback-only filter + credentials chmod 600 owned by a dedicated `mailmcp` user.

### Quick summary

- **Transport:** TLS 1.3 (Let's Encrypt, auto-renew), HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
- **Auth:** OAuth 2.1 + DCR + PKCE + JWT (RS256, 1h access, 30d refresh) gated by htpasswd login. CSRF guard on `/settings` POST. Brute-force throttled at nginx (10 req/min on auth endpoints).
- **Process:** Both services run as a dedicated non-root `mailmcp` system user (no shell). Full systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `LockPersonality`, `SystemCallFilter=@system-service ~@privileged @resources`, `MemoryMax=512M`.
- **Network:** Backend + shim bound to `127.0.0.1` only. Shim also blocks non-loopback at kernel level (`IPAddressDeny=any`). UFW default-deny on the host.
- **Storage:** Credentials chmod 600, owned by `mailmcp`, in `/var/lib/mail-mcp/`. htpasswd file chmod 640 (not world-readable). `.env` chmod 640 `root:mailmcp`.
- **Output:** `list_accounts` returns id/label/From — never credentials. Logs never include passwords or Bearer tokens.
- **Destructive tools** (`delete_message`) document irreversibility so Claude.ai surfaces a confirmation step. Prefer `move_message` to a Trash folder for reversibility.
- **Attachments:** `get_attachment` has no target-path parameter — the directory is server-side config (`ATTACHMENT_DIR`), so mail content cannot steer where bytes land. Filenames are rebuilt (separators, NUL, control characters and leading dots stripped, 200-character clamp) and the resolved path is proven to stay inside `ATTACHMENT_DIR`. Oversized attachments are refused from the body structure before the stream opens (`MAX_ATTACHMENT_MB`, default 25). Saved files get `com.apple.quarantine` on macOS; the tool returns a path and never opens or executes a file.

Full threat-model walkthrough and operator hardening checklist in [docs/HARDENING.md](docs/HARDENING.md). Reporting issues: see [SECURITY.md](SECURITY.md).

---

## Roadmap

- **v0.2** ✅ — Multi-account per deployment, browser setup flow (this release)
- **v0.3** — Threading-aware `list_threads` tool, attachment download as base64, calendar invitation (iMIP) sending
- **v0.4** — CardDAV (contacts), JMAP support as an alternative to IMAP for Fastmail/Topicbox
- **v1.0** — Audit log, Prometheus metrics, rate limiting, hardened deployment guide

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- [imapflow](https://imapflow.com/) — modern Promise-based IMAP client
- [nodemailer](https://nodemailer.com/) — the only Node SMTP client worth using
- [tsdav](https://github.com/natelindev/tsdav) — clean TypeScript WebDAV/CalDAV/CardDAV
- [ical.js](https://github.com/kewisch/ical.js) — battle-tested iCalendar parser
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — Anthropic's official MCP SDK

---

Built by [Markus Stöger](https://markusstoeger.com) — WooCommerce, headless commerce and AI integration.
