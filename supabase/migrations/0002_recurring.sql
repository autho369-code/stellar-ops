-- 0002_recurring.sql — recurring property obligations engine
-- Templates for the compliance tasks Stellar keeps missing (kitchen rodding,
-- insurance renewals, elevator & fire inspections). A scheduled job materializes
-- each one into a work_item ahead of its due date, then advances the next cycle.

create table if not exists public.recurring_obligations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  association_id  uuid references public.associations(id) on delete cascade,
  title           text not null,
  description     text,
  category        text,                                   -- plumbing | insurance | elevator | fire_safety | ...
  priority        text not null default 'routine'
                    check (priority in ('emergency','urgent','routine')),
  interval_months int  not null check (interval_months > 0),
  lead_time_days  int  not null default 21 check (lead_time_days >= 0),
  next_due_date   date not null,
  last_generated_at timestamptz,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create index if not exists recurring_obligations_company_due_idx
  on public.recurring_obligations (company_id, active, next_due_date);

alter table public.recurring_obligations enable row level security;

drop policy if exists recurring_obligations_company_isolation on public.recurring_obligations;
create policy recurring_obligations_company_isolation on public.recurring_obligations
  for all to authenticated
  using (company_id = public.get_my_company_id())
  with check (company_id = public.get_my_company_id());

-- Core generator. SECURITY DEFINER so both the scheduled service-role job and an
-- authenticated "Generate now" click can call it; we scope explicitly by company
-- since definer rights bypass RLS.
--   p_company NULL  -> caller's company (from JWT) — used by the in-app button
--   p_company <id>  -> that company           — used by the cron edge function
create or replace function public.generate_due_recurring(p_company uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := coalesce(p_company, public.get_my_company_id());
  v_count   int  := 0;
  r record;
begin
  if v_company is null then
    raise exception 'generate_due_recurring: company_id could not be resolved';
  end if;

  for r in
    select * from public.recurring_obligations
    where company_id = v_company
      and active
      and (next_due_date - lead_time_days) <= current_date
  loop
    insert into public.work_items
      (company_id, association_id, type, title, description, source_channel, priority, due_date, metadata)
    values
      (r.company_id, r.association_id, 'recurring', r.title, r.description, 'recurring',
       r.priority, r.next_due_date::timestamptz,
       jsonb_build_object('obligation_id', r.id, 'cycle_due', r.next_due_date));

    update public.recurring_obligations
      set last_generated_at = now(),
          next_due_date = next_due_date + make_interval(months => r.interval_months)
      where id = r.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

grant execute on function public.generate_due_recurring(uuid) to authenticated;
