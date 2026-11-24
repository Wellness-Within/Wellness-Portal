-- Wellness From Within portal: website orders (WooCommerce on dawnspain.com) -> portal.
-- Run once in Supabase SQL Editor. Safe to run again.
-- 1. When a client record is connected to a sign-in, its invoices and standing discount move with it.
-- 2. A website order that lands in the portal pings Dawn (same private ntfy topic as forms and messages).

create or replace function public._move_client(from_id text, to_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  fp text := 'clients/' || from_id;
  tp text := 'clients/' || to_id;
  fdata jsonb; tdata jsonb; tclean jsonb;
  nfrom text; nto text;
begin
  if from_id is null or to_id is null or from_id = to_id then raise exception 'bad ids'; end if;
  select data into fdata from docs where path = fp for update;
  if fdata is null then raise exception 'record not found'; end if;
  select data into tdata from docs where path = tp for update;

  -- Combine: Dawn's record, with anything the client already filled in on top
  select coalesce(jsonb_object_agg(key, value) filter (where value not in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb)), '{}'::jsonb)
    into tclean from jsonb_each(coalesce(tdata, '{}'::jsonb));

  -- Sub-documents (plans, files, scans, Qest4 history, photo): keep the client's copy if both exist
  delete from docs f where left(f.path, length(fp) + 1) = fp || '/'
    and exists (select 1 from docs t where t.path = tp || substr(f.path, length(fp) + 1));
  update docs set path   = tp || substr(path, length(fp) + 1),
                  parent = tp || substr(parent, length(fp) + 1),
                  updated_at = now()
    where left(path, length(fp) + 1) = fp || '/';

  -- The record itself
  delete from docs where path = tp;
  update docs set path = tp, id = to_id, data = fdata || tclean, updated_at = now() where path = fp;

  -- Private notes
  select data ->> 'text' into nfrom from docs where path = 'notes/' || from_id;
  if found then
    select data ->> 'text' into nto from docs where path = 'notes/' || to_id;
    delete from docs where path = 'notes/' || to_id;
    update docs set path = 'notes/' || to_id, id = to_id,
      data = jsonb_build_object('text', concat_ws(E'\n\n', nullif(nto, ''), nullif(nfrom, '')), 'updatedAt', now())
      where path = 'notes/' || from_id;
  end if;

  -- Saved repertory cases that point at the old record
  update docs set data = jsonb_set(data, '{clientId}', to_jsonb(to_id)), updated_at = now()
    where parent = 'cases' and data ->> 'clientId' = from_id;

  -- Invoices and a standing discount that belong to the old record
  update docs set data = jsonb_set(data, '{clientId}', to_jsonb(to_id)), updated_at = now()
    where parent = 'invoices' and data ->> 'clientId' = from_id;
  update docs set data = jsonb_set(data, '{billing,clientDiscounts}',
      ((data #> '{billing,clientDiscounts}') - from_id) || jsonb_build_object(to_id, data #> array['billing','clientDiscounts',from_id])), updated_at = now()
    where path = 'settings/practice' and (data #> '{billing,clientDiscounts}') ? from_id;
end $$;
revoke all on function public._move_client(text, text) from public, anon, authenticated;

create or replace function public.notify_website_order() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare topic text; who text;
begin
  if new.parent <> 'invoices' or coalesce(new.data ->> 'source', '') <> 'website' then return new; end if;
  select substring(p.prosrc from '''topic'',\s*''([^'']+)''') into topic from pg_proc p where p.proname = 'notify_new_form' limit 1;
  if topic is null or topic = 'YOUR-PRIVATE-TOPIC' then return new; end if;
  select coalesce(nullif(d.data -> 'intake' ->> 'fullName', ''), nullif(d.data -> 'qest' ->> 'fullName', ''), nullif(d.data ->> 'name', ''), nullif(d.data ->> 'email', ''), 'A client')
    into who from public.docs d where d.path = 'clients/' || (new.data ->> 'clientId');
  perform net.http_post(
    url     := 'https://ntfy.sh',
    body    := jsonb_build_object('topic', topic, 'title', 'New website order',
                 'message', coalesce(who, 'A client') || ' ordered on your website (' || coalesce(new.data ->> 'number', '') || '). It is in your portal under Billing.',
                 'click', 'https://portal.dawnspain.com', 'priority', 4),  -- high priority
    headers := '{"Content-Type": "application/json"}'::jsonb);
  return new;
exception when others then return new;
end $$;
drop trigger if exists docs_notify_website_order on public.docs;
create trigger docs_notify_website_order after insert on public.docs
  for each row when (new.parent = 'invoices') execute function public.notify_website_order();
