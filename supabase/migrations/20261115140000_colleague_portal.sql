-- Portal de colegas (/colega.html): cada colega entra con su Gmail y ve los
-- eventos que cubre y los de sus salones asignados (sin montos), marca
-- tareas como hechas y deja notas. Solo AGREGA columnas y tablas.
--
-- Las colegas NO leen estas tablas directo: todo pasa por
-- /api/colleague-portal (service role) que filtra lo que les corresponde.
-- Lo que hacen ellas se guarda aparte (colleague_task_marks /
-- colleague_notes) para que el guardado completo de la app del dueño
-- (syncCloudState) nunca lo pise.

-- Salones asignados a cada colega (el dueño los rota desde la ficha).
alter table public.colleagues add column if not exists salons text[] not null default '{}';
grant insert (salons), update (salons) on public.colleagues to authenticated;

-- Usuario de login de la colega (lo crea /api/colleague-access).
alter table public.colleagues add column if not exists user_id uuid references auth.users(id) on delete set null;
create unique index if not exists colleagues_user_id_key on public.colleagues(user_id) where user_id is not null;

-- Notas que dejan las colegas en un evento (las ven el dueño y la autora).
create table if not exists public.colleague_notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  colleague_id uuid references public.colleagues(id) on delete set null,
  author_name text not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists colleague_notes_owner_client_idx on public.colleague_notes(owner_id, client_id);
alter table public.colleague_notes enable row level security;
drop policy if exists colleague_notes_owner_read on public.colleague_notes;
create policy colleague_notes_owner_read on public.colleague_notes for select to authenticated
  using (owner_id = (select auth.uid()) and public.is_app_active());
drop policy if exists colleague_notes_owner_delete on public.colleague_notes;
create policy colleague_notes_owner_delete on public.colleague_notes for delete to authenticated
  using (owner_id = (select auth.uid()) and public.is_app_active());
revoke all on public.colleague_notes from anon, authenticated;
grant select, delete on public.colleague_notes to authenticated;

-- Tareas que una colega marcó como hechas. El dueño las confirma (y ahí se
-- marca la tarea de verdad, con su rendición si corresponde) o las descarta.
create table if not exists public.colleague_task_marks (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  colleague_id uuid references public.colleagues(id) on delete set null,
  author_name text not null,
  done_at timestamptz not null default now()
);
create index if not exists colleague_task_marks_owner_idx on public.colleague_task_marks(owner_id);
alter table public.colleague_task_marks enable row level security;
drop policy if exists colleague_task_marks_owner_read on public.colleague_task_marks;
create policy colleague_task_marks_owner_read on public.colleague_task_marks for select to authenticated
  using (owner_id = (select auth.uid()) and public.is_app_active());
drop policy if exists colleague_task_marks_owner_delete on public.colleague_task_marks;
create policy colleague_task_marks_owner_delete on public.colleague_task_marks for delete to authenticated
  using (owner_id = (select auth.uid()) and public.is_app_active());
revoke all on public.colleague_task_marks from anon, authenticated;
grant select, delete on public.colleague_task_marks to authenticated;
