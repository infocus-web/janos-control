-- Hora de inicio del evento. La carga Colegas (reparto / ficha) para citar al
-- personal 90 minutos antes. La app principal no la sincroniza, así que su
-- guardado completo de clientes no la pisa. Solo agrega la columna.
alter table public.clients add column if not exists event_time time;
