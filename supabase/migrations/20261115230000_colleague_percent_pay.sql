-- Personal pagado a porcentaje: % fijo por persona sobre lo que se cobra por
-- la cobertura del evento (tarifa "eventCoverage"/"book"/"informal" según el
-- trabajo, con la tarifa vigente a la fecha del evento). El monto se calcula
-- en la app al asignar. Solo agrega columnas.
alter table public.colleagues add column if not exists pay_mode text not null default 'fixed';
alter table public.colleagues drop constraint if exists colleagues_pay_mode_check;
alter table public.colleagues add constraint colleagues_pay_mode_check check (pay_mode in ('fixed', 'percent'));
alter table public.colleagues add column if not exists pay_percent numeric(5, 2);
alter table public.colleagues drop constraint if exists colleagues_pay_percent_check;
alter table public.colleagues add constraint colleagues_pay_percent_check check (pay_percent is null or (pay_percent > 0 and pay_percent <= 100));
grant insert (pay_mode, pay_percent), update (pay_mode, pay_percent) on public.colleagues to authenticated;
