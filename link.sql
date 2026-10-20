-- Wellness From Within portal: connect client records to portal sign-ins.
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
--
-- What it adds:
--  1. claim_portal_record(): when a client signs in, a record Dawn created for them
--     (matched by the email they sign in with) becomes their portal record. Their
--     forms, reports, treatment plans and scan sessions are waiting; nothing to fill in.
--  2. admin_merge_client(): Dawn's "connect by hand" button. Moves everything
--     (forms, plans, reports, scans, photo, notes) from a record she created into a
--     client's portal account.
--  3. Reports moved this way stay openable by the client (the file rule now checks
--     Dawn's "shared" list instead of the folder the file was first uploaded to).

-- Moves record clients/<from_id> and everything under it to clients/<to_id>.
-- Internal: nobody can call it directly from the website.
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
end $$;
revoke all on function public._move_client(text, text) from public, anon, authenticated;

-- Called by the portal when a client signs in.
create or replace function public.claim_portal_record() returns text
language plpgsql security definer set search_path = public as $$
declare
  uid text := auth.uid()::text;
  em  text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  own jsonb; cid text; n int;
begin
  if uid is null or em = '' or public.is_admin() then return null; end if;
  -- A client who has already sent forms from their own sign-in keeps that record; Dawn connects by hand.
  select data into own from docs where path = 'clients/' || uid;
  if own is not null and (own ->> 'intakeStatus' = 'submitted' or own ->> 'qestStatus' = 'submitted'
      or jsonb_array_length(coalesce(own -> 'followupHistory', '[]'::jsonb)) > 0) then
    return null;
  end if;
  select count(*), min(id) into n, cid from docs
    where parent = 'clients' and left(id, 2) = 'c-'
      and em in (lower(trim(coalesce(data ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'intake' ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'qest' ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'followup' ->> 'email', ''))));
  if n <> 1 then return null; end if;   -- none, or more than one record with this email: leave it to Dawn
  perform public._move_client(cid, uid);
  return uid;
end $$;
revoke all on function public.claim_portal_record() from public, anon;
grant execute on function public.claim_portal_record() to authenticated;

-- Dawn's "connect by hand" button.
create or replace function public.admin_merge_client(from_id text, to_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if left(from_id, 2) <> 'c-' or left(to_id, 2) = 'c-' then raise exception 'pick a record you created and a portal account'; end if;
  perform public._move_client(from_id, to_id);
end $$;
revoke all on function public.admin_merge_client(text, text) from public, anon;
grant execute on function public.admin_merge_client(text, text) to authenticated;

-- A client can open a file only when it's on their own list and Dawn has shared it.
drop policy if exists "client opens own shared files" on storage.objects;
create policy "client opens own shared files" on storage.objects
  for select to authenticated using (
    bucket_id = 'client-files'
    and exists (
      select 1 from public.docs d
      where d.parent = 'clients/' || auth.uid()::text || '/files'
        and d.data ->> 'path' = storage.objects.name
        and d.data ->> 'status' = 'shared'
    )
  );
