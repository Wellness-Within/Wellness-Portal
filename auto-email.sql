-- Wellness From Within portal: automatic "you have a new message" emails to clients.
-- Run once in Supabase → SQL Editor, AFTER messages.sql and after the message-email Edge Function is deployed. Safe to run again.
-- When Dawn sends a portal message, this asks the message-email function to email that person a short heads-up
-- (never the message itself). The function sends from the portal mailbox and checks for itself that the
-- newest message really is a fresh one from Dawn, so nothing else can make it send.

create extension if not exists pg_net;

create or replace function public.on_dawn_message() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.parent ~ '^clients/[^/]+/messages$' and new.data ->> 'from' = 'dawn' then
    begin
      perform net.http_post(
        url     := 'https://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/message-email',
        body    := jsonb_build_object('cid', split_part(new.parent, '/', 2)),
        headers := '{"Content-Type": "application/json"}'::jsonb
      );
    exception when others then null;   -- an email problem must never stop a message from saving
    end;
  end if;
  return new;
end $$;

drop trigger if exists docs_on_dawn_message on public.docs;
create trigger docs_on_dawn_message
  after insert on public.docs
  for each row execute function public.on_dawn_message();

-- Tell the portal that automatic emails are on (changes the wording under "Send message").
select public.doc_merge('settings/practice', '{"autoEmail": true}'::jsonb);
