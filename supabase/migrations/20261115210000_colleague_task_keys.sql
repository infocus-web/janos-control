-- Tareas asignadas a cada persona del personal: el dueño elige en su ficha
-- qué tipos de tarea (tasks.task_key) ve y puede tildar en el portal. Vacío =
-- no ve tareas. Solo agrega la columna.
alter table public.colleagues add column if not exists task_keys text[] not null default '{}';
grant insert (task_keys), update (task_keys) on public.colleagues to authenticated;
