-- Colegas: mail de Google para compartirles la carpeta de Drive del evento
-- (la misma que se arma desde la ficha del cliente, clients.drive_url) y
-- marca de cuándo se compartió en cada cobertura. Solo agrega columnas.

alter table public.colleagues add column if not exists email text;
grant insert (email), update (email) on public.colleagues to authenticated;

alter table public.colleague_coverages add column if not exists drive_shared_at timestamptz;
alter table public.colleague_coverages add column if not exists drive_shared_email text;
