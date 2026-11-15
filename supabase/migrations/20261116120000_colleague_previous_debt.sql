-- Deuda anterior con un colega (trabajos viejos que no se sabe a qué evento
-- corresponden). Se guarda como una cobertura kind = 'debt' SIN evento
-- (client_id null): entra en "Le debés" y se paga con register_colleague_payment
-- igual que cualquier cobertura. No borra ni cambia datos existentes.
alter table public.colleague_coverages alter column client_id drop not null;
alter table public.colleague_coverages drop constraint if exists colleague_coverages_kind_check;
alter table public.colleague_coverages add constraint colleague_coverages_kind_check check (kind in ('event', 'session', 'debt'));
alter table public.colleague_coverages drop constraint if exists colleague_coverages_debt_client_check;
alter table public.colleague_coverages add constraint colleague_coverages_debt_client_check check ((kind = 'debt') = (client_id is null));

-- Mismo control de dueño de siempre, pero la deuda no tiene evento.
create or replace function public.colleague_rows_same_owner()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_table_name = 'colleague_coverages' then
    if (new.client_id is not null and not exists (select 1 from clients where id = new.client_id and owner_id = new.owner_id))
       or not exists (select 1 from colleagues where id = new.colleague_id and owner_id = new.owner_id)
       or (new.payment_id is not null and not exists (select 1 from colleague_payments where id = new.payment_id and owner_id = new.owner_id and colleague_id = new.colleague_id)) then
      raise exception 'La cobertura referencia datos de otro usuario';
    end if;
  elsif tg_table_name in ('colleague_payments', 'colleague_discounts') then
    if not exists (select 1 from colleagues where id = new.colleague_id and owner_id = new.owner_id) then
      raise exception 'El colega no pertenece a este usuario';
    end if;
  elsif tg_table_name = 'colleague_discount_applications' then
    if not exists (
      select 1 from colleague_discounts d join colleague_payments p on p.colleague_id = d.colleague_id
      where d.id = new.discount_id and p.id = new.payment_id and d.owner_id = new.owner_id and p.owner_id = new.owner_id
    ) then
      raise exception 'El descuento y el pago no corresponden al mismo colega';
    end if;
  end if;
  return new;
end;
$function$;
