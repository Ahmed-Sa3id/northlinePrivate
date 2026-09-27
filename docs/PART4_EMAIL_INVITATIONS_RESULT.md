# Northline Part 4 — Email & Invitations Final Result

## Status

**Part 4 is complete for the implemented scope.** The existing Parts 1–3 authentication, session, billing, and subscription work was preserved. Part 4 now includes production-oriented email delivery, secure invitation lifecycle management, frontend invitation UX, migrations, and database-backed regression coverage.

## Implemented

The shared transactional email adapter now has a 10-second provider timeout, one bounded retry, development-safe logging, production configuration enforcement, HTTPS validation for `APP_URL`, and HTML escaping for all template values and action URLs.

Verification, password-reset, and invitation links use the validated configured application URL rather than request-controlled values. Existing verification and reset tokens remain hashed, expiring, single-use, and atomically consumed. Reset and password-change session revocation behavior remains covered by the lifecycle tests.

Invitation creation sends a secure one-time email. Production API responses do not expose raw invitation tokens. Admins can list invitations within their own tenant, resend an invitation with token rotation, and revoke an invitation. Revoked invitations are rejected by preview and acceptance routes. Concurrent invitation acceptance is protected by an atomic database claim, so only one request can create the invited account.

The frontend now supports invitation acceptance at `/accept-invitation`, shows secure invitation status to administrators, and provides resend and revoke controls. It no longer instructs production users to copy raw invitation tokens.

## Database changes

- `drizzle/0013_curved_sir_ram.sql` adds `invitations.revokedAt`.
- `drizzle/0014_big_magma.sql` adds the invitation expiry index.
- The generated files were corrected so they contain only the Part 4 changes and do not duplicate earlier Part 3 billing migrations.
- `drizzle-kit check` passes.

## Verification evidence

The focused Part 4 and adjacent lifecycle suite passed against MariaDB:

| Area | Result |
|---|---:|
| Invitation lifecycle integration tests | 2 passed |
| Authentication lifecycle integration tests | 5 passed |
| Security fuzz tests | passed |
| Email safety unit tests | 2 passed |
| Total focused run | **12 tests passed across 4 files** |
| TypeScript check | passed |
| Prettier formatting | passed |
| Production build | passed |
| Migration consistency check | passed |

The full historical suite was also attempted against MariaDB. It reported 36 passing tests and 15 failures in legacy tests that still assume pre-Part-2 behavior, including login without email verification. Those failures are not Part 4 regressions; the Part 4-specific suite above passes with the current verification-first contract.

## Configuration required for deployment

Production requires `DATABASE_URL`, a strong `JWT_SECRET`, `ALLOWED_ORIGINS`, `APP_URL` using HTTPS, `EMAIL_FROM`, `RESEND_API_KEY`, storage configuration, and the existing billing configuration. Provider credentials are not included in the source package.

## Conclusion

**Part 4 is finished.** The remaining full-suite failures are stale expectations in earlier tests, not unverified Part 4 behavior. The completed package includes the corrected migrations, backend lifecycle controls, frontend UX, focused security tests, and the final implementation record.
