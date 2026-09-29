-- =====================================================================
--  PROJECT EXPENSE MONITORING — workflow fixes from the 2026-09-29 review
--  1. "Not in the future" date checks use the company's local calendar day, not the
--     database's UTC clock (morning entries in the Philippines were refused).
--  2. Approval refuses a request whose lines changed while the approver was reviewing it.
--  3. Disbursement date must be a real date: not in the future, not before the request date.
--  4. Mark paid and Reclassify lock the request before its lines, like Return fund does,
--     so two people acting on the same line can't deadlock each other.
--  5. Editing a request refuses a line listed twice.
--  6. Access hardening (security review): a user manager who is not an administrator can't
--     create or hand out user-management rights, can't touch an administrator's profile at
--     all, and can only change name, role and access on other profiles; role permission
--     lists must be arrays; inactive users lose storage access at once; no TRUNCATE for users.
--  Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Local calendar day. Timezone comes from Settings (data->>'timezone'), default Asia/Manila.
-- ---------------------------------------------------------------------
update oe_settings set data = data || '{"timezone": "Asia/Manila"}'::jsonb where id = 1 and not data ? 'timezone';

create or replace function oe_today() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select data->>'timezone' from oe_settings where id = 1), 'Asia/Manila'))::date;
$$;
revoke execute on function oe_today() from public, anon;
grant  execute on function oe_today() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Approval refuses a request edited under the approver
-- ---------------------------------------------------------------------
create or replace function oe_approve_request(p_id uuid, p_lines jsonb, p_remarks text) returns void
language plpgsql security definer set search_path = public as $$
declare v_req oe_requests%rowtype; v_line oe_request_lines%rowtype; v_amt numeric;
begin
  perform oe_require('requests.approve');
  select * into v_req from oe_requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'on_hold' then raise exception '% is no longer waiting for approval.', v_req.ref_no; end if;
  if v_req.liaison_id = auth.uid() and not oe_is_admin() then
    raise exception 'You cannot approve your own request.';
  end if;
  -- The approver sends every line they reviewed. If the liaison edited the request meanwhile
  -- (lines added, removed or changed), the sets differ and the approval is refused.
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    if exists (select 1 from jsonb_array_elements(p_lines) e
                where nullif(e->>'id', '') is null
                   or not exists (select 1 from oe_request_lines l where l.id = (e->>'id')::uuid and l.request_id = p_id))
       or exists (select 1 from oe_request_lines l where l.request_id = p_id
                   and not exists (select 1 from jsonb_array_elements(p_lines) e where (e->>'id')::uuid = l.id)) then
      raise exception '% was edited while you were reviewing it. Reload and review it again.', v_req.ref_no;
    end if;
  end if;

  for v_line in select * from oe_request_lines where request_id = p_id order by line_no loop
    v_amt := null;
    select nullif(e->>'approved_amount', '')::numeric into v_amt
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
     where (e->>'id')::uuid = v_line.id;
    -- the requested amount the approver saw, if the app sent it; a mismatch means the line was edited
    if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
                where (e->>'id')::uuid = v_line.id and nullif(e->>'amount', '') is not null
                  and abs((e->>'amount')::numeric - v_line.amount) > 0.004) then
      raise exception '% was edited while you were reviewing it. Reload and review it again.', v_req.ref_no;
    end if;
    v_amt := round(coalesce(v_amt, v_line.amount), 2);
    if v_amt < 0 or v_amt > v_line.amount then
      raise exception 'Line %: approved amount must be between 0 and the requested amount.', v_line.line_no;
    end if;
    update oe_request_lines
       set approved_amount = v_amt,
           status = case when v_amt > 0 then 'open' else 'declined' end
     where id = v_line.id;
  end loop;

  if not exists (select 1 from oe_request_lines where request_id = p_id and status = 'open') then
    raise exception 'Approve at least one line, or reject the request instead.';
  end if;

  update oe_requests
     set status = 'open', approved_by = auth.uid(), approved_by_name = oe_my_name(),
         approved_at = now(), approval_remarks = nullif(trim(coalesce(p_remarks, '')), ''), updated_at = now()
   where id = p_id;
  perform oe_log(p_id, null, 'approved', p_remarks);
end $$;

-- ---------------------------------------------------------------------
-- 3. Disbursement date must be a real date
-- ---------------------------------------------------------------------
create or replace function oe_disburse_request(p_id uuid, p_date date, p_remarks text) returns void
language plpgsql security definer set search_path = public as $$
declare v_req oe_requests%rowtype;
begin
  perform oe_require('requests.disburse');
  if p_date is null then raise exception 'Enter the disbursement date.'; end if;
  select * into v_req from oe_requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'open' then raise exception '% is not open for disbursement.', v_req.ref_no; end if;
  if coalesce(v_req.erp_ref, '') = '' then
    raise exception 'The liaison has not entered the ERP reference for % yet.', v_req.ref_no;
  end if;
  if p_date > oe_today() then raise exception 'The disbursement date can''t be in the future.'; end if;
  if p_date < v_req.request_date then
    raise exception 'The disbursement date can''t be before the request date (%).', to_char(v_req.request_date, 'Mon DD, YYYY');
  end if;
  update oe_request_lines set status = 'disbursed' where request_id = p_id and status = 'open';
  update oe_requests
     set status = 'disbursed', disbursed_date = p_date, disbursed_by_name = oe_my_name(),
         disbursed_at = now(), disbursement_remarks = nullif(trim(coalesce(p_remarks, '')), ''), updated_at = now()
   where id = p_id;
  perform oe_log(p_id, null, 'disbursed', coalesce(nullif(trim(coalesce(p_remarks, '')), ''), to_char(p_date, 'Mon DD, YYYY')));
end $$;

-- ---------------------------------------------------------------------
-- 4a. Mark paid: local date, request locked before its lines
-- ---------------------------------------------------------------------
create or replace function oe_mark_paid(p_lines jsonb, p_date date, p_remarks text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb;
  v_id   uuid;
  v_line oe_request_lines%rowtype;
  v_req  oe_requests%rowtype;
  v_out  numeric;
  v_amt  numeric;
  v_seen uuid[] := '{}';
  v_rid  uuid;
  v_ids  uuid[];
begin
  perform oe_require('requests.pay');
  if p_date is null then raise exception 'Enter the date the fund was given.'; end if;
  if p_date > oe_today() then raise exception 'The date given can''t be in the future.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select at least one line.';
  end if;
  -- Lock the requests first (in id order), then the lines: the same order Return fund and
  -- Reclassify use, so concurrent actions on one line wait for each other instead of deadlocking.
  select array_agg(nullif(e->>'id', '')::uuid) into v_ids from jsonb_array_elements(p_lines) e;
  if v_ids is null or array_position(v_ids, null) is not null then raise exception 'Select at least one line.'; end if;
  perform 1 from oe_requests r
    where r.id in (select l.request_id from oe_request_lines l where l.id = any(v_ids))
    order by r.id for update;
  for v_item in select value from jsonb_array_elements(p_lines) order by value->>'id' loop
    v_id := nullif(v_item->>'id', '')::uuid;
    if v_id is null then raise exception 'Select at least one line.'; end if;
    if v_id = any(v_seen) then raise exception 'Each line can be listed only once.'; end if;
    v_seen := v_seen || v_id;
    select * into v_line from oe_request_lines where id = v_id for update;
    if not found then raise exception 'Request line not found.'; end if;
    select * into v_req from oe_requests where id = v_line.request_id;
    if v_req.liaison_id <> auth.uid() and not oe_has_perm('requests.view_all') then
      raise exception 'You can only update your own requests.';
    end if;
    if v_line.status = 'part_paid' then
      raise exception 'Line % of % is already partly paid; accounting records the return of the rest.', v_line.line_no, v_req.ref_no;
    end if;
    if v_line.status <> 'disbursed' then
      raise exception 'Line % of % is not waiting for payment.', v_line.line_no, v_req.ref_no;
    end if;
    if v_req.disbursed_date is not null and p_date < v_req.disbursed_date then
      raise exception 'The date given can''t be before the disbursement (%).', to_char(v_req.disbursed_date, 'Mon DD, YYYY');
    end if;
    v_out := coalesce(v_line.approved_amount, v_line.amount) - v_line.returned_amount - coalesce(v_line.paid_amount, 0);
    v_amt := round(coalesce(nullif(v_item->>'amount', '')::numeric, v_out), 2);
    if v_amt <= 0 then raise exception 'Line % of %: the amount given must be more than zero.', v_line.line_no, v_req.ref_no; end if;
    if v_amt > v_out + 0.004 then
      raise exception 'Line % of %: only % is with the liaison.', v_line.line_no, v_req.ref_no, to_char(v_out, 'FM"₱"999,999,999,990.00');
    end if;
    update oe_request_lines
       set status = case when v_amt >= v_out - 0.004 then 'paid' else 'part_paid' end,
           paid_amount = v_amt, paid_date = p_date, paid_by_name = oe_my_name(), paid_at = now()
     where id = v_id;
    perform oe_log(v_req.id, v_id, 'paid',
      concat_ws('; ',
        case when v_amt >= v_out - 0.004 then to_char(v_amt, 'FM"₱"999,999,999,990.00') || ' given to the client'
             else to_char(v_amt, 'FM"₱"999,999,999,990.00') || ' of ' || to_char(v_out, 'FM"₱"999,999,999,990.00') || ' given to the client; '
                  || to_char(v_out - v_amt, 'FM"₱"999,999,999,990.00') || ' to be returned' end,
        nullif(trim(coalesce(p_remarks, '')), '')));
  end loop;
  for v_rid in select distinct request_id from oe_request_lines where id = any(v_seen) loop
    perform oe_refresh_status(v_rid);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4b. Reclassify: request locked before the line
-- ---------------------------------------------------------------------
create or replace function oe_reclassify_line(p_line_id uuid, p_parts jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_line  oe_request_lines%rowtype;
  v_src   oe_projects%rowtype;
  v_part  jsonb;
  v_pid   uuid;
  v_amt   numeric;
  v_code  text;
  v_base  numeric;
  v_total numeric := 0;
  v_seen  uuid[] := '{}';
  v_note  text := '';
begin
  perform oe_require('requests.reclassify');
  -- request first, then the line (same lock order as Return fund and Mark paid)
  perform 1 from oe_requests where id = (select request_id from oe_request_lines where id = p_line_id) for update;
  select * into v_line from oe_request_lines where id = p_line_id for update;
  if not found then raise exception 'Request line not found.'; end if;
  select * into v_src from oe_projects where id = v_line.project_id;
  if not coalesce(v_src.is_internal, false) then
    raise exception 'Only lines filed under an internal project (such as FOR-ASSIGNMENT) can be reclassified.';
  end if;
  if v_line.status not in ('disbursed', 'part_paid', 'paid', 'closed') then
    raise exception 'A line can be reclassified once its fund has been disbursed.';
  end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then raise exception 'Invalid split.'; end if;

  v_base := coalesce(v_line.approved_amount, v_line.amount) - v_line.returned_amount;   -- returned money can't be split
  delete from oe_line_reclass where line_id = p_line_id;

  for v_part in select * from jsonb_array_elements(p_parts) loop
    v_pid := nullif(v_part->>'project_id', '')::uuid;
    v_amt := round(coalesce(nullif(v_part->>'amount', '')::numeric, 0), 2);
    if v_pid is null then raise exception 'Choose a project for every row.'; end if;
    if v_amt <= 0 then raise exception 'Every amount must be greater than zero.'; end if;
    if v_pid = any(v_seen) then raise exception 'Each project can appear only once in a split.'; end if;
    select code into v_code from oe_projects where id = v_pid and not is_internal;
    if v_code is null then raise exception 'Reclassify to a specific project, not an internal one.'; end if;
    v_seen  := v_seen || v_pid;
    v_total := v_total + v_amt;
    insert into oe_line_reclass (line_id, request_id, project_id, amount, remarks, created_by, created_by_name)
    values (p_line_id, v_line.request_id, v_pid, v_amt, nullif(trim(coalesce(v_part->>'remarks', '')), ''), auth.uid(), oe_my_name());
    v_note := v_note || case when v_note = '' then '' else '; ' end || v_code || ' ' || to_char(v_amt, 'FM999,999,999,990.00');
  end loop;

  if v_total > v_base + 0.004 then
    raise exception 'The split (%) is more than the line amount after returns (%).',
      to_char(v_total, 'FM999,999,999,990.00'), to_char(v_base, 'FM999,999,999,990.00');
  end if;

  perform oe_log(v_line.request_id, p_line_id, 'reclassified',
    case when v_note = '' then 'Split removed; back on ' || v_src.code
         else v_note || case when v_total < v_base - 0.004
                             then '; ' || to_char(v_base - v_total, 'FM999,999,999,990.00') || ' remains on ' || v_src.code
                             else '' end
    end);
end $$;

-- ---------------------------------------------------------------------
-- 4c. Return fund: local date
-- ---------------------------------------------------------------------
create or replace function oe_return_line(p_line_id uuid, p_amount numeric, p_return_date date, p_ref text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_line    oe_request_lines%rowtype;
  v_req     oe_requests%rowtype;
  v_role    text;
  v_net     numeric;
  v_out     numeric;
  v_amt     numeric;
  v_reclass numeric;
  v_status  text;
begin
  perform oe_require('requests.return');
  select role into v_role from oe_profiles where id = auth.uid() and is_active;
  if coalesce(v_role, '') not in ('admin', 'tm', 'accounting') then
    raise exception 'Only accounting, top management or an administrator can record a fund return.' using errcode = '42501';
  end if;
  select * into v_line from oe_request_lines where id = p_line_id;
  if not found then raise exception 'Request line not found.'; end if;
  select * into v_req from oe_requests where id = v_line.request_id for update;
  select * into v_line from oe_request_lines where id = p_line_id for update;   -- current state, locked
  if v_req.liaison_id = auth.uid() and v_role <> 'admin' then
    raise exception 'You filed %, so someone else must record its fund return.', v_req.ref_no;
  end if;
  if v_line.status not in ('disbursed', 'part_paid') then
    raise exception 'Nothing on line % of % can be returned; it is %.', v_line.line_no, v_req.ref_no,
      case v_line.status when 'paid' then 'already fully accounted for' when 'closed' then 'closed'
                         when 'returned' then 'already returned in full' else 'not disbursed' end;
  end if;
  v_net := coalesce(v_line.approved_amount, v_line.amount) - v_line.returned_amount;
  v_out := v_net - coalesce(v_line.paid_amount, 0);
  v_amt := round(p_amount, 2);
  if v_amt is null or v_amt <= 0 then raise exception 'Enter the amount returned.'; end if;
  if v_amt > v_out + 0.004 then
    raise exception 'Only % of line % is still with the liaison.', to_char(v_out, 'FM"₱"999,999,999,990.00'), v_line.line_no;
  end if;
  select coalesce(sum(amount), 0) into v_reclass from oe_line_reclass where line_id = p_line_id;
  if v_net - v_amt < v_reclass - 0.004 then
    raise exception '% of this line is reclassified to projects; reduce the split before recording this return.', to_char(v_reclass, 'FM"₱"999,999,999,990.00');
  end if;
  if p_return_date is null then raise exception 'Enter the date the fund was returned.'; end if;
  if p_return_date > oe_today() then raise exception 'The return date can''t be in the future.'; end if;
  if v_req.disbursed_date is not null and p_return_date < v_req.disbursed_date then
    raise exception 'The return date can''t be before the disbursement (%).', to_char(v_req.disbursed_date, 'Mon DD, YYYY');
  end if;
  if nullif(trim(coalesce(p_ref, '')), '') is null then raise exception 'Enter the receipt or reference number for the returned fund.'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Enter the reason for the return.'; end if;

  v_status := case when v_out - v_amt > 0.004 then v_line.status              -- some is still with the liaison
                   when coalesce(v_line.paid_amount, 0) > 0 then 'paid'        -- settled: part given, the rest returned
                   else 'returned' end;                                        -- everything came back
  insert into oe_line_returns (line_id, request_id, amount, return_date, ref, reason, created_by, created_by_name)
  values (p_line_id, v_req.id, v_amt, p_return_date, trim(p_ref), trim(p_reason), auth.uid(), oe_my_name());
  update oe_request_lines set returned_amount = returned_amount + v_amt, status = v_status
   where id = p_line_id and status in ('disbursed', 'part_paid');
  if not found then raise exception 'Line % of % changed while you were recording the return. Reload and try again.', v_line.line_no, v_req.ref_no; end if;
  perform oe_refresh_status(v_req.id);
  perform oe_log(v_req.id, p_line_id, 'returned',
    to_char(v_amt, 'FM"₱"999,999,999,990.00') || case when v_out - v_amt > 0.004 then ' (partial)' else '' end
    || ' returned ' || to_char(p_return_date, 'Mon DD, YYYY') || ', ref ' || trim(p_ref) || ': ' || trim(p_reason)
    || case when v_out - v_amt > 0.004 then '; ' || to_char(v_out - v_amt, 'FM"₱"999,999,999,990.00') || ' still with the liaison' else '' end);
end $$;

-- ---------------------------------------------------------------------
-- 5. Edit request: a line can't be listed twice
-- ---------------------------------------------------------------------
create or replace function oe_update_request(p_id uuid, p_request_date date, p_date_needed date, p_remarks text, p_lines jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_req      oe_requests%rowtype;
  v_line     jsonb;
  v_no       int := 0;
  v_type     oe_expense_types%rowtype;
  v_amount   numeric;
  v_lid      uuid;
  v_doc      jsonb;
  v_docs     int;
  v_need_doc boolean;
  v_keep_ids uuid[] := '{}';
  v_old_n    int;
  v_old_tot  numeric;
  v_new_tot  numeric := 0;
  v_projects uuid[] := '{}';
begin
  perform oe_require('requests.create');
  select * into v_req from oe_requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status not in ('on_hold', 'open') then
    raise exception '% has already been disbursed or closed, so it can''t be edited.', v_req.ref_no;
  end if;
  if v_req.liaison_id <> auth.uid() and not oe_is_admin() then raise exception 'You can only edit your own requests.'; end if;
  if p_date_needed is null then raise exception 'Enter the date needed.'; end if;
  if p_date_needed < coalesce(p_request_date, v_req.request_date) then raise exception 'The date needed can''t be before the request date.'; end if;
  if nullif(trim(coalesce(p_remarks, '')), '') is null then raise exception 'Enter a description.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Keep at least one request line.'; end if;

  select count(*), coalesce(sum(amount), 0) into v_old_n, v_old_tot from oe_request_lines where request_id = p_id;

  -- lines kept by id; everything else on the request is removed (their documents go with them)
  select coalesce(array_agg((x->>'id')::uuid), '{}') into v_keep_ids
    from jsonb_array_elements(p_lines) x where nullif(x->>'id', '') is not null;
  if exists (select 1 from unnest(v_keep_ids) k where not exists (select 1 from oe_request_lines l where l.id = k and l.request_id = p_id)) then
    raise exception 'A line does not belong to this request.';
  end if;
  if (select count(*) from unnest(v_keep_ids)) <> (select count(distinct k) from unnest(v_keep_ids) k) then
    raise exception 'A line is listed twice.';
  end if;
  delete from oe_request_lines where request_id = p_id and not (id = any(v_keep_ids));
  update oe_request_lines set line_no = -line_no where request_id = p_id;   -- free the numbers for renumbering

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    select * into v_type from oe_expense_types where id = nullif(v_line->>'type_id', '')::uuid and is_active;
    if not found then raise exception 'Line %: choose an active expense type.', v_no; end if;
    if nullif(v_line->>'project_id', '') is null then raise exception 'Line %: choose a project.', v_no; end if;
    v_amount := round(coalesce(nullif(v_line->>'amount', '')::numeric, 0), 2);
    if v_amount <= 0 then raise exception 'Line %: amount must be greater than zero.', v_no; end if;
    if nullif(trim(coalesce(v_line->>'payee', '')), '') is null then raise exception 'Line %: enter the payee or recipient.', v_no; end if;
    if v_type.detail_label is not null and nullif(trim(coalesce(v_line->>'detail', '')), '') is null then
      raise exception 'Line %: fill in "%".', v_no, v_type.detail_label;
    end if;

    v_lid := nullif(v_line->>'id', '')::uuid;
    if v_lid is null then
      insert into oe_request_lines (request_id, line_no, project_id, category_id, type_id, description, payee, detail,
                                    basis_amount, basis_pct, rate, amount)
      values (p_id, v_no, (v_line->>'project_id')::uuid, v_type.category_id, v_type.id,
              nullif(trim(coalesce(v_line->>'description', '')), ''), nullif(trim(coalesce(v_line->>'payee', '')), ''),
              nullif(trim(coalesce(v_line->>'detail', '')), ''), nullif(v_line->>'basis_amount', '')::numeric,
              nullif(v_line->>'basis_pct', '')::numeric, nullif(v_line->>'rate', '')::numeric, v_amount)
      returning id into v_lid;
    else
      update oe_request_lines
         set line_no = v_no, project_id = (v_line->>'project_id')::uuid, category_id = v_type.category_id, type_id = v_type.id,
             description = nullif(trim(coalesce(v_line->>'description', '')), ''), payee = nullif(trim(coalesce(v_line->>'payee', '')), ''),
             detail = nullif(trim(coalesce(v_line->>'detail', '')), ''), basis_amount = nullif(v_line->>'basis_amount', '')::numeric,
             basis_pct = nullif(v_line->>'basis_pct', '')::numeric, rate = nullif(v_line->>'rate', '')::numeric, amount = v_amount
       where id = v_lid;
      -- documents: keep the ones listed, drop the rest
      delete from oe_line_documents
       where line_id = v_lid
         and not (id = any(coalesce((select array_agg((d)::uuid) from jsonb_array_elements_text(coalesce(v_line->'keep_documents', '[]'::jsonb)) d), '{}')));
    end if;

    for v_doc in select value from jsonb_array_elements(coalesce(v_line->'documents', '[]'::jsonb)) loop
      if coalesce(v_doc->>'path', '') not like auth.uid()::text || '/%' then raise exception 'Line %: invalid document.', v_no; end if;
      if not exists (select 1 from storage.objects o where o.bucket_id = 'oe-documents' and o.name = v_doc->>'path') then
        raise exception 'Line %: an attached document did not finish uploading. Attach it again.', v_no;
      end if;
      insert into oe_line_documents (line_id, request_id, path, file_name, mime, size_bytes, uploaded_by, uploaded_by_name)
      values (v_lid, p_id, v_doc->>'path', coalesce(nullif(trim(v_doc->>'file_name'), ''), 'document'),
              nullif(v_doc->>'mime', ''), nullif(v_doc->>'size', '')::bigint, auth.uid(), oe_my_name());
    end loop;
    select count(*) into v_docs from oe_line_documents where line_id = v_lid;
    select require_document into v_need_doc from oe_expense_categories where id = v_type.category_id;
    if coalesce(v_need_doc, false) and v_docs = 0 then raise exception 'Line %: attach a supporting document.', v_no; end if;

    v_new_tot := v_new_tot + v_amount;
    if not ((v_line->>'project_id')::uuid = any(v_projects)) then v_projects := v_projects || (v_line->>'project_id')::uuid; end if;
  end loop;

  update oe_requests
     set request_date = coalesce(p_request_date, request_date), date_needed = p_date_needed, remarks = trim(p_remarks),
         project_id = case when array_length(v_projects, 1) = 1 then v_projects[1] else null end, updated_at = now()
   where id = p_id;

  -- an approved request that is edited goes back to top management; its approval and ERP reference no longer apply
  if v_req.status = 'open' then
    update oe_request_lines set status = 'on_hold', approved_amount = null where request_id = p_id;
    update oe_requests
       set status = 'on_hold', approved_by = null, approved_by_name = null, approved_at = null, approval_remarks = null,
           erp_ref = null, erp_ref_at = null, erp_ref_by_name = null
     where id = p_id;
  end if;

  perform oe_log(p_id, null, 'edited',
    case when v_old_n <> v_no then v_old_n || ' → ' || v_no || ' lines; ' else '' end ||
    'total ' || to_char(v_old_tot, 'FM999,999,999,990.00') || ' → ' || to_char(v_new_tot, 'FM999,999,999,990.00') ||
    case when v_req.status = 'open' then '; back to approval' ||
         case when v_req.erp_ref is not null then ', ERP reference ' || v_req.erp_ref || ' cleared' else '' end
    else '' end);
end $$;

-- ---------------------------------------------------------------------
-- 6. Access hardening
-- ---------------------------------------------------------------------
-- 6a. Profiles: users with "settings.users" may change only full_name, role and is_active.
revoke update on oe_profiles from authenticated;
grant  update (full_name, role, is_active) on oe_profiles to authenticated;

-- 6b. A non-administrator may not change anything on an administrator's profile, nor hand out
--     a role that itself carries user-management rights (which would let them mint a second,
--     more powerful account for themselves).
create or replace function oe_profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed boolean := new.role is distinct from old.role or new.is_active is distinct from old.is_active;
begin
  if auth.uid() is null then
    return new;                                  -- service role (bootstrap, invite function)
  end if;
  if new.id = auth.uid() and changed then
    raise exception 'You cannot change your own role or access. Ask another administrator.';
  end if;
  if not oe_is_admin() then
    if old.role = 'admin' or new.role = 'admin' then
      raise exception 'Only an administrator can change an administrator''s account.';
    end if;
    if new.role is distinct from old.role
       and exists (select 1 from oe_role_permissions rp where rp.role = new.role and rp.permissions ? 'settings.users') then
      raise exception 'Only an administrator can give a role that manages users.';
    end if;
  end if;
  return new;
end $$;

-- 6c. Roles: a non-administrator can't change their own role (old or new name), can't grant
--     "settings.users" to any role, and permission lists must be JSON arrays.
alter table oe_role_permissions drop constraint if exists oe_role_permissions_array_chk;
alter table oe_role_permissions add constraint oe_role_permissions_array_chk check (jsonb_typeof(permissions) = 'array');

create or replace function oe_role_permissions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  my_role text;
begin
  if auth.uid() is not null and not oe_is_admin() then
    select role into my_role from oe_profiles where id = auth.uid();
    if (tg_op <> 'INSERT' and old.role = my_role) or (tg_op <> 'DELETE' and new.role = my_role) then
      raise exception 'You can''t change your own role''s rights. Ask an administrator.';
    end if;
    if tg_op <> 'DELETE' and new.permissions ? 'settings.users'
       and (tg_op = 'INSERT' or not old.permissions ? 'settings.users') then
      raise exception 'Only an administrator can give a role the right to manage users.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- 6d. Storage: a deactivated user loses access to their own uploads immediately.
drop policy if exists oe_docs_read on storage.objects;
create policy oe_docs_read on storage.objects for select to authenticated using (
  bucket_id = 'oe-documents' and (select oe_is_active()) and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (select 1 from oe_line_documents d join oe_requests r on r.id = d.request_id
                where d.path = objects.name
                  and ((select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
                       or r.liaison_id = (select auth.uid())))));

-- 6e. No TRUNCATE for signed-in users on any oe_ table (not reachable through the API today; belt and braces).
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename like 'oe\_%' loop
    execute format('revoke truncate on %I from authenticated', t);
  end loop;
end $$;
