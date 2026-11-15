-- Avisos para el portal de colegas: cuando el dueño asigna, cambia o quita a
-- alguien de un evento, se guarda un aviso que la colega ve al entrar a
-- /colega.html (y marca como leído desde ahí, vía /api/colleague-portal).
create table if not exists public.colleague_notices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  colleague_id uuid not null references public.colleagues(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  kind text not null check (kind in ('assigned', 'removed', 'changed')),
  message text not null check (char_length(message) between 1 and 1000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists colleague_notices_colleague_idx on public.colleague_notices(colleague_id, read_at);
alter table public.colleague_notices enable row level security;
drop policy if exists colleague_notices_owner_all on public.colleague_notices;
create policy colleague_notices_owner_all on public.colleague_notices for all to authenticated
  using (owner_id = (select auth.uid()) and public.is_app_active())
  with check (owner_id = (select auth.uid()) and public.is_app_active()
    and exists (select 1 from public.colleagues c where c.id = colleague_id and c.owner_id = (select auth.uid())));
revoke all on public.colleague_notices from anon, authenticated;
grant select, insert, delete on public.colleague_notices to authenticated;
