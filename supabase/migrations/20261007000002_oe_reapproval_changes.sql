-- Reapproval: when an approved request is edited it goes back to top management. The "edited" history entry now
-- keeps the request as it stood before the edit, so the approval screen can show a "Reapproval" label and only
-- what changed since the approved version.

alter table oe_request_events add column if not exists changes jsonb;

-- The request header and its lines (with document names), in the shape the app's requestSnapshot() uses.
create or replace function oe_request_snapshot(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'request_date', r.request_date, 'date_needed', r.date_needed, 'remarks', r.remarks,
    'approved_by_name', r.approved_by_name, 'approved_at', r.approved_at, 'approval_remarks', r.approval_remarks, 'erp_ref', r.erp_ref,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'project_id', l.project_id, 'type_id', l.type_id,
               'description', l.description, 'payee', l.payee, 'detail', l.detail,
               'basis_amount', l.basis_amount, 'basis_pct', l.basis_pct, 'rate', l.rate,
               'amount', l.amount, 'approved_amount', l.approved_amount,
               'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'file_name', d.file_name) order by d.created_at)
                                        from oe_line_documents d where d.line_id = l.id), '[]'::jsonb)
             ) order by l.line_no)
        from oe_request_lines l where l.request_id = r.id), '[]'::jsonb))
  from oe_requests r where r.id = p_id;
$$;
revoke execute on function oe_request_snapshot(uuid) from public, anon, authenticated;

-- Edit request: same as before (20260929000001, section 5), plus the snapshot on the history entry.
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
  v_before   jsonb;
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
  v_before := oe_request_snapshot(p_id);   -- as it stood before this edit (for an approved request: the approved version)

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

  insert into oe_request_events (request_id, line_id, action, note, actor_id, actor_name, changes)
  values (p_id, null, 'edited',
    case when v_old_n <> v_no then v_old_n || ' → ' || v_no || ' lines; ' else '' end ||
    'total ' || to_char(v_old_tot, 'FM999,999,999,990.00') || ' → ' || to_char(v_new_tot, 'FM999,999,999,990.00') ||
    case when v_req.status = 'open' then '; back to approval' ||
         case when v_req.erp_ref is not null then ', ERP reference ' || v_req.erp_ref || ' cleared' else '' end
    else '' end,
    auth.uid(), oe_my_name(),
    jsonb_build_object('reapproval', v_req.status = 'open', 'before', v_before));
end $$;
