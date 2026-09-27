# Northline Production Runbook

## Deployment

Build with `pnpm install --frozen-lockfile && pnpm build`. The runtime command is `NODE_ENV=production node dist-server/index.js`. Deploy the container produced by the repository `Dockerfile` and provide persistent mounts for application uploads only when local development storage is used. Production must use S3-compatible storage.

## Migrations

Provision a disposable or staging MariaDB database first. Set `DATABASE_URL`, then run `pnpm db:push` or the platform's migration command. Migration files are append-only. Confirm the migration journal and application version before deployment. Never edit an applied migration.

## Rollback

Roll back the application image to the previous version only when the schema is backward-compatible. For destructive schema changes, restore the database backup into a new database, validate the previous image, and switch the connection atomically. Do not run ad hoc production SQL.

## Monitoring and logs

Use `/livez` for process liveness and `/readyz` for database-aware readiness. `/health` returns a database status and should be included in deployment smoke checks. Request IDs are returned in `X-Request-ID` and must be included in log aggregation. Logs must be redacted before external shipping; never record passwords, tokens, cookies, authorization headers, or provider secrets.

## Backup and restore

Run `scripts/backup-db.sh` from a protected scheduler with credentials supplied through the environment. Store encrypted backups outside the application host and retain multiple generations. A restore drill must create a new MariaDB database, restore a backup, apply only documented compatibility migrations, connect the application, and verify a company, user, project, and audit record.

## Incident response

First check `/livez`, `/readyz`, database connectivity, recent deployment history, and error rates. Preserve request IDs and timestamps. If tenant exposure is suspected, suspend affected access, preserve audit logs, rotate relevant credentials, and investigate direct-resource authorization. If a secret may be exposed, rotate it immediately and invalidate sessions where appropriate.

## Payment and webhook troubleshooting

Payment processing is not enabled until a provider adapter, signature verification, idempotency ledger, and staging webhook test exist. Once enabled, verify the raw request signature before parsing, record provider event IDs, make event handling idempotent, and reconcile provider state against the company subscription. Never repair payment state from a browser-supplied value.
