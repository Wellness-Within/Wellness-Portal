-- Wellness From Within portal: email clients each portal message Dawn sends them (the message is in the email).
-- Run once in Supabase → SQL Editor, AFTER messages.sql and after the message-email Edge Function is deployed. Safe to run again.
-- When Dawn sends a portal message, this asks the message-email function to email it to that person.
-- The function sends from the portal mailbox, with replies going to Dawn's own inbox, and checks for itself
-- that the message really is a fresh one from Dawn that hasn't been emailed yet, so nothing else can make it send.

create extension if not exists pg_net;

create or replace function public.on_dawn_message() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.parent ~ '^clients/[^/]+/messages$' and new.data ->> 'from' = 'dawn' then
    begin
      perform net.http_post(
        url     := 'https://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/message-email',
        body    := jsonb_build_object('path', new.path),
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
