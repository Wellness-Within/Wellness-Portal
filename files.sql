-- Wellness From Within portal: client reports & files.
-- Run once in Supabase → SQL Editor → New query → Run.

-- Private storage bucket (50 MB per file)
insert into storage.buckets (id, name, public, file_size_limit)
values ('client-files', 'client-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- Clients can read the list of files Dawn has shared with them (never the private ones)
drop policy if exists "client reads own shared files" on public.docs;
create policy "client reads own shared files" on public.docs
  for select to authenticated using (
    parent = 'clients/' || auth.uid()::text || '/files' and data ->> 'status' = 'shared'
  );

-- Dawn can upload, open and delete everything in the bucket
drop policy if exists "practitioner manages client files" on storage.objects;
create policy "practitioner manages client files" on storage.objects
  for all to authenticated
  using (bucket_id = 'client-files' and public.is_admin())
  with check (bucket_id = 'client-files' and public.is_admin());

-- A client can open only their own files, and only ones Dawn has shared
drop policy if exists "client opens own shared files" on storage.objects;
create policy "client opens own shared files" on storage.objects
  for select to authenticated using (
    bucket_id = 'client-files'
    and (storage.foldername(storage.objects.name))[1] = auth.uid()::text
    and exists (
      select 1 from public.docs d
      where d.parent = 'clients/' || auth.uid()::text || '/files'
        and d.data ->> 'path' = storage.objects.name
        and d.data ->> 'status' = 'shared'
    )
  );
