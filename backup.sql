-- Wellness From Within portal: weekly backup of your portal data (run once; safe to run again).
-- Every Sunday night a copy of all client records, forms, plans, notes, invoices, messages and settings is saved
-- in the private "backups" table. The last 8 are kept. Only Dawn can see or download them (Settings → Backups).
-- Not included: the reference books and protocol library (they can be reloaded) and uploaded report files (kept in storage).
create extension if not exists pg_cron;
create table if not exists public.backups (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  items int not null,
  data jsonb not null
);
alter table public.backups enable row level security;
drop policy if exists "practitioner reads backups" on public.backups;
create policy "practitioner reads backups" on public.backups for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.backups from anon, authenticated;

create or replace function public.make_backup() returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'not allowed'; end if;
  insert into backups (items, data)
    select count(*), coalesce(jsonb_agg(jsonb_build_object('path', path, 'data', data) order by path), '[]'::jsonb)
    from docs where split_part(path, '/', 1) not in ('books', 'lib')
  returning id into new_id;
  delete from backups where id not in (select id from backups order by created_at desc limit 8);
  return new_id;
end $$;
revoke all on function public.make_backup() from public, anon;
grant execute on function public.make_backup() to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'wfw-weekly-backup';
select cron.schedule('wfw-weekly-backup', '0 7 * * 1', $cron$ select public.make_backup(); $cron$);  -- Mondays 07:00 UTC (Sunday night ET)
select public.make_backup();  -- a first one right away
