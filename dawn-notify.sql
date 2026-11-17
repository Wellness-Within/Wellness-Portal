-- Wellness From Within portal: email Dawn's own inbox (from the portal mailbox) when a client writes a message or sends a form.
-- ntfy.sh stopped sending emails for free accounts, so this replaces the email part; ntfy stays for phone notifications.
-- Run once in Supabase SQL Editor after deploying the updated message-email function. Safe to run again.
create extension if not exists pg_net;

-- 1. ntfy: keep the phone notification, drop the email field ntfy now refuses (it made the whole notification fail).
do $$ declare f text; src text; begin
  foreach f in array array['notify_new_form','on_new_message','notify_website_order'] loop
    select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=f;
    if src is not null and src ~ '''email'',\s*''wellnessfromwithin@icloud\.com''' then
      execute regexp_replace(src, ',\s*''email'',\s*''wellnessfromwithin@icloud\.com''', '', 'g');
    end if;
  end loop;
end $$;

-- 2. Email Dawn about new client messages and forms (the message-email function checks everything itself).
create or replace function public.dawn_notify() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare form text;
begin
  if new.parent ~ '^clients/[^/]+/messages$' and new.data ->> 'from' = 'client' and tg_op = 'INSERT' then
    perform net.http_post(url := 'https://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/message-email',
      body := jsonb_build_object('notify', new.path), headers := '{"Content-Type": "application/json"}'::jsonb);
  elsif new.parent = 'clients' then
    foreach form in array array['intake','qest','followup'] loop
      if new.data ->> (form || 'SubmittedAt') is not null and (tg_op = 'INSERT' or new.data ->> (form || 'SubmittedAt') is distinct from old.data ->> (form || 'SubmittedAt')) then
        perform net.http_post(url := 'https://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/message-email',
          body := jsonb_build_object('notify', new.path, 'form', form), headers := '{"Content-Type": "application/json"}'::jsonb);
      end if;
    end loop;
  end if;
  return new;
exception when others then return new;   -- a notification problem must never stop a save
end $$;
drop trigger if exists docs_dawn_notify on public.docs;
create trigger docs_dawn_notify after insert or update on public.docs
  for each row when (new.parent like 'clients%') execute function public.dawn_notify();
