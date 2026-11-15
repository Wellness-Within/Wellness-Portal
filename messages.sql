-- Wellness From Within portal: messages between Dawn and clients.
-- Run once in Supabase → SQL Editor → New query → Run, AFTER family.sql (and notify.sql if you use it). Safe to run again.
--
-- Each person (including each family member) has their own conversation, stored as
--   clients/<person id>/messages/<message id>   with data {from: "client" | "dawn", body, at}
-- Clients can read their own conversation and add messages as themselves. They can't change or delete any message.
-- Dawn (the practitioner) can do everything already, through the existing practitioner rule.

drop policy if exists "client reads own messages" on public.docs;
create policy "client reads own messages" on public.docs
  for select to authenticated using (
    parent ~ '^clients/[^/]+/messages$' and public.owns_client(split_part(parent, '/', 2))
  );

drop policy if exists "client sends messages" on public.docs;
create policy "client sends messages" on public.docs
  for insert to authenticated with check (
    parent ~ '^clients/[^/]+/messages$'
    and path = parent || '/' || id
    and public.owns_client(split_part(parent, '/', 2))
    and data ->> 'from' = 'client'
    and length(coalesce(data ->> 'body', '')) between 1 and 4000
  );

-- When a message arrives: note it on the person's record (so the portal can show "New message"),
-- and, if a client wrote it, ping Dawn the same way new forms do (the ping never includes the message itself).
create extension if not exists pg_net;

create or replace function public.on_new_message() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  cid   text;
  who   text;
  topic text;
begin
  if new.parent !~ '^clients/[^/]+/messages$' then return new; end if;
  cid := split_part(new.parent, '/', 2);

  update public.docs
     set data = data || jsonb_build_object('lastMsg', jsonb_build_object('at', coalesce(new.data ->> 'at', now()::text), 'from', new.data ->> 'from')),
         updated_at = now()
   where path = 'clients/' || cid;

  if new.data ->> 'from' = 'client' then
    begin
      -- reuse the private ntfy topic already set up in notify.sql, so it isn't written down twice
      select substring(p.prosrc from '''topic'',\s*''([^'']+)''') into topic
        from pg_proc p where p.proname = 'notify_new_form' limit 1;
      if topic is not null and topic <> 'YOUR-PRIVATE-TOPIC' then
        select coalesce(nullif(d.data -> 'intake' ->> 'fullName', ''), nullif(d.data -> 'qest' ->> 'fullName', ''),
                        nullif(d.data ->> 'name', ''), nullif(d.data ->> 'email', ''), 'A client')
          into who from public.docs d where d.path = 'clients/' || cid;
        perform net.http_post(
          url     := 'https://ntfy.sh',
          body    := jsonb_build_object(
                       'topic',   topic,
                       'title',   'New portal message',
                       'message', coalesce(who, 'A client') || ' sent you a message. Open your portal to read it.',
                       'click',   'https://portal.dawnspain.com',
                       'email',   'wellnessfromwithin@icloud.com'),
          headers := '{"Content-Type": "application/json"}'::jsonb
        );
      end if;
    exception when others then null;   -- a notification problem must never stop a message from saving
    end;
  end if;
  return new;
end $$;

drop trigger if exists docs_on_new_message on public.docs;
create trigger docs_on_new_message
  after insert on public.docs
  for each row execute function public.on_new_message();
