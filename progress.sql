-- Progress notes: clients/<id>/progress/<note>. Dawn has full access already.
-- A client can read only the notes Dawn marked "Show to client" (status = shared). Clients can't change them.
drop policy if exists "client reads shared progress" on public.docs;
create policy "client reads shared progress" on public.docs
  for select to authenticated using (
    parent ~ '^clients/[^/]+/progress$'
    and data ->> 'status' = 'shared'
    and public.owns_client(split_part(parent, '/', 2))
  );
