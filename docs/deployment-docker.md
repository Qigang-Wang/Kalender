# Docker Deployment

This deployment target runs Kalender with PostgreSQL through Docker Compose. It is intended
for local machines, NAS devices, or trusted private networks.

Do not expose this version directly to the public internet until authentication, CSRF, CSP,
and other production hardening are in place.

## 1. Create A Database Password

Set a stable PostgreSQL password:

Use a hex value so the password can be safely embedded in `DATABASE_URL` without URL encoding:

```bash
openssl rand -hex 24
```

```env
KALENDER_POSTGRES_PASSWORD=replace-with-the-generated-value
```

## 2. Start The App

```bash
docker compose up --build
```

Open:

```text
http://localhost:3000/today
```

The container starts a same-port realtime gateway. Normal HTTP traffic and the authenticated
WebSocket endpoint at `/api/realtime` both use port `3000`; no additional port is required.
If a reverse proxy is placed in front of the container, enable WebSocket `Upgrade` forwarding.
When WebSocket connectivity is unavailable, visible pages fall back to low-frequency refreshes.

Remote MCP access also requires the reverse proxy hostname in
`KALENDER_MCP_ALLOWED_HOSTS`. Browser-based MCP clients additionally require their exact origin
in `KALENDER_MCP_ALLOWED_ORIGINS`; ordinary CLI clients do not send an `Origin` header.

## 3. Data Persistence

Compose uses three persistent volumes:

- `postgres-data` for PostgreSQL data at `/var/lib/postgresql`.
- `kalender-data` for app-local files such as mail draft attachments at `/app/.data`.
- `kalender-backups` for `.backup` files at `/app/.backups`.

For local development and tests, Compose exposes PostgreSQL on `127.0.0.1:5432`.

Backups created from the app use PostgreSQL native `pg_dump` plus a tarball of draft
attachments. The application automatically keeps its local credential-encryption key in
`/app/.data`, so the `kalender-data` volume must remain persistent. Encrypted backups package
portable credentials protected by the backup password.

Automatic backups do not require a password and include portable mail, calendar, and AI
credentials. Treat every unencrypted backup file as a secret and restrict access to the backup
directory. Manual password encryption remains available from the settings page.
