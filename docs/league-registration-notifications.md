# Oz League registration notifications

New `league_registrations` inserts create a private durable notification. The
`oz-league-registration-email` cron job dispatches one due email each minute to
**flywithcruza@gmail.com** via Resend. No browser changes are needed. Existing
registrations, approvals and jump submissions do not trigger emails.

## Activate

1. In Resend, create a **Sending access** API key for Oz League notifications.
2. In this Supabase project's **Vault**, save the key as a secret named
   `oz_league_resend_api_key`. Never put it in source, a `VITE_` variable or chat.
3. Check the cron job, then send a clearly labelled test notification and inspect
   Resend's delivery status. Provider acceptance alone does not prove inbox delivery.

The initial sender is `Oz League <onboarding@resend.dev>`, which Resend restricts
to the Resend account owner's email. This matches the requested sole recipient.
For a branded sender or other recipients, verify a domain in Resend first and
update the fixed sender in the enqueue function through a migration. Do not use
a competitor-supplied email address as a sender or destination.

## Delivery and security

- Registration commits without calling an external service. A missing key leaves
  requests queued without consuming attempts. Rejected provider credentials or
  invalid configuration stop the affected email for operator review.
- Temporary failures retry with backoff, up to eight attempts. Each email has an
  immutable payload and a stable Resend idempotency key. Ambiguous deliveries
  stop after 23 hours, inside Resend's 24-hour idempotency window, to avoid duplicates.
- The queue and functions have no anonymous, authenticated or service-role grants.
  The narrowly scoped insert trigger runs with owner privileges; delivery runs
  as postgres through Cron. Queue contents are not part of the public API.
- Delivery uses the HTTP extension in the cron worker, with a 10-second timeout.
  No sending credential is placed in pg_net's transport queue. The intermediate
  pg_net implementation was replaced before any key or real email was used;
  its default extension-owned grants could not be revoked by the project role.
- Only name, state council, request time and the review link are emailed. GPS data,
  competitor email addresses and review notes are excluded.
- `accepted_at` means Resend accepted the request, not that Gmail delivered it.
  Check delivery/bounce status in Resend. Keep notifications separate from approval.

Inspect status without reading credentials or message bodies:

```sql
select id, created_at, attempts, accepted_at, last_status, failure
from league_private.registration_notifications
order by created_at desc;
```

Run `tests/leagueRegistrationNotifications.sql` as postgres. It temporarily stubs
the private HTTP transport and rolls back fixtures, placeholder key and stub, so
no test email leaves. Real transport needs a separately labelled test email.
The matching local suit-name migration was renamed to its deployed timestamp
after confirming normalized contents were identical; no database history repair.
