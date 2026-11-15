-- Pagos parciales ("a cuenta") al personal.
--  - kind = 'advance': pago a cuenta / adelanto. No está ligado a eventos:
--    gross = 0, discounts = 0, net = lo que se le dio.
--  - kind = 'settlement' (los de siempre): paga eventos y puede usar lo
--    adelantado (advance_used), que se resta de lo que se le paga ese día.
-- Saldo a cuenta de un colega = suma(net de advances) - suma(advance_used).
-- Solo agrega columnas y reemplaza la función de registrar pago por una que
-- acepta p_advance (con valor por defecto 0: las llamadas viejas siguen
-- funcionando igual).
alter table public.colleague_payments add column if not exists kind text not null default 'settlement';
alter table public.colleague_payments drop constraint if exists colleague_payments_kind_check;
alter table public.colleague_payments add constraint colleague_payments_kind_check check (kind in ('settlement', 'advance'));
alter table public.colleague_payments add column if not exists advance_used numeric(12, 2) not null default 0;
alter table public.colleague_payments drop constraint if exists colleague_payments_advance_used_check;
alter table public.colleague_payments add constraint colleague_payments_advance_used_check check (advance_used >= 0);

drop function if exists public.register_colleague_payment(uuid, uuid[], jsonb, date, text);
create or replace function public.register_colleague_payment(
  p_colleague_id uuid, p_coverage_ids uuid[], p_discounts jsonb default '[]'::jsonb,
  p_paid_on date default current_date, p_notes text default null, p_advance numeric default 0
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_payment_id uuid;
  v_gross numeric(12, 2) := 0;
  v_discounts numeric(12, 2) := 0;
  v_advance numeric(12, 2) := round(coalesce(p_advance, 0), 2);
  v_credit numeric(12, 2);
  v_count integer;
  v_item jsonb;
  v_amount numeric(12, 2);
  v_remaining numeric(12, 2);
begin
  if not exists (select 1 from colleagues where id = p_colleague_id) then
    raise exception 'Colega no encontrado';
  end if;

  p_coverage_ids := coalesce(p_coverage_ids, '{}');
  select count(*), coalesce(sum(amount), 0) into v_count, v_gross
  from colleague_coverages
  where id = any(p_coverage_ids) and colleague_id = p_colleague_id and payment_id is null;
  if v_count <> cardinality(p_coverage_ids) then
    raise exception 'Alguna cobertura ya estaba paga o no es de este colega';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_discounts, '[]'::jsonb)) loop
    v_amount := round((v_item->>'amount')::numeric, 2);
    if v_amount is null or v_amount <= 0 then continue; end if;
    select d.total_amount - coalesce((select sum(a.amount) from colleague_discount_applications a where a.discount_id = d.id), 0)
      into v_remaining
    from colleague_discounts d
    where d.id = (v_item->>'id')::uuid and d.colleague_id = p_colleague_id;
    if v_remaining is null then raise exception 'Descuento no encontrado'; end if;
    if v_amount > v_remaining then raise exception 'El descuento supera lo que queda por descontar'; end if;
    v_discounts := v_discounts + v_amount;
  end loop;

  if v_advance < 0 then raise exception 'El monto a cuenta no puede ser negativo'; end if;
  if v_advance > 0 then
    select coalesce(sum(case when kind = 'advance' then net else 0 end), 0) - coalesce(sum(advance_used), 0)
      into v_credit
    from colleague_payments where colleague_id = p_colleague_id;
    if v_advance > v_credit then raise exception 'Lo que querés descontar supera lo que le diste a cuenta'; end if;
  end if;

  if v_count = 0 and v_discounts = 0 then
    raise exception 'No hay nada para registrar';
  end if;
  if v_discounts + v_advance > v_gross then
    raise exception 'Los descuentos y lo dado a cuenta no pueden superar lo que se paga';
  end if;

  insert into colleague_payments (colleague_id, paid_on, gross, discounts, net, notes, kind, advance_used)
  values (p_colleague_id, coalesce(p_paid_on, current_date), v_gross, v_discounts, v_gross - v_discounts - v_advance,
          nullif(trim(coalesce(p_notes, '')), ''), 'settlement', v_advance)
  returning id into v_payment_id;

  update colleague_coverages set payment_id = v_payment_id
  where id = any(p_coverage_ids) and colleague_id = p_colleague_id;

  insert into colleague_discount_applications (discount_id, payment_id, amount)
  select (e->>'id')::uuid, v_payment_id, round((e->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_discounts, '[]'::jsonb)) e
  where round((e->>'amount')::numeric, 2) > 0;

  return v_payment_id;
end;
$function$;
grant execute on function public.register_colleague_payment(uuid, uuid[], jsonb, date, text, numeric) to authenticated;
revoke execute on function public.register_colleague_payment(uuid, uuid[], jsonb, date, text, numeric) from anon;
