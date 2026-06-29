-- 0003_email.sql — Outlook ingestion support
-- Tracks which Graph messages we've already turned into work_items, so the
-- poller is idempotent and never double-creates a task for the same email.

create table if not exists public.processed_emails (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  graph_message_id text not null,
  mailbox          text,
  subject          text,
  from_address     text,
  work_item_id     uuid references public.work_items(id) on delete set null,
  draft_created    boolean not null default false,
  processed_at     timestamptz not null default now(),
  unique (company_id, graph_message_id)
);

create index if not exists processed_emails_company_idx
  on public.processed_emails (company_id, processed_at desc);

alter table public.processed_emails enable row level security;

drop policy if exists processed_emails_company_isolation on public.processed_emails;
create policy processed_emails_company_isolation on public.processed_emails
  for all to authenticated
  using (company_id = public.get_my_company_id())
  with check (company_id = public.get_my_company_id());
