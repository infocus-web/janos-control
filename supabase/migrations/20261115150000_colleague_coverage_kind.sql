-- Coberturas de colegas: además del evento, se les puede asignar la sesión
-- de fotos del cliente (otra fecha/hora/lugar). Solo agrega columnas y
-- reemplaza la regla "un colega una vez por cliente" por "una vez por
-- cliente y tipo" (más permisiva: no afecta filas existentes).
alter table public.colleague_coverages add column if not exists kind text not null default 'event';
alter table public.colleague_coverages drop constraint if exists colleague_coverages_kind_check;
alter table public.colleague_coverages add constraint colleague_coverages_kind_check check (kind in ('event', 'session'));
alter table public.colleague_coverages add column if not exists work_date date;
alter table public.colleague_coverages drop constraint if exists colleague_coverages_client_id_colleague_id_key;
alter table public.colleague_coverages drop constraint if exists colleague_coverages_client_colleague_kind_key;
alter table public.colleague_coverages add constraint colleague_coverages_client_colleague_kind_key unique (client_id, colleague_id, kind);
