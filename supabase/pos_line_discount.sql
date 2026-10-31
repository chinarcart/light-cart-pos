-- Per-line discounts for Light Cart POS.
--
-- pos_transaction_items.line_discount already exists (default 0) and has never
-- been written. This teaches pos_create_sale and partial refunds to use it.
-- Bills with no line discount keep the same subtotal, discount, total, and
-- refund amount as before.
--
-- subtotal  = sum of unit price × quantity (before any discount)
-- discount  = bill discount, including loyalty rupees the till already folds in
-- total     = subtotal − line discounts − discount
--
-- Apply this on the live Supabase project (chinarcart's Project) before the
-- till UI that sends lineDiscount is deployed. Do not publish a Windows OTA
-- for this; the counter page is the website.

create or replace function public.pos_create_sale(
  p_items jsonb,
  p_payment_method text default 'cash'::text,
  p_payment_ref text default null::text,
  p_discount numeric default 0,
  p_amount_tendered numeric default null::numeric,
  p_notes text default null::text,
  p_client_sale_id text default null::text,
  p_invoice_number text default null::text,
  p_payments jsonb default null::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_store_id uuid;
  v_tx_id uuid;
  v_items jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_subtotal numeric(12, 2) := 0;
  v_line_discounts numeric(12, 2) := 0;
  v_discount numeric(12, 2) := 0;
  v_total numeric(12, 2);
  v_change numeric(12, 2);
  v_method text := lower(coalesce(nullif(trim(p_payment_method), ''), 'cash'));
  v_client_id text := nullif(trim(p_client_sale_id), '');
  v_invoice text := nullif(trim(p_invoice_number), '');
  v_item jsonb;
  v_product_id uuid;
  v_variant_id uuid;
  v_variant_name text;
  v_qty integer;
  v_requested_price numeric(12, 2);
  v_catalog_price numeric(12, 2);
  v_price numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_barcode text;
  v_owner uuid;
  v_is_merchant boolean := public.is_merchant();
  v_role text := public.staff_role();
  v_can_override boolean;
  v_pay jsonb;
  v_pay_method text;
  v_pay_amount numeric(12, 2);
  v_pay_tendered numeric(12, 2);
  v_pay_ref text;
  v_pay_sum numeric(12, 2) := 0;
  v_cash_amount numeric(12, 2) := 0;
  v_cash_tendered numeric(12, 2);
  v_tender_count integer := 0;
  v_header_ref text := nullif(trim(p_payment_ref), '');
begin
  if not public.can_run_pos() then
    raise exception 'POS access required';
  end if;

  if p_items is null
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Sale must include at least one item';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', g.product_id,
        'variant_id', g.variant_id,
        'barcode', g.barcode,
        'quantity', g.quantity,
        'unit_price', g.unit_price,
        'line_discount', g.line_discount
      )
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      coalesce(x->>'product_id', x->>'productId') as product_id,
      nullif(coalesce(x->>'variant_id', x->>'variantId'), '') as variant_id,
      max(nullif(trim(coalesce(x->>'barcode', '')), '')) as barcode,
      sum((coalesce(x->>'quantity', '0'))::integer)::integer as quantity,
      max((coalesce(x->>'unit_price', x->>'unitPrice', '0'))::numeric) as unit_price,
      sum(
        greatest(
          coalesce(
            nullif(coalesce(x->>'line_discount', x->>'lineDiscount'), '')::numeric,
            0
          ),
          0
        )
      ) as line_discount
    from jsonb_array_elements(p_items) x
    group by 1, 2
  ) g;

  if jsonb_array_length(v_items) > 200 then
    raise exception 'Sale cannot contain more than 200 lines';
  end if;

  v_store_id := public.operator_store_id();
  if v_store_id is null then
    raise exception 'No active store linked to this account';
  end if;

  if v_client_id is not null then
    select id
    into v_tx_id
    from public.pos_transactions
    where store_id = v_store_id
      and client_sale_id = v_client_id;

    if v_tx_id is not null then
      return v_tx_id;
    end if;
  end if;

  if not v_is_merchant and v_client_id is null then
    perform 1
    from public.pos_shifts
    where store_id = v_store_id
      and status = 'open'
    for share;

    if not found then
      raise exception 'Open a cash shift before taking staff sales';
    end if;
  end if;

  v_can_override := v_is_merchant or v_role in ('manager', 'full');

  for v_item in select * from jsonb_array_elements(v_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := nullif(v_item->>'variant_id', '')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    v_requested_price := (v_item->>'unit_price')::numeric;
    v_barcode := nullif(trim(v_item->>'barcode'), '');
    v_line_discount := greatest(coalesce((v_item->>'line_discount')::numeric, 0), 0);

    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity for product %', v_product_id;
    end if;
    if v_requested_price is null or v_requested_price < 0 then
      raise exception 'Invalid unit price for product %', v_product_id;
    end if;

    select p.price
    into v_catalog_price
    from public.products p
    where p.id = v_product_id
      and p.store_id = v_store_id
    for update;

    if not found and v_barcode is not null then
      select p.id, p.price
      into v_product_id, v_catalog_price
      from public.products p
      where p.store_id = v_store_id
        and p.barcode = v_barcode
      for update;
    end if;

    if not found then
      raise exception 'Product not found: %', coalesce(v_barcode, v_product_id::text);
    end if;

    v_variant_name := null;
    if v_variant_id is not null then
      select pv.price, pv.name
      into v_catalog_price, v_variant_name
      from public.product_variants pv
      where pv.id = v_variant_id
        and pv.product_id = v_product_id
      for update;

      if not found then
        v_variant_id := null;
        v_variant_name := null;
      end if;
    end if;

    if not v_can_override
      and abs(v_requested_price - v_catalog_price) > 0.009 then
      raise exception 'Price override is not allowed for cashier accounts';
    end if;

    v_price := case
      when v_can_override then v_requested_price
      else v_catalog_price
    end;
    v_line_discount := round(least(v_line_discount, v_price * v_qty), 2);
    v_subtotal := v_subtotal + (v_price * v_qty);
    v_line_discounts := v_line_discounts + v_line_discount;

    v_resolved := v_resolved || jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product_id,
        'variant_id', v_variant_id,
        'quantity', v_qty,
        'unit_price', v_price,
        'line_discount', v_line_discount
      )
    );
  end loop;

  v_items := v_resolved;
  v_discount := least(
    greatest(coalesce(p_discount, 0), 0),
    greatest(v_subtotal - v_line_discounts, 0)
  );
  v_total := v_subtotal - v_line_discounts - v_discount;

  if p_payments is not null
    and jsonb_typeof(p_payments) = 'array'
    and jsonb_array_length(p_payments) > 0 then
    for v_pay in select * from jsonb_array_elements(p_payments)
    loop
      v_pay_method := lower(coalesce(nullif(trim(v_pay->>'method'), ''), ''));
      v_pay_amount := coalesce((v_pay->>'amount')::numeric, 0);
      if v_pay_method not in ('cash', 'upi', 'card') then
        raise exception 'Invalid tender method: %', v_pay_method;
      end if;
      if v_pay_amount < 0 then
        raise exception 'Tender amount cannot be negative';
      end if;
      if v_pay_amount = 0 then
        continue;
      end if;
      v_pay_sum := v_pay_sum + v_pay_amount;
      v_tender_count := v_tender_count + 1;
      if v_pay_method = 'cash' then
        v_cash_amount := v_cash_amount + v_pay_amount;
        v_cash_tendered := coalesce(
          (v_pay->>'tendered')::numeric,
          (v_pay->>'amount_tendered')::numeric,
          p_amount_tendered
        );
      end if;
    end loop;

    if abs(v_pay_sum - v_total) > 0.02 then
      raise exception 'Tenders (₹%) must equal bill total (₹%)', v_pay_sum, v_total;
    end if;

    if v_tender_count > 1 then
      v_method := 'split';
    elsif v_cash_amount > 0 and v_tender_count = 1 then
      v_method := 'cash';
    else
      select lower(x->>'method')
      into v_method
      from jsonb_array_elements(p_payments) x
      where coalesce((x->>'amount')::numeric, 0) > 0
      limit 1;
      v_method := coalesce(v_method, 'cash');
    end if;

    if v_cash_amount > 0 and v_cash_tendered is not null then
      if v_cash_tendered + 0.009 < v_cash_amount then
        raise exception 'Cash tendered is less than the cash portion';
      end if;
      v_change := v_cash_tendered - v_cash_amount;
    else
      v_change := null;
    end if;
  else
    if v_method not in ('cash', 'upi', 'card') then
      raise exception 'Invalid payment method: %', v_method;
    end if;
    if v_method = 'cash' and p_amount_tendered is not null then
      if p_amount_tendered < v_total then
        raise exception 'Amount tendered is less than the total due';
      end if;
      v_change := p_amount_tendered - v_total;
      v_cash_tendered := p_amount_tendered;
      v_cash_amount := v_total;
    else
      v_change := null;
    end if;
  end if;

  select m.user_id
  into v_owner
  from public.merchants m
  where m.store_id = v_store_id
  limit 1;
  v_owner := coalesce(v_owner, auth.uid());

  if v_invoice is null
    or v_invoice ~* '^LOCAL-'
    or v_invoice ~* '^POS-[0-9A-F]{8}$' then
    begin
      v_invoice := public.merchant_allocate_invoice(null);
    exception
      when others then
        if v_invoice is null and v_client_id is not null then
          v_invoice := 'POS-' || upper(substr(v_client_id, 1, 8));
        end if;
    end;
  end if;

  begin
    insert into public.pos_transactions (
      store_id,
      merchant_user_id,
      cashier_user_id,
      subtotal,
      discount,
      total,
      payment_method,
      payment_status,
      payment_ref,
      amount_tendered,
      change_due,
      notes,
      client_sale_id,
      invoice_number
    ) values (
      v_store_id,
      v_owner,
      auth.uid(),
      v_subtotal,
      v_discount,
      v_total,
      v_method,
      'completed',
      v_header_ref,
      case
        when v_cash_amount > 0 then coalesce(v_cash_tendered, v_cash_amount)
        else null
      end,
      v_change,
      nullif(trim(p_notes), ''),
      v_client_id,
      v_invoice
    )
    returning id into v_tx_id;
  exception
    when unique_violation then
      if v_client_id is null then
        v_invoice := public.merchant_allocate_invoice(null);
        insert into public.pos_transactions (
          store_id,
          merchant_user_id,
          cashier_user_id,
          subtotal,
          discount,
          total,
          payment_method,
          payment_status,
          payment_ref,
          amount_tendered,
          change_due,
          notes,
          client_sale_id,
          invoice_number
        ) values (
          v_store_id,
          v_owner,
          auth.uid(),
          v_subtotal,
          v_discount,
          v_total,
          v_method,
          'completed',
          v_header_ref,
          case
            when v_cash_amount > 0 then coalesce(v_cash_tendered, v_cash_amount)
            else null
          end,
          v_change,
          nullif(trim(p_notes), ''),
          v_client_id,
          v_invoice
        )
        returning id into v_tx_id;
      else
        select id
        into v_tx_id
        from public.pos_transactions
        where store_id = v_store_id
          and client_sale_id = v_client_id;
        if v_tx_id is null then
          raise;
        end if;
        return v_tx_id;
      end if;
  end;

  if p_payments is not null
    and jsonb_typeof(p_payments) = 'array'
    and jsonb_array_length(p_payments) > 0 then
    for v_pay in select * from jsonb_array_elements(p_payments)
    loop
      v_pay_method := lower(coalesce(nullif(trim(v_pay->>'method'), ''), ''));
      v_pay_amount := coalesce((v_pay->>'amount')::numeric, 0);
      if v_pay_amount <= 0 then
        continue;
      end if;
      v_pay_tendered := coalesce(
        (v_pay->>'tendered')::numeric,
        (v_pay->>'amount_tendered')::numeric
      );
      v_pay_ref := nullif(trim(v_pay->>'reference'), '');
      insert into public.pos_payment_tenders (
        store_id, transaction_id, method, amount, amount_tendered, payment_ref
      ) values (
        v_store_id,
        v_tx_id,
        v_pay_method,
        v_pay_amount,
        case when v_pay_method = 'cash' then v_pay_tendered else null end,
        v_pay_ref
      );
    end loop;
  else
    insert into public.pos_payment_tenders (
      store_id, transaction_id, method, amount, amount_tendered, payment_ref
    ) values (
      v_store_id,
      v_tx_id,
      v_method,
      v_total,
      case when v_method = 'cash' then p_amount_tendered else null end,
      v_header_ref
    );
  end if;

  for v_item in select * from jsonb_array_elements(v_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := nullif(v_item->>'variant_id', '')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    v_price := (v_item->>'unit_price')::numeric;
    v_line_discount := coalesce((v_item->>'line_discount')::numeric, 0);

    v_variant_name := null;
    if v_variant_id is not null then
      select pv.name
      into v_variant_name
      from public.product_variants pv
      where pv.id = v_variant_id
        and pv.product_id = v_product_id;
      if not found then
        v_variant_id := null;
        v_variant_name := null;
      end if;
    end if;

    insert into public.pos_transaction_items (
      transaction_id,
      product_id,
      variant_id,
      variant_name,
      quantity,
      unit_price,
      line_discount
    ) values (
      v_tx_id,
      v_product_id,
      v_variant_id,
      v_variant_name,
      v_qty,
      v_price,
      v_line_discount
    );

    update public.products
    set stock_count = stock_count - v_qty
    where id = v_product_id
      and store_id = v_store_id;

    if v_variant_id is not null then
      update public.product_variants
      set stock_count = stock_count - v_qty
      where id = v_variant_id
        and product_id = v_product_id;
    end if;

    insert into public.stock_adjustments (
      store_id,
      product_id,
      delta,
      reason,
      reference_id,
      created_by
    ) values (
      v_store_id,
      v_product_id,
      -v_qty,
      'pos_sale',
      v_tx_id,
      auth.uid()
    );
  end loop;

  return v_tx_id;
end;
$function$;

create or replace function public.merchant_refund_pos_lines(
  p_sale_id uuid,
  p_lines jsonb,
  p_reason text default 'Partial return'::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_store_id uuid;
  v_tx record;
  v_line jsonb;
  v_item_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_qty integer;
  v_sold integer;
  v_refunded integer;
  v_unit numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_refund_net numeric(12, 2) := 0;
  v_lines_off numeric(12, 2) := 0;
  v_net_base numeric(12, 2) := 0;
  v_refund_amount numeric(12, 2) := 0;
  v_all_done boolean;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'Partial return');
  v_audit_lines jsonb := '[]'::jsonb;
begin
  if not public.is_merchant() then
    raise exception 'Merchant access required';
  end if;

  v_store_id := public.merchant_store_id();
  select * into v_tx
  from public.pos_transactions
  where id = p_sale_id
    and store_id = v_store_id
  for update;
  if not found then
    raise exception 'Sale not found';
  end if;
  if v_tx.payment_status = 'refunded' then
    raise exception 'Sale is already fully refunded';
  end if;
  if v_tx.payment_status not in ('completed', 'partially_refunded') then
    raise exception 'Only completed sales can be refunded';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select at least one line to refund';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) x
    group by x->>'product_id', coalesce(x->>'variant_id', '')
    having count(*) > 1
  ) then
    raise exception 'Duplicate refund line';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_product_id := (v_line->>'product_id')::uuid;
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    v_qty := (v_line->>'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'Invalid refund quantity';
    end if;

    select i.id, i.quantity, i.unit_price, coalesce(i.refunded_qty, 0), coalesce(i.line_discount, 0)
    into v_item_id, v_sold, v_unit, v_refunded, v_line_discount
    from public.pos_transaction_items i
    where i.transaction_id = v_tx.id
      and i.product_id = v_product_id
      and i.variant_id is not distinct from v_variant_id
    for update;
    if not found then
      raise exception 'Line not on this sale';
    end if;
    if v_qty > (v_sold - v_refunded) then
      raise exception 'Refund quantity exceeds remaining quantity';
    end if;

    update public.pos_transaction_items
    set refunded_qty = refunded_qty + v_qty
    where id = v_item_id;

    update public.products
    set stock_count = stock_count + v_qty,
        is_available = true
    where id = v_product_id
      and store_id = v_store_id;

    if v_variant_id is not null then
      update public.product_variants
      set stock_count = stock_count + v_qty
      where id = v_variant_id
        and product_id = v_product_id;
    end if;

    insert into public.stock_adjustments (
      store_id, product_id, delta, reason, reference_id, note, created_by
    ) values (
      v_store_id, v_product_id, v_qty, 'pos_refund', v_tx.id, v_reason, auth.uid()
    );

    v_refund_net := v_refund_net + (
      (v_unit * v_qty) - (v_line_discount * v_qty::numeric / v_sold)
    );
    v_audit_lines := v_audit_lines || jsonb_build_array(
      jsonb_build_object('productId', v_product_id, 'variantId', v_variant_id, 'quantity', v_qty)
    );
  end loop;

  select bool_and(coalesce(i.refunded_qty, 0) >= i.quantity)
  into v_all_done
  from public.pos_transaction_items i
  where i.transaction_id = v_tx.id;

  select coalesce(sum(i.line_discount), 0)
  into v_lines_off
  from public.pos_transaction_items i
  where i.transaction_id = v_tx.id;

  v_net_base := v_tx.subtotal - v_lines_off;

  if v_all_done then
    v_refund_amount := v_tx.total - coalesce(v_tx.refunded_amount, 0);
  elsif v_net_base > 0 then
    v_refund_amount := round(v_refund_net * v_tx.total / v_net_base, 2);
    v_refund_amount := least(v_refund_amount, v_tx.total - coalesce(v_tx.refunded_amount, 0));
  end if;

  update public.pos_transactions
  set payment_status = case when v_all_done then 'refunded' else 'partially_refunded' end,
      refunded_at = now(),
      refunded_by = auth.uid(),
      refunded_amount = coalesce(refunded_amount, 0) + v_refund_amount
  where id = v_tx.id;

  if v_refund_amount > 0 then
    insert into public.pos_refunds (store_id, transaction_id, amount, reason, processed_by)
    values (v_store_id, v_tx.id, v_refund_amount, v_reason, auth.uid());
  end if;

  perform public.write_merchant_audit(
    v_store_id,
    'pos_partial_refund',
    'pos_transaction',
    v_tx.id,
    'Partial refund ' || coalesce(v_tx.invoice_number, v_tx.id::text) || ' · ₹' || v_refund_amount::text,
    jsonb_build_object('reason', v_reason, 'refundAmount', v_refund_amount, 'lines', v_audit_lines)
  );

  return public.merchant_get_pos_sale(v_tx.id);
end;
$function$;
