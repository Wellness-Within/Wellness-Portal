-- Wellness From Within portal: automatic client emails (run once in Supabase SQL Editor; safe to run again).
-- 1. When Dawn shares a report or treatment plan, the client-mail function emails the client.
-- 2. Every morning (9:10 am New York time) client-mail sends any scan reminders that are due.
-- The function checks everything itself and marks what it sent, so nothing is ever sent twice.
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.on_shared_for_client() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.parent ~ '^clients/[^/]+/(files|plans)$'
     and new.data ->> 'status' = 'shared'
     and new.data ->> 'emailedAt' is null
     and (tg_op = 'INSERT' or coalesce(old.data ->> 'status', '') <> 'shared') then
    perform net.http_post(
      url     := 'https://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/client-mail',
      body    := jsonb_build_object('path', new.path),
      headers := '{"Content-Type": "application/json"}'::jsonb);
  end if;
  return new;
exception when others then return new;   -- an email problem must never stop a save
end $$;
drop trigger if exists docs_on_shared_for_client on public.docs;
create trigger docs_on_shared_for_client after insert or update on public.docs
  for each row when (new.parent like 'clients/%') execute function public.on_shared_for_client();

-- Daily scan reminders. 14:10 UTC = 9:10 am EST (10:10 am during daylight saving time).
select cron.unschedule(jobid) from cron.job where jobname = 'wfw-daily-client-mail';
select cron.schedule('wfw-daily-client-mail', '10 14 * * *', $cron$
  select net.http_post(
    url     := 'https://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/client-mail',
    body    := '{"sweep": true}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb);
$cron$);
