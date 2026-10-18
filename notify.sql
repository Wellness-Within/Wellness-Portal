-- Wellness From Within portal: email Dawn when a client sends a form.
-- Run once in Supabase → SQL Editor → New query → Run.
-- Uses the free ntfy.sh service to send the email (and, optionally, a phone notification).
-- The message says only which form came in and the client's name; never any answers.

create extension if not exists pg_net;

create or replace function public.notify_new_form() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  which text;
  who   text;
  old_intake text := case when tg_op = 'UPDATE' then old.data ->> 'intakeSubmittedAt' end;
  old_qest   text := case when tg_op = 'UPDATE' then old.data ->> 'qestSubmittedAt' end;
begin
  if new.parent <> 'clients' then return new; end if;
  if new.data ->> 'intakeSubmittedAt' is not null and new.data ->> 'intakeSubmittedAt' is distinct from old_intake then
    which := 'Homeopathy intake';
  elsif new.data ->> 'qestSubmittedAt' is not null and new.data ->> 'qestSubmittedAt' is distinct from old_qest then
    which := 'Qest4 pre-scan form';
  else
    return new;
  end if;
  who := coalesce(nullif(new.data -> 'intake' ->> 'fullName', ''), nullif(new.data -> 'qest' ->> 'fullName', ''), nullif(new.data ->> 'email', ''), 'A client');
  perform net.http_post(
    url     := 'https://ntfy.sh',
    body    := jsonb_build_object(
                 'topic',   'YOUR-PRIVATE-TOPIC',
                 'title',   'New ' || which,
                 'message', who || ' sent their ' || which || '. Open your portal to read it.',
                 'click',   'https://portal.dawnspain.com',
                 'email',   'wellnessfromwithin@icloud.com'),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
exception when others then
  return new;   -- a notification problem must never stop a client's form from saving
end $$;

drop trigger if exists docs_notify_new_form on public.docs;
create trigger docs_notify_new_form
  after insert or update on public.docs
  for each row execute function public.notify_new_form();
