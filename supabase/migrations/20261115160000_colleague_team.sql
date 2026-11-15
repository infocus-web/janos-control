-- Colegas por equipo: Pablo, Dylan y Gustavo comparten la cuenta (mismos
-- salones) pero cada uno maneja y le paga a su propio personal. Solo agrega
-- la columna; las colegas existentes quedan en el equipo "Pablo".
alter table public.colleagues add column if not exists team text not null default 'Pablo';
grant insert (team), update (team) on public.colleagues to authenticated;
