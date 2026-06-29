# Stellar Ops

Internal operations hub for **Stellar Property Group** (HOA/condo management, ~1,200 units).
One queue where every phone call, email, document, violation, and recurring property
obligation lands — so nothing slips. Built on Next.js 16 (App Router) + Supabase.

This is the **Phase 0 + live-queue vertical slice**.

## What's built

- **Auth** — email/password login at `/login`; middleware protects `/ops/*`.
- **Dashboard** (`/ops`) — three live columns (My Queue, Overdue, Today's Emergencies)
  with an association filter and one-click status/claim actions.
- **Schema** (`supabase/migrations/0001_core.sql`) — `associations`, `units`, `owners`,
  `work_items`, `documents`. RLS on every table scopes rows to the caller's company via
  the `get_my_company_id()` JWT helper.
- **AppFolio import** (`scripts/import-appfolio.ts`) — upserts associations/units/owners
  from a CSV export, so you avoid AppFolio's $5/resident API fee.
- **Edge functions** — `escalate-overdue` (flips past-due open items to escalated) and
  `daily-digest` (stub; needs an email key).

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in the values (service role key from the dashboard)
npm run dev                  # http://localhost:3000
```

Sign in with the seeded staff account:

- **Email:** `ops@stellarpropertygroup.com`
- **Password:** `StellarOps2026!`  ← change this in the Supabase dashboard.

## Import real data from AppFolio

Export associations/units/owners to CSV (columns: `association_name,
association_address, unit_number, owner_name, owner_email, owner_phone`), save as
`data/appfolio-export.csv`, then:

```bash
npx tsx scripts/import-appfolio.ts
```

## Edge functions

Deployed via the Supabase MCP. To run locally / redeploy with the CLI:

```bash
supabase functions deploy escalate-overdue
supabase functions deploy daily-digest
```

Schedule `escalate-overdue` daily (Supabase Dashboard → Edge Functions → Schedules, or
pg_cron). Both functions accept an optional `x-cron-secret` header matching `CRON_SECRET`.
