-- Billing: invoices live at invoices/<id> with data.clientId.
-- The practitioner already has full access ("practitioner can do everything").
-- A client can only READ invoices that are theirs (or a family member's on their sign-in) and have been sent. Drafts stay private. Clients can't change invoices.
drop policy if exists "client reads own invoices" on public.docs;
create policy "client reads own invoices" on public.docs
  for select to authenticated using (
    parent = 'invoices'
    and data ->> 'status' = 'sent'
    and public.owns_client(data ->> 'clientId')
  );
