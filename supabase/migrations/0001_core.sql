-- 0001_core.sql — Stellar Ops core schema
-- Single-tenant-per-company multi-tenancy. Every row is scoped to a company_id,
-- and RLS restricts every table to rows where company_id = get_my_company_id().

-- ---------------------------------------------------------------------------
-- Tenant helper: read the caller's company_id straight off the JWT claims.
-- Supabase embeds app_metadata into the access token, so we look there first
-- (set via auth.users.raw_app_meta_data), then fall back to a top-level claim.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_company_id()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'company_id',
      current_setting('request.jwt.claims', true)::jsonb ->> 'company_id'
    ),
    ''
  )::uuid;
$$;

comment on function public.get_my_company_id() is
  'Returns the company_id claim from the caller''s JWT (app_metadata.company_id). Basis of every RLS policy.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.associations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  name                text not null,
  address             text,
  dropbox_folder_path text,
  created_at          timestamptz not null default now()
);

create table if not exists public.units (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  association_id uuid references public.associations(id) on delete cascade,
  number         text,
  owner_id       uuid,
  created_at     timestamptz not null default now()
);

create table if not exists public.owners (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  name       text not null,
  email      text,
  phone      text,
  unit_id    uuid references public.units(id) on delete set null,
  created_at timestamptz not null default now()
);

-- owner_id <-> unit_id is intentionally a soft link both ways (set after import).
alter table public.units
  drop constraint if exists units_owner_id_fkey;
alter table public.units
  add constraint units_owner_id_fkey
  foreign key (owner_id) references public.owners(id) on delete set null;

create table if not exists public.work_items (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  association_id uuid references public.associations(id) on delete set null,
  unit_id        uuid references public.units(id) on delete set null,
  type           text not null check (type in ('call','email_doc','violation','recurring','task')),
  title          text not null,
  description    text,
  source_channel text,
  status         text not null default 'open'
                   check (status in ('open','in_progress','escalated','done')),
  priority       text not null default 'routine'
                   check (priority in ('emergency','urgent','routine')),
  owner_user_id  uuid references auth.users(id) on delete set null,
  due_date       timestamptz,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  escalated_at   timestamptz,
  metadata       jsonb not null default '{}'::jsonb
);

create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  association_id uuid references public.associations(id) on delete set null,
  work_item_id  uuid references public.work_items(id) on delete set null,
  filename      text not null,
  doc_type      text,
  storage_path  text,
  classified_by text,
  status        text default 'new',
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Natural keys (let the AppFolio CSV import upsert idempotently)
-- ---------------------------------------------------------------------------
create unique index if not exists associations_company_name_key
  on public.associations (company_id, name);
create unique index if not exists units_company_assoc_number_key
  on public.units (company_id, association_id, number);
create unique index if not exists owners_company_email_key
  on public.owners (company_id, email);

-- ---------------------------------------------------------------------------
-- Indexes (the dashboard queries the work queue by status/due and by owner)
-- ---------------------------------------------------------------------------
create index if not exists work_items_company_status_due_idx
  on public.work_items (company_id, status, due_date);

create index if not exists work_items_owner_status_idx
  on public.work_items (owner_user_id, status);

create index if not exists units_association_idx on public.units (association_id);
create index if not exists owners_unit_idx on public.owners (unit_id);
create index if not exists documents_work_item_idx on public.documents (work_item_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — every table: rows where company_id = get_my_company_id()
-- ---------------------------------------------------------------------------
alter table public.associations enable row level security;
alter table public.units        enable row level security;
alter table public.owners       enable row level security;
alter table public.work_items   enable row level security;
alter table public.documents    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['associations','units','owners','work_items','documents']
  loop
    execute format('drop policy if exists %I_company_isolation on public.%I;', t, t);
    execute format(
      'create policy %I_company_isolation on public.%I
         for all to authenticated
         using (company_id = public.get_my_company_id())
         with check (company_id = public.get_my_company_id());',
      t, t
    );
  end loop;
end $$;
