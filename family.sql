-- Wellness From Within portal: family accounts (one sign-in, several people).
-- Run once in Supabase → SQL Editor → New query → Run, AFTER link.sql. Safe to run again.
--
-- A parent signs in with one email and sees a record for each child (or themselves).
-- Record ids: the sign-in's own id, plus "<sign-in id>~<something>" for each family member.
-- Each person keeps their own forms, photo, treatment plans and reports.

-- Is this client record one the signed-in person may see?
create or replace function public.owns_client(cid text) returns boolean
language sql stable set search_path = public as $$
  select auth.uid() is not null
     and (cid = auth.uid()::text or left(cid, 37) = auth.uid()::text || '~');
$$;
grant execute on function public.owns_client(text) to authenticated;

-- Reading: their records, Qest4 history and photos, and only the plans and files Dawn has shared
drop policy if exists "client reads own" on public.docs;
create policy "client reads own" on public.docs
  for select to authenticated using (
    (parent = 'clients' and public.owns_client(id))
    or (parent ~ '^clients/[^/]+/(qestForms|media)$' and public.owns_client(split_part(parent, '/', 2)))
    or (parent ~ '^clients/[^/]+/(plans|files)$' and public.owns_client(split_part(parent, '/', 2)) and data ->> 'status' = 'shared')
  );
drop policy if exists "client reads own shared files" on public.docs;   -- now covered above

-- Writing: their records (including adding a family member), Qest4 submissions and photos. Never plans, files or notes.
drop policy if exists "client inserts own" on public.docs;
create policy "client inserts own" on public.docs
  for insert to authenticated with check (
    path = parent || '/' || id and (
      (parent = 'clients' and public.owns_client(id))
      or (parent ~ '^clients/[^/]+/(qestForms|media)$' and public.owns_client(split_part(parent, '/', 2))))
  );
drop policy if exists "client updates own" on public.docs;
create policy "client updates own" on public.docs
  for update to authenticated using (
    (parent = 'clients' and public.owns_client(id))
    or (parent ~ '^clients/[^/]+/(qestForms|media)$' and public.owns_client(split_part(parent, '/', 2)))
  ) with check (
    path = parent || '/' || id and (
      (parent = 'clients' and public.owns_client(id))
      or (parent ~ '^clients/[^/]+/(qestForms|media)$' and public.owns_client(split_part(parent, '/', 2))))
  );

-- Report files: a client can open a file only when it's on one of their people's lists and shared
drop policy if exists "client opens own shared files" on storage.objects;
create policy "client opens own shared files" on storage.objects
  for select to authenticated using (
    bucket_id = 'client-files'
    and exists (
      select 1 from public.docs d
      where d.parent ~ '^clients/[^/]+/files$'
        and public.owns_client(split_part(d.parent, '/', 2))
        and d.data ->> 'path' = storage.objects.name
        and d.data ->> 'status' = 'shared'
    )
  );

-- Sign-in: connect every record Dawn created with this email.
-- One record and nothing of their own yet → it becomes their main record (as before).
-- Otherwise each one is added as a family member under this sign-in.
create or replace function public.claim_portal_record() returns text
language plpgsql security definer set search_path = public as $$
declare
  uid text := auth.uid()::text;
  em  text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  own jsonb; own_used boolean; n int; r record; moved int := 0;
begin
  if uid is null or em = '' or public.is_admin() then return null; end if;
  select data into own from docs where path = 'clients/' || uid;
  own_used := own is not null and (
       own ->> 'intakeStatus' = 'submitted' or own ->> 'qestStatus' = 'submitted'
    or jsonb_array_length(coalesce(own -> 'followupHistory', '[]'::jsonb)) > 0
    or coalesce(own ->> 'name', '') <> ''
    or exists (select 1 from docs where left(parent, length('clients/' || uid) + 1) = 'clients/' || uid || '/'));
  select count(*) into n from docs
    where parent = 'clients' and left(id, 2) = 'c-'
      and em in (lower(trim(coalesce(data ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'intake' ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'qest' ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'followup' ->> 'email', ''))));
  if n = 0 then return null; end if;
  for r in select id from docs
    where parent = 'clients' and left(id, 2) = 'c-'
      and em in (lower(trim(coalesce(data ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'intake' ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'qest' ->> 'email', ''))),
                 lower(trim(coalesce(data -> 'followup' ->> 'email', ''))))
    order by id
  loop
    if n = 1 and not own_used then
      perform public._move_client(r.id, uid);
    else
      perform public._move_client(r.id, uid || '~' || substr(r.id, 3));
    end if;
    moved := moved + 1;
  end loop;
  return uid;
end $$;
revoke all on function public.claim_portal_record() from public, anon;
grant execute on function public.claim_portal_record() to authenticated;

-- Dawn: add a record she created to a client's sign-in as a family member.
create or replace function public.admin_add_family(from_id text, account_id text) returns text
language plpgsql security definer set search_path = public as $$
declare acct text := split_part(account_id, '~', 1); to_id text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if left(from_id, 2) <> 'c-' or left(acct, 2) = 'c-' or acct = '' then raise exception 'pick a record you created and a portal account'; end if;
  to_id := acct || '~' || substr(from_id, 3);
  perform public._move_client(from_id, to_id);
  return to_id;
end $$;
revoke all on function public.admin_add_family(text, text) from public, anon;
grant execute on function public.admin_add_family(text, text) to authenticated;
