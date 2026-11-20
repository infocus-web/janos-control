-- Tarifa fija con edición: a parte del personal se le paga distinto si
-- además edita (ej. $120.000 sin editar, $140.000 con edición).
-- Solo AGREGA columnas: no toca datos existentes.
--  - colleagues.edit_fee:           tarifa por evento cuando también edita
--  - colleague_coverages.with_edit: ese trabajo fue con edición
alter table public.colleagues add column if not exists edit_fee numeric;
alter table public.colleagues drop constraint if exists colleagues_edit_fee_check;
alter table public.colleagues add constraint colleagues_edit_fee_check check (edit_fee is null or edit_fee >= 0);
-- colleagues usa permisos por columna: hay que habilitar la nueva.
grant select (edit_fee), insert (edit_fee), update (edit_fee) on public.colleagues to authenticated;

alter table public.colleague_coverages add column if not exists with_edit boolean not null default false;
