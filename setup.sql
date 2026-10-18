-- Wellness From Within portal: database setup. Run once in Supabase → SQL Editor → New query → Run.
-- Everything lives in one table of documents. Row-level security decides who can see what.

create table if not exists public.docs (
  path        text primary key,          -- e.g. clients/<id>, clients/<id>/plans/<plan id>, lib/banerji
  parent      text not null,             -- the collection the document sits in
  id          text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
create index if not exists docs_parent_idx on public.docs (parent);

-- Who counts as the practitioner (by sign-in email)
create table if not exists public.admins ( email text primary key );
alter table public.admins enable row level security;   -- no policies: nobody can read or change it from the website

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
grant execute on function public.is_admin() to authenticated;

alter table public.docs enable row level security;

drop policy if exists "practitioner can do everything" on public.docs;
create policy "practitioner can do everything" on public.docs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- A client sees their own record, their Qest4 history and photo, and only the remedy plans marked shared
drop policy if exists "client reads own" on public.docs;
create policy "client reads own" on public.docs
  for select to authenticated using (
    path = 'clients/' || auth.uid()::text
    or (parent in ('clients/' || auth.uid()::text || '/qestForms', 'clients/' || auth.uid()::text || '/media'))
    or (parent = 'clients/' || auth.uid()::text || '/plans' and data ->> 'status' = 'shared')
  );

-- A client writes only their own record, Qest4 submissions and photo (never plans, notes or anything else)
drop policy if exists "client inserts own" on public.docs;
create policy "client inserts own" on public.docs
  for insert to authenticated with check (
    path = 'clients/' || auth.uid()::text
    or parent in ('clients/' || auth.uid()::text || '/qestForms', 'clients/' || auth.uid()::text || '/media')
  );
drop policy if exists "client updates own" on public.docs;
create policy "client updates own" on public.docs
  for update to authenticated using (
    path = 'clients/' || auth.uid()::text
    or parent in ('clients/' || auth.uid()::text || '/qestForms', 'clients/' || auth.uid()::text || '/media')
  ) with check (
    path = 'clients/' || auth.uid()::text
    or parent in ('clients/' || auth.uid()::text || '/qestForms', 'clients/' || auth.uid()::text || '/media')
  );

-- Merge fields into a document (creates it if missing); runs with the caller's own permissions
create or replace function public.doc_merge(p_path text, p_data jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into public.docs (path, parent, id, data, updated_at)
  values (p_path, regexp_replace(p_path, '/[^/]+$', ''), regexp_replace(p_path, '^.*/', ''), p_data, now())
  on conflict (path) do update set data = public.docs.data || excluded.data, updated_at = now();
$$;
grant execute on function public.doc_merge(text, jsonb) to authenticated;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.docs to authenticated;
revoke all on public.docs from anon;

-- Live updates in the portal
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- The practitioner's sign-in email (change it here if you sign in with a different address)
insert into public.admins (email) values ('wellnessfromwithin@icloud.com') on conflict do nothing;
