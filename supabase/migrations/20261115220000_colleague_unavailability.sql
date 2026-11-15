-- Días que el personal bloquea desde su portal ("No puedo este día") y
-- pedido de reemplazo automático cuando ya tenía un trabajo asignado ese día.
-- La colega escribe vía /api/colleague-portal (service role); el dueño solo
-- lee/borra. Solo agrega tabla y columnas.
create table if not exists public.colleague_unavailability (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  colleague_id uuid not null references public.colleagues(id) on delete cascade,
  day date not null,
  reason text check (reason is null or char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  unique (colleague_id, day)
);
create index if not exists colleague_unavailability_owner_day_idx on public.colleague_unavailability(owner_id, day);
alter table public.colleague_unavailability enable row level security;
drop policy if exists colleague_unavailability_owner_read on public.colleague_unavailability;
create policy colleague_unavailability_owner_read on public.colleague_unavailability for select to authenticated
  using (owner_id = (select auth.uid()) and public.is_app_active());
drop policy if exists colleague_unavailability_owner_delete on public.colleague_unavailability;
create policy colleague_unavailability_owner_delete on public.colleague_unavailability for delete to authenticated
  using (owner_id = (select auth.uid()) and public.is_app_active());
revoke all on public.colleague_unavailability from anon, authenticated;
grant select, delete on public.colleague_unavailability to authenticated;

alter table public.colleague_coverages add column if not exists replacement_requested_at timestamptz;
alter table public.colleague_coverages add column if not exists replacement_reason text;
