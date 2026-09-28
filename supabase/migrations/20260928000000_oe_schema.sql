-- =====================================================================
--  PROJECT EXPENSE MONITORING — Supabase schema
--  Run once in Supabase → SQL Editor (safe to re-run).
--  All objects are prefixed "oe_" so they can live beside other systems.
--  Writes to requests go ONLY through the oe_* functions below, which
--  check permissions server-side. Row Level Security guards every read.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------
create table if not exists oe_role_permissions (
  role        text primary key,
  label       text not null,
  permissions jsonb not null default '[]'::jsonb,
  sort_order  int  not null default 0
);

create table if not exists oe_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text not null default '',
  role       text not null default 'liaison' references oe_role_permissions(role) on update cascade,
  is_active  boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists oe_settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists oe_projects (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,            -- Project ID (e.g. 25HO0172)
  year             int,
  district         text,
  name             text not null default '',
  location         text,
  category         text,
  contractor       text,                            -- Contractor / JV
  abc_amount       numeric(16,2),
  bid_amount       numeric(16,2),
  revised_contract numeric(16,2),
  contract_value   numeric(16,2),
  duration_days    int,
  bidding_date     date,
  ntp_date         date,
  original_expiry  date,
  suspension_notes text,
  site_engineer    text,
  checker          text,
  status           text,
  status_group     text,
  accomplishment   numeric(7,4),                    -- 0 to 1
  is_internal      boolean not null default false,  -- Advances / For assignment
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists oe_expense_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int  not null default 0,
  is_active  boolean not null default true
);

-- Categories can require a supporting document on every request line
alter table oe_expense_categories add column if not exists require_document boolean not null default false;

create table if not exists oe_expense_types (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references oe_expense_categories(id) on delete restrict,
  name         text not null,
  code         text,
  calc_method  text not null default 'manual'
               check (calc_method in ('manual','contract_pct','collection_pct')),
  rate         numeric(8,4),        -- percent (2 = 2%); drives calculation and allocation
  alloc_fixed  numeric(16,2),       -- default allocation per project when there is no rate
  erp_account  text,                -- Acumatica account used when encoding the cash fund
  detail_label text,                -- extra field on the request line, e.g. "Type of insurance"
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  unique (category_id, name)
);

create table if not exists oe_district_rates (   -- SOP rates per DEO
  id       uuid primary key default gen_random_uuid(),
  district text not null,
  type_id  uuid not null references oe_expense_types(id) on delete cascade,
  rate     numeric(8,4) not null,
  unique (district, type_id)
);

create table if not exists oe_project_allocations (  -- per-project overrides
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references oe_projects(id) on delete cascade,
  type_id    uuid not null references oe_expense_types(id) on delete cascade,
  amount     numeric(16,2) not null check (amount >= 0),
  updated_at timestamptz not null default now(),
  unique (project_id, type_id)
);

create table if not exists oe_counters (
  scope      text primary key,
  last_value int not null default 0
);

create table if not exists oe_requests (
  id                   uuid primary key default gen_random_uuid(),
  ref_no               text not null unique,
  request_date         date not null default current_date,
  date_needed          date,
  project_id           uuid references oe_projects(id),
  liaison_id           uuid not null references oe_profiles(id),
  liaison_name         text not null,
  remarks              text,
  status               text not null default 'on_hold'
                       check (status in ('on_hold','open','disbursed','paid','closed','rejected','cancelled','returned')),
  approved_by          uuid,
  approved_by_name     text,
  approved_at          timestamptz,
  approval_remarks     text,
  erp_ref              text,
  erp_ref_at           timestamptz,
  erp_ref_by_name      text,
  disbursed_date       date,
  disbursed_by_name    text,
  disbursed_at         timestamptz,
  disbursement_remarks text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists oe_request_lines (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null references oe_requests(id) on delete cascade,
  line_no               int  not null,
  project_id            uuid not null references oe_projects(id),
  category_id           uuid not null references oe_expense_categories(id),
  type_id               uuid not null references oe_expense_types(id),
  description           text,
  payee                 text,
  detail                text,
  basis_amount          numeric(16,2),   -- contract value or net collection used in the calculation
  basis_pct             numeric(8,4),    -- collection % (billing %), informational
  rate                  numeric(8,4),    -- share % used
  amount                numeric(16,2) not null check (amount > 0),
  approved_amount       numeric(16,2),
  status                text not null default 'on_hold'
                        check (status in ('on_hold','open','disbursed','part_paid','paid','closed','rejected','cancelled','declined','returned')),
  paid_date             date,
  paid_by_name          text,
  paid_at               timestamptz,
  acct_verified_at      timestamptz,
  acct_verified_by_name text,
  tm_verified_at        timestamptz,
  tm_verified_by_name   text,
  closed_at             timestamptz,
  unique (request_id, line_no)
);

-- Paid and returned amounts (added after the first release, so existing databases get them here).
-- A disbursed line's money is: paid to the client + returned + still with the liaison.
alter table oe_request_lines add column if not exists paid_amount     numeric(16,2);
alter table oe_request_lines add column if not exists returned_amount numeric(16,2) not null default 0;
alter table oe_request_lines drop constraint if exists oe_request_lines_status_check;
alter table oe_request_lines add constraint oe_request_lines_status_check
  check (status in ('on_hold','open','disbursed','part_paid','paid','closed','rejected','cancelled','declined','returned'));
alter table oe_request_lines drop constraint if exists oe_request_lines_amounts_check;
alter table oe_request_lines add constraint oe_request_lines_amounts_check
  check (returned_amount >= 0 and coalesce(paid_amount, 0) >= 0
         and coalesce(paid_amount, 0) + returned_amount <= coalesce(approved_amount, amount) + 0.004);
-- lines paid before amounts were recorded were paid in full
update oe_request_lines set paid_amount = coalesce(approved_amount, amount) - returned_amount
 where status in ('paid', 'closed') and paid_amount is null;
alter table oe_requests drop constraint if exists oe_requests_status_check;
alter table oe_requests add constraint oe_requests_status_check
  check (status in ('on_hold','open','disbursed','paid','closed','rejected','cancelled','returned'));

create table if not exists oe_request_events (
  id         bigint generated always as identity primary key,
  request_id uuid not null references oe_requests(id) on delete cascade,
  line_id    uuid references oe_request_lines(id) on delete cascade,
  action     text not null,
  note       text,
  actor_id   uuid,
  actor_name text,
  created_at timestamptz not null default now()
);

-- Reclassification: a line filed under an internal project (FOR-ASSIGNMENT, ADVANCES) split
-- afterwards to the specific projects. The original line is never changed.
create table if not exists oe_line_reclass (
  id              uuid primary key default gen_random_uuid(),
  line_id         uuid not null references oe_request_lines(id) on delete cascade,
  request_id      uuid not null references oe_requests(id) on delete cascade,
  project_id      uuid not null references oe_projects(id),
  amount          numeric(16,2) not null check (amount > 0),
  remarks         text,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  created_by_name text,
  unique (line_id, project_id)
);
create index if not exists oe_reclass_project_idx on oe_line_reclass (project_id);

-- Supporting documents attached to request lines (files live in the private "oe-documents" bucket)
create table if not exists oe_line_returns (
  id              uuid primary key default gen_random_uuid(),
  line_id         uuid not null references oe_request_lines(id) on delete cascade,
  request_id      uuid not null references oe_requests(id) on delete cascade,
  amount          numeric(16,2) not null check (amount > 0),
  return_date     date not null,
  ref             text not null,
  reason          text not null,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  created_by_name text
);
create index if not exists oe_line_returns_line on oe_line_returns (line_id);

-- The previous version kept one return per line on the line itself; move it into the log.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'oe_request_lines' and column_name = 'return_date') then
    execute $m$
      insert into oe_line_returns (line_id, request_id, amount, return_date, ref, reason, created_at, created_by, created_by_name)
      select l.id, l.request_id, coalesce(l.approved_amount, l.amount), l.return_date, coalesce(l.return_ref, '—'), coalesce(l.return_reason, '—'),
             coalesce(l.returned_at, now()), l.returned_by, l.returned_by_name
        from oe_request_lines l
       where l.status = 'returned' and l.return_date is not null
         and not exists (select 1 from oe_line_returns x where x.line_id = l.id)
    $m$;
    execute $m$ update oe_request_lines set returned_amount = coalesce(approved_amount, amount) where status = 'returned' and returned_amount = 0 $m$;
    alter table oe_request_lines drop column if exists return_date, drop column if exists return_ref, drop column if exists return_reason,
                                 drop column if exists returned_at, drop column if exists returned_by, drop column if exists returned_by_name;
  end if;
end $$;

create table if not exists oe_line_documents (
  id               uuid primary key default gen_random_uuid(),
  line_id          uuid not null references oe_request_lines(id) on delete cascade,
  request_id       uuid not null references oe_requests(id) on delete cascade,
  path             text not null unique,        -- <uploader id>/<random>/<file name> inside the bucket
  file_name        text not null,
  mime             text,
  size_bytes       bigint,
  uploaded_by      uuid,
  uploaded_by_name text,
  created_at       timestamptz not null default now()
);
create index if not exists oe_line_documents_line_idx on oe_line_documents (line_id);

create index if not exists oe_lines_project_type_idx on oe_request_lines (project_id, type_id);
create index if not exists oe_lines_request_idx      on oe_request_lines (request_id);
create index if not exists oe_requests_status_idx    on oe_requests (status);
create index if not exists oe_requests_liaison_idx   on oe_requests (liaison_id);
create index if not exists oe_events_request_idx     on oe_request_events (request_id);
create index if not exists oe_alloc_project_idx      on oe_project_allocations (project_id);

-- ---------------------------------------------------------------------
-- 2. PERMISSION HELPERS
-- ---------------------------------------------------------------------
create or replace function oe_is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from oe_profiles where id = auth.uid() and is_active);
$$;

create or replace function oe_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from oe_profiles where id = auth.uid() and is_active and role = 'admin');
$$;

create or replace function oe_has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from oe_profiles pr
      join oe_role_permissions rp on rp.role = pr.role
     where pr.id = auth.uid()
       and pr.is_active
       and (pr.role = 'admin' or rp.permissions ? p)
  );
$$;

create or replace function oe_require(p text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not oe_has_perm(p) then
    raise exception 'Access denied: your role does not allow "%".', p using errcode = '42501';
  end if;
end $$;

create or replace function oe_my_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(full_name, ''), email, 'Unknown user') from oe_profiles where id = auth.uid();
$$;

create or replace function oe_log(p_request uuid, p_line uuid, p_action text, p_note text) returns void
language sql security definer set search_path = public as $$
  insert into oe_request_events (request_id, line_id, action, note, actor_id, actor_name)
  values (p_request, p_line, p_action, nullif(trim(coalesce(p_note, '')), ''), auth.uid(), oe_my_name());
$$;

-- Header status follows its lines once the fund is disbursed.
create or replace function oe_refresh_status(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_total int; v_paid int; v_closed int; v_returned int;
begin
  -- returned lines drop out, like declined ones; if every disbursed line came back, the request is Returned
  select count(*) filter (where status in ('disbursed','part_paid','paid','closed')),
         count(*) filter (where status in ('paid','closed')),
         count(*) filter (where status = 'closed'),
         count(*) filter (where status = 'returned')
    into v_total, v_paid, v_closed, v_returned
    from oe_request_lines where request_id = p_id;

  update oe_requests
     set status = case when v_total = 0 and v_returned > 0 then 'returned'
                       when v_total > 0 and v_closed = v_total then 'closed'
                       when v_total > 0 and v_paid   = v_total then 'paid'
                       else 'disbursed' end,
         updated_at = now()
   where id = p_id and status in ('disbursed','paid','closed');
end $$;

-- ---------------------------------------------------------------------
-- 3. NEW-USER + PROFILE GUARDS
-- ---------------------------------------------------------------------
create or replace function oe_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into oe_profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists oe_on_auth_user_created on auth.users;
create trigger oe_on_auth_user_created
  after insert on auth.users
  for each row execute function oe_handle_new_user();

create or replace function oe_profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.id = auth.uid()
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
    raise exception 'You cannot change your own role or access. Ask another administrator.';
  end if;
  return new;
end $$;

drop trigger if exists oe_profiles_guard_trg on oe_profiles;
create trigger oe_profiles_guard_trg before update on oe_profiles
  for each row execute function oe_profiles_guard();

create or replace function oe_touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists oe_projects_touch on oe_projects;
create trigger oe_projects_touch before update on oe_projects
  for each row execute function oe_touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. WORKFLOW FUNCTIONS (the only way requests change)
-- ---------------------------------------------------------------------

-- Liaison creates a request; reference ID is generated here, atomically.
create or replace function oe_create_request(
  p_request_date date, p_project_id uuid, p_date_needed date, p_remarks text, p_lines jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_prefix text; v_year int; v_seq int; v_ref text; v_id uuid;
  v_line jsonb; v_no int := 0; v_type oe_expense_types%rowtype; v_amount numeric;
  v_lid uuid; v_doc jsonb; v_docs int; v_need_doc boolean;
begin
  perform oe_require('requests.create');
  if p_date_needed is null then raise exception 'Enter the date needed.'; end if;
  if p_date_needed < coalesce(p_request_date, current_date) then
    raise exception 'The date needed can''t be before the request date.';
  end if;
  if nullif(trim(coalesce(p_remarks, '')), '') is null then raise exception 'Enter a description.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one request line.';
  end if;

  select coalesce(nullif(trim(data->>'ref_prefix'), ''), 'REQ') into v_prefix from oe_settings where id = 1;
  v_prefix := coalesce(v_prefix, 'REQ');
  v_year   := extract(year from coalesce(p_request_date, current_date))::int;

  insert into oe_counters (scope, last_value) values (v_prefix || '-' || v_year, 1)
  on conflict (scope) do update set last_value = oe_counters.last_value + 1
  returning last_value into v_seq;
  v_ref := v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  insert into oe_requests (ref_no, request_date, date_needed, project_id, liaison_id, liaison_name, remarks)
  values (v_ref, coalesce(p_request_date, current_date), p_date_needed, p_project_id,
          auth.uid(), oe_my_name(), nullif(trim(coalesce(p_remarks, '')), ''))
  returning id into v_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    select * into v_type from oe_expense_types
     where id = nullif(v_line->>'type_id', '')::uuid and is_active;
    if not found then raise exception 'Line %: choose an active expense type.', v_no; end if;
    if nullif(v_line->>'project_id', '') is null then raise exception 'Line %: choose a project.', v_no; end if;
    v_amount := round(coalesce(nullif(v_line->>'amount', '')::numeric, 0), 2);
    if v_amount <= 0 then raise exception 'Line %: amount must be greater than zero.', v_no; end if;
    if nullif(trim(coalesce(v_line->>'payee', '')), '') is null then
      raise exception 'Line %: enter the payee or recipient.', v_no;
    end if;
    if v_type.detail_label is not null and nullif(trim(coalesce(v_line->>'detail', '')), '') is null then
      raise exception 'Line %: fill in "%".', v_no, v_type.detail_label;
    end if;

    insert into oe_request_lines (request_id, line_no, project_id, category_id, type_id, description,
                                  payee, detail, basis_amount, basis_pct, rate, amount)
    values (v_id, v_no, (v_line->>'project_id')::uuid, v_type.category_id, v_type.id,
            nullif(trim(coalesce(v_line->>'description', '')), ''),
            nullif(trim(coalesce(v_line->>'payee', '')), ''),
            nullif(trim(coalesce(v_line->>'detail', '')), ''),
            nullif(v_line->>'basis_amount', '')::numeric,
            nullif(v_line->>'basis_pct', '')::numeric,
            nullif(v_line->>'rate', '')::numeric,
            v_amount)
    returning id into v_lid;

    -- supporting documents: files must already be uploaded by this user into the private bucket
    v_docs := 0;
    for v_doc in select value from jsonb_array_elements(coalesce(v_line->'documents', '[]'::jsonb)) loop
      if coalesce(v_doc->>'path', '') not like auth.uid()::text || '/%' then
        raise exception 'Line %: invalid document.', v_no;
      end if;
      if not exists (select 1 from storage.objects o where o.bucket_id = 'oe-documents' and o.name = v_doc->>'path') then
        raise exception 'Line %: an attached document did not finish uploading. Attach it again.', v_no;
      end if;
      insert into oe_line_documents (line_id, request_id, path, file_name, mime, size_bytes, uploaded_by, uploaded_by_name)
      values (v_lid, v_id, v_doc->>'path', coalesce(nullif(trim(v_doc->>'file_name'), ''), 'document'),
              nullif(v_doc->>'mime', ''), nullif(v_doc->>'size', '')::bigint, auth.uid(), oe_my_name());
      v_docs := v_docs + 1;
    end loop;
    select require_document into v_need_doc from oe_expense_categories where id = v_type.category_id;
    if coalesce(v_need_doc, false) and v_docs = 0 then
      raise exception 'Line %: attach a supporting document.', v_no;
    end if;
  end loop;

  perform oe_log(v_id, null, 'created', null);
  return v_ref;
end $$;

-- Liaison withdraws a request that is still on hold.
create or replace function oe_withdraw_request(p_id uuid, p_remarks text) returns void
language plpgsql security definer set search_path = public as $$
declare v_req oe_requests%rowtype;
begin
  if not oe_is_active() then raise exception 'Access denied.' using errcode = '42501'; end if;
  select * into v_req from oe_requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.liaison_id <> auth.uid() and not oe_is_admin() then
    raise exception 'Only the liaison who filed % can withdraw it.', v_req.ref_no;
  end if;
  if v_req.status not in ('on_hold', 'open') then
    raise exception '% has already been disbursed or closed, so it can''t be withdrawn.', v_req.ref_no;
  end if;
  update oe_request_lines set status = 'cancelled' where request_id = p_id;
  update oe_requests set status = 'cancelled', updated_at = now() where id = p_id;
  perform oe_log(p_id, null, 'withdrawn',
    nullif(concat_ws('; ', nullif(trim(coalesce(p_remarks, '')), ''),
                     case when v_req.erp_ref is not null then 'ERP reference ' || v_req.erp_ref || ' to be voided in Acumatica' end), ''));
end $$;

-- Top management approves. p_lines = [{"id": "...", "approved_amount": 123}] (optional per line).
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

  for v_line in select * from oe_request_lines where request_id = p_id order by line_no loop
    v_amt := null;
    select nullif(e->>'approved_amount', '')::numeric into v_amt
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
     where (e->>'id')::uuid = v_line.id;
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

create or replace function oe_reject_request(p_id uuid, p_remarks text) returns void
language plpgsql security definer set search_path = public as $$
declare v_req oe_requests%rowtype;
begin
  perform oe_require('requests.approve');
  if coalesce(trim(p_remarks), '') = '' then raise exception 'Add a reason for rejecting.'; end if;
  select * into v_req from oe_requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'on_hold' then raise exception '% is no longer waiting for approval.', v_req.ref_no; end if;
  update oe_request_lines set status = 'rejected' where request_id = p_id;
  update oe_requests
     set status = 'rejected', approved_by = auth.uid(), approved_by_name = oe_my_name(),
         approved_at = now(), approval_remarks = trim(p_remarks), updated_at = now()
   where id = p_id;
  perform oe_log(p_id, null, 'rejected', p_remarks);
end $$;

-- Liaison records the Acumatica cash fund reference number.
create or replace function oe_set_erp_ref(p_id uuid, p_erp_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare v_req oe_requests%rowtype;
begin
  perform oe_require('requests.erp_ref');
  if coalesce(trim(p_erp_ref), '') = '' then raise exception 'Enter the ERP reference number.'; end if;
  select * into v_req from oe_requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.liaison_id <> auth.uid() and not oe_has_perm('requests.view_all') then
    raise exception 'You can only update your own requests.';
  end if;
  if v_req.status <> 'open' then
    raise exception 'The ERP reference can only be set while % is open.', v_req.ref_no;
  end if;
  update oe_requests
     set erp_ref = trim(p_erp_ref), erp_ref_at = now(), erp_ref_by_name = oe_my_name(), updated_at = now()
   where id = p_id;
  perform oe_log(p_id, null, 'erp_ref',
    case when v_req.erp_ref is null then trim(p_erp_ref)
         else trim(p_erp_ref) || ' (was ' || v_req.erp_ref || ')' end);
end $$;

-- Accounting releases the fund.
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
  update oe_request_lines set status = 'disbursed' where request_id = p_id and status = 'open';
  update oe_requests
     set status = 'disbursed', disbursed_date = p_date, disbursed_by_name = oe_my_name(),
         disbursed_at = now(), disbursement_remarks = nullif(trim(coalesce(p_remarks, '')), ''), updated_at = now()
   where id = p_id;
  perform oe_log(p_id, null, 'disbursed', coalesce(nullif(trim(coalesce(p_remarks, '')), ''), to_char(p_date, 'Mon DD, YYYY')));
end $$;

-- Liaison records what was given to the client, per line. One payment per line: the amount
-- defaults to everything still with the liaison; if less is given, the line is Partly paid and
-- the rest can only be settled by accounting recording its return.
-- p_lines = [{id, amount}]
drop function if exists oe_mark_paid(uuid[], date, text);
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
begin
  perform oe_require('requests.pay');
  if p_date is null then raise exception 'Enter the date the fund was given.'; end if;
  if p_date > current_date then raise exception 'The date given can''t be in the future.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select at least one line.';
  end if;
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

-- Accounting / TM verify paid lines. Line closes per the close policy in settings.
create or replace function oe_verify_lines(p_line_ids uuid[], p_side text) returns void
language plpgsql security definer set search_path = public as $$
declare v_line oe_request_lines%rowtype; v_policy text; v_rid uuid;
begin
  if p_side = 'acct' then perform oe_require('requests.verify_acct');
  elsif p_side = 'tm' then perform oe_require('requests.verify_tm');
  else raise exception 'Unknown verification side %.', p_side; end if;
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then raise exception 'Select at least one line.'; end if;

  select coalesce(data->>'close_policy', 'either') into v_policy from oe_settings where id = 1;
  v_policy := coalesce(v_policy, 'either');

  for v_line in select * from oe_request_lines where id = any(p_line_ids) order by request_id, line_no for update loop
    if v_line.status <> 'paid' then
      raise exception 'Line % must be marked paid before it can be verified.', v_line.line_no;
    end if;
    if p_side = 'acct' and v_line.acct_verified_at is null then
      update oe_request_lines set acct_verified_at = now(), acct_verified_by_name = oe_my_name() where id = v_line.id;
      perform oe_log(v_line.request_id, v_line.id, 'verified_acct', null);
    elsif p_side = 'tm' and v_line.tm_verified_at is null then
      update oe_request_lines set tm_verified_at = now(), tm_verified_by_name = oe_my_name() where id = v_line.id;
      perform oe_log(v_line.request_id, v_line.id, 'verified_tm', null);
    end if;

    update oe_request_lines
       set status = 'closed', closed_at = now()
     where id = v_line.id
       and ((v_policy = 'either' and (acct_verified_at is not null or tm_verified_at is not null))
            or (acct_verified_at is not null and tm_verified_at is not null));
  end loop;

  for v_rid in select distinct request_id from oe_request_lines where id = any(p_line_ids) loop
    perform oe_refresh_status(v_rid);
  end loop;
end $$;

-- Aggregated usage per project and expense type, for threshold checks.
-- Returns nothing for users who may not see thresholds.
create or replace function oe_usage_summary()
returns table (project_id uuid, type_id uuid, pending numeric, open numeric,
               disbursed numeric, paid numeric, closed numeric)
language sql stable security definer set search_path = public as $$
  with base as (   -- returned money is not counted, like a rejected line
    select l.id, l.project_id, l.type_id, l.status,
           case when l.status = 'on_hold' then l.amount
                else coalesce(l.approved_amount, l.amount) - l.returned_amount end as net,
           coalesce(l.paid_amount, 0) as paid_amt,
           case l.status when 'part_paid' then 'paid' else l.status end as bucket
      from oe_request_lines l
     where l.status in ('on_hold','open','disbursed','part_paid','paid','closed')
  ),
  amounts as (
    select b.project_id, b.type_id, b.bucket, case b.status when 'part_paid' then b.paid_amt else b.net end as amt from base b
    union all   -- a partly paid line: what is still with the liaison counts as disbursed
    select b.project_id, b.type_id, 'disbursed', b.net - b.paid_amt from base b where b.status = 'part_paid'
    union all   -- reclassified parts count on the specific project ...
    select x.project_id, b.type_id, b.bucket, x.amount from oe_line_reclass x join base b on b.id = x.line_id
    union all   -- ... and come off the internal project the line was filed under
    select b.project_id, b.type_id, b.bucket, -x.amount from oe_line_reclass x join base b on b.id = x.line_id
  )
  select a.project_id, a.type_id,
         coalesce(sum(a.amt) filter (where a.bucket = 'on_hold'),   0),
         coalesce(sum(a.amt) filter (where a.bucket = 'open'),      0),
         coalesce(sum(a.amt) filter (where a.bucket = 'disbursed'), 0),
         coalesce(sum(a.amt) filter (where a.bucket = 'paid'),      0),
         coalesce(sum(a.amt) filter (where a.bucket = 'closed'),    0)
    from amounts a
   where oe_has_perm('report.view') or oe_has_perm('thresholds.view') or oe_has_perm('requests.approve')
   group by a.project_id, a.type_id;
$$;

-- Split a line filed under an internal project to specific projects.
-- p_parts = [{project_id, amount, remarks}], replacing any earlier split; [] undoes it.
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

-- Record money the liaison gave back on a disbursed or partly paid line: all of what is still
-- with the liaison, or part of it (several partial returns are fine). Accounting, top management
-- or an administrator only (role checked as well as the permission, so a role edit in Settings
-- can't hand it to liaisons). Someone who filed the request can't record its return, except an
-- administrator (who may also approve their own requests). Returned money leaves the
-- project report like a rejected line. Final: a return can't be undone.
drop function if exists oe_return_line(uuid, date, text, text);
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
  if p_return_date > current_date then raise exception 'The return date can''t be in the future.'; end if;
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

-- Edit a request that is still for approval (the filer or an administrator). Same checks as filing.
-- p_lines: [{id?, project_id, type_id, description, payee, detail, basis_amount, basis_pct, rate, amount,
--            keep_documents: [document ids to keep], documents: [newly uploaded files]}]
-- Lines not listed are removed; lines without an id are added. The reference number stays the same.
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

-- While a request is still for approval, the liaison who filed it (or an administrator)
-- can attach more supporting documents to a line, or remove one they attached.
create or replace function oe_add_line_documents(p_line_id uuid, p_docs jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_line  oe_request_lines%rowtype;
  v_req   oe_requests%rowtype;
  v_doc   jsonb;
  v_names text := '';
begin
  perform oe_require('requests.create');
  select * into v_line from oe_request_lines where id = p_line_id;
  if not found then raise exception 'Request line not found.'; end if;
  select * into v_req from oe_requests where id = v_line.request_id for update;
  if v_req.status <> 'on_hold' then raise exception 'Documents can only be added while % is waiting for approval.', v_req.ref_no; end if;
  if v_req.liaison_id <> auth.uid() and not oe_is_admin() then raise exception 'You can only add documents to your own requests.'; end if;
  if p_docs is null or jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) = 0 then raise exception 'Choose a file to attach.'; end if;
  for v_doc in select value from jsonb_array_elements(p_docs) loop
    if coalesce(v_doc->>'path', '') not like auth.uid()::text || '/%' then raise exception 'Invalid document.'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'oe-documents' and o.name = v_doc->>'path') then
      raise exception 'A document did not finish uploading. Attach it again.';
    end if;
    insert into oe_line_documents (line_id, request_id, path, file_name, mime, size_bytes, uploaded_by, uploaded_by_name)
    values (p_line_id, v_req.id, v_doc->>'path', coalesce(nullif(trim(v_doc->>'file_name'), ''), 'document'),
            nullif(v_doc->>'mime', ''), nullif(v_doc->>'size', '')::bigint, auth.uid(), oe_my_name());
    v_names := v_names || case when v_names = '' then '' else ', ' end || coalesce(nullif(trim(v_doc->>'file_name'), ''), 'document');
  end loop;
  update oe_requests set updated_at = now() where id = v_req.id;
  perform oe_log(v_req.id, p_line_id, 'documents_added', v_names);
end $$;

create or replace function oe_remove_line_document(p_doc_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_doc  oe_line_documents%rowtype;
  v_req  oe_requests%rowtype;
  v_need boolean;
begin
  perform oe_require('requests.create');
  select * into v_doc from oe_line_documents where id = p_doc_id;
  if not found then raise exception 'Document not found.'; end if;
  select * into v_req from oe_requests where id = v_doc.request_id for update;
  if v_req.status <> 'on_hold' then raise exception 'Documents can only be removed while % is waiting for approval.', v_req.ref_no; end if;
  if not oe_is_admin() and (v_req.liaison_id <> auth.uid() or v_doc.uploaded_by is distinct from auth.uid()) then
    raise exception 'You can only remove documents you attached to your own request.';
  end if;
  select c.require_document into v_need
    from oe_request_lines l join oe_expense_categories c on c.id = l.category_id where l.id = v_doc.line_id;
  if coalesce(v_need, false) and (select count(*) from oe_line_documents where line_id = v_doc.line_id) <= 1 then
    raise exception 'This line needs at least one supporting document. Attach the new one first, then remove this one.';
  end if;
  delete from oe_line_documents where id = p_doc_id;
  update oe_requests set updated_at = now() where id = v_req.id;
  perform oe_log(v_req.id, v_doc.line_id, 'document_removed', v_doc.file_name);
end $$;

-- ---------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table oe_role_permissions    enable row level security;
alter table oe_profiles            enable row level security;
alter table oe_settings            enable row level security;
alter table oe_projects            enable row level security;
alter table oe_expense_categories  enable row level security;
alter table oe_expense_types       enable row level security;
alter table oe_district_rates      enable row level security;
alter table oe_project_allocations enable row level security;
alter table oe_counters            enable row level security;
alter table oe_requests            enable row level security;
alter table oe_request_lines       enable row level security;
alter table oe_request_events      enable row level security;
alter table oe_line_reclass        enable row level security;
alter table oe_line_documents      enable row level security;
alter table oe_line_returns        enable row level security;

do $$
declare r record;
begin
  -- drop existing oe_ policies so this script can be re-run safely
  for r in select policyname, tablename from pg_policies
            where schemaname = 'public' and tablename like 'oe\_%' loop
    execute format('drop policy if exists %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

-- reference data: readable by active users
create policy oe_roles_read  on oe_role_permissions for select to authenticated using ((select oe_is_active()));
create policy oe_roles_write on oe_role_permissions for all    to authenticated
  using ((select oe_has_perm('settings.users')) and role <> 'admin')
  with check ((select oe_has_perm('settings.users')) and role <> 'admin' and role <> '');

create policy oe_profiles_read   on oe_profiles for select to authenticated using ((select oe_is_active()) or id = (select auth.uid()));
create policy oe_profiles_update on oe_profiles for update to authenticated
  using ((select oe_has_perm('settings.users'))) with check ((select oe_has_perm('settings.users')));

create policy oe_settings_read  on oe_settings for select to authenticated using ((select oe_is_active()));
create policy oe_settings_write on oe_settings for all    to authenticated
  using ((select oe_has_perm('settings.users'))) with check ((select oe_has_perm('settings.users')));

create policy oe_projects_read  on oe_projects for select to authenticated using ((select oe_is_active()));
create policy oe_projects_write on oe_projects for all    to authenticated
  using ((select oe_has_perm('projects.edit'))) with check ((select oe_has_perm('projects.edit')));

create policy oe_categories_read  on oe_expense_categories for select to authenticated using ((select oe_is_active()));
create policy oe_categories_write on oe_expense_categories for all    to authenticated
  using ((select oe_has_perm('settings.expenses'))) with check ((select oe_has_perm('settings.expenses')));

create policy oe_types_read  on oe_expense_types for select to authenticated using ((select oe_is_active()));
create policy oe_types_write on oe_expense_types for all    to authenticated
  using ((select oe_has_perm('settings.expenses'))) with check ((select oe_has_perm('settings.expenses')));

create policy oe_rates_read  on oe_district_rates for select to authenticated using ((select oe_is_active()));
create policy oe_rates_write on oe_district_rates for all    to authenticated
  using ((select oe_has_perm('settings.expenses'))) with check ((select oe_has_perm('settings.expenses')));

-- allocations are confidential: only roles that monitor thresholds
create policy oe_alloc_read on oe_project_allocations for select to authenticated using (
  (select oe_has_perm('report.view')) or (select oe_has_perm('thresholds.view'))
  or (select oe_has_perm('requests.approve')) or (select oe_has_perm('allocations.edit')));
create policy oe_alloc_write on oe_project_allocations for all to authenticated
  using ((select oe_has_perm('allocations.edit'))) with check ((select oe_has_perm('allocations.edit')));

-- requests: everyone with view_all / approve sees all; others see only their own.
-- No insert/update/delete policies: changes go through the oe_* functions.
create policy oe_requests_read on oe_requests for select to authenticated using (
  (select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
  or (liaison_id = (select auth.uid()) and (select oe_is_active())));

create policy oe_lines_read on oe_request_lines for select to authenticated using (
  (select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
  or exists (select 1 from oe_requests r where r.id = request_id and r.liaison_id = (select auth.uid())));

create policy oe_docs_meta_read on oe_line_documents for select to authenticated using (
  (select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
  or exists (select 1 from oe_requests r where r.id = request_id and r.liaison_id = (select auth.uid())));

create policy oe_returns_read on oe_line_returns for select to authenticated using (
  (select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
  or exists (select 1 from oe_requests r where r.id = request_id and r.liaison_id = (select auth.uid())));

create policy oe_reclass_read on oe_line_reclass for select to authenticated using (
  (select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
  or exists (select 1 from oe_requests r where r.id = request_id and r.liaison_id = (select auth.uid())));

create policy oe_events_read on oe_request_events for select to authenticated using (
  (select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
  or exists (select 1 from oe_requests r where r.id = request_id and r.liaison_id = (select auth.uid())));

-- oe_counters: no policies (functions only)

-- ---------------------------------------------------------------------
-- 6. GRANTS — nothing for anonymous visitors
-- ---------------------------------------------------------------------
revoke all on oe_role_permissions, oe_profiles, oe_settings, oe_projects, oe_expense_categories,
              oe_expense_types, oe_district_rates, oe_project_allocations, oe_counters,
              oe_requests, oe_request_lines, oe_request_events, oe_line_reclass, oe_line_documents,
              oe_line_returns from anon;

-- Request records change only through the workflow functions (which check roles, statuses and
-- ownership). Direct writes from signed-in users are refused outright, not just filtered out
-- by row security, so a future policy change can't open a side door.
revoke insert, update, delete, truncate on oe_requests, oe_request_lines, oe_request_events,
              oe_line_reclass, oe_line_documents, oe_line_returns, oe_counters from authenticated;

revoke execute on function oe_log(uuid, uuid, text, text)  from public, anon, authenticated;
revoke execute on function oe_refresh_status(uuid)         from public, anon, authenticated;
revoke execute on function oe_handle_new_user()            from public, anon, authenticated;
revoke execute on function oe_create_request(date, uuid, date, text, jsonb) from public, anon;
revoke execute on function oe_withdraw_request(uuid, text)                  from public, anon;
revoke execute on function oe_approve_request(uuid, jsonb, text)            from public, anon;
revoke execute on function oe_reject_request(uuid, text)                    from public, anon;
revoke execute on function oe_set_erp_ref(uuid, text)                       from public, anon;
revoke execute on function oe_disburse_request(uuid, date, text)            from public, anon;
revoke execute on function oe_mark_paid(jsonb, date, text)                  from public, anon;
revoke execute on function oe_verify_lines(uuid[], text)                    from public, anon;
revoke execute on function oe_usage_summary()                               from public, anon;
revoke execute on function oe_reclassify_line(uuid, jsonb)                  from public, anon;
revoke execute on function oe_add_line_documents(uuid, jsonb)               from public, anon;
revoke execute on function oe_update_request(uuid, date, date, text, jsonb)  from public, anon;
revoke execute on function oe_return_line(uuid, numeric, date, text, text)  from public, anon;
revoke execute on function oe_remove_line_document(uuid)                    from public, anon;

grant execute on function oe_create_request(date, uuid, date, text, jsonb) to authenticated;
grant execute on function oe_withdraw_request(uuid, text)                  to authenticated;
grant execute on function oe_approve_request(uuid, jsonb, text)            to authenticated;
grant execute on function oe_reject_request(uuid, text)                    to authenticated;
grant execute on function oe_set_erp_ref(uuid, text)                       to authenticated;
grant execute on function oe_disburse_request(uuid, date, text)            to authenticated;
grant execute on function oe_mark_paid(jsonb, date, text)                  to authenticated;
grant execute on function oe_verify_lines(uuid[], text)                    to authenticated;
grant execute on function oe_usage_summary()                               to authenticated;
grant execute on function oe_reclassify_line(uuid, jsonb)                  to authenticated;
grant execute on function oe_add_line_documents(uuid, jsonb)               to authenticated;
grant execute on function oe_update_request(uuid, date, date, text, jsonb)  to authenticated;
grant execute on function oe_return_line(uuid, numeric, date, text, text)  to authenticated;
grant execute on function oe_remove_line_document(uuid)                    to authenticated;
grant execute on function oe_has_perm(text)                                to authenticated;

-- ---------------------------------------------------------------------
-- 7. REALTIME (live refresh of the request list for all users)
-- ---------------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table oe_requests;      exception when others then null; end;
  begin alter publication supabase_realtime add table oe_request_lines; exception when others then null; end;
  begin alter publication supabase_realtime add table oe_line_reclass;  exception when others then null; end;
  begin alter publication supabase_realtime add table oe_line_documents; exception when others then null; end;
  begin alter publication supabase_realtime add table oe_line_returns;   exception when others then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 8. SIGN-IN PAGE — kept unbranded on purpose (no logo, company or system name).
--    Earlier setups stored a logo here and let visitors who were not signed in
--    read it. Both are removed, so nothing is readable before sign-in.
-- ---------------------------------------------------------------------
drop function if exists oe_get_branding();
drop function if exists oe_set_branding(text, boolean);
drop table if exists oe_branding;

-- ---------------------------------------------------------------------
-- 10. SUPPORTING DOCUMENTS STORAGE
--     Private bucket; files are only reachable through short-lived signed links.
--     Upload: people who can file requests, into their own folder.
--     Read: the uploader, or anyone who can see the request the file is attached to.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('oe-documents', 'oe-documents', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists oe_docs_upload on storage.objects;
create policy oe_docs_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'oe-documents'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (select oe_has_perm('requests.create')));

drop policy if exists oe_docs_read on storage.objects;
create policy oe_docs_read on storage.objects for select to authenticated using (
  bucket_id = 'oe-documents' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (select 1 from oe_line_documents d join oe_requests r on r.id = d.request_id
                where d.path = objects.name
                  and ((select oe_has_perm('requests.view_all')) or (select oe_has_perm('requests.approve'))
                       or r.liaison_id = (select auth.uid())))));
-- =====================================================================
--  SEED DATA  (safe to re-run; existing rows are kept)
-- =====================================================================

insert into oe_role_permissions (role, label, permissions, sort_order) values
  ('admin', 'Administrator', '["projects.view", "projects.edit", "allocations.edit", "report.view", "thresholds.view", "requests.create", "requests.view_own", "requests.view_all", "requests.approve", "requests.erp_ref", "requests.disburse", "requests.pay", "requests.verify_acct", "requests.verify_tm", "requests.reclassify", "requests.return", "analysis.view", "settings.expenses", "settings.users"]'::jsonb, 1),
  ('tm', 'Top management', '["projects.view", "allocations.edit", "report.view", "thresholds.view", "requests.view_all", "requests.approve", "requests.verify_tm", "requests.reclassify", "requests.return", "analysis.view"]'::jsonb, 2),
  ('accounting', 'Accounting', '["projects.view", "report.view", "thresholds.view", "requests.view_all", "requests.disburse", "requests.verify_acct", "requests.reclassify", "requests.return", "analysis.view"]'::jsonb, 3),
  ('liaison', 'Liaison', '["requests.create", "requests.view_own", "requests.erp_ref", "requests.pay"]'::jsonb, 4),
  ('viewer', 'Auditor (read only)', '["projects.view", "report.view", "requests.view_all"]'::jsonb, 5)
on conflict (role) do nothing;

insert into oe_settings (id, data) values (1, '{"ref_prefix": "REQ", "close_policy": "either", "near_limit_pct": 90, "idle_minutes": 30, "form_title": "Special Request Payment Form"}'::jsonb)
on conflict (id) do nothing;

-- The app no longer shows a company name anywhere; remove it from earlier setups
update oe_settings set data = data - 'company_name' where id = 1;

-- One-time upgrade: the default for closing paid lines is now 'either one verifying is enough'
update oe_settings set data = jsonb_set(data, '{close_policy}', '"either"')
 where id = 1 and data->>'close_policy' = 'both' and not data ? 'upgraded_close_either';
update oe_settings set data = data || '{"upgraded_close_either": true}'::jsonb where id = 1;

-- One-time upgrade: give top management and accounting the Analysis tab
update oe_role_permissions set permissions = permissions || '["analysis.view"]'::jsonb
 where role in ('tm','accounting') and not permissions ? 'analysis.view'
   and not coalesce((select data ? 'upgraded_analysis' from oe_settings where id = 1), false);
update oe_settings set data = data || '{"upgraded_analysis": true}'::jsonb where id = 1;

-- One-time upgrade: give top management and accounting the new reclassify permission
update oe_role_permissions set permissions = permissions || '["requests.reclassify"]'::jsonb
 where role in ('tm','accounting') and not permissions ? 'requests.reclassify'
   and not coalesce((select data ? 'upgraded_reclassify' from oe_settings where id = 1), false);
update oe_settings set data = data || '{"upgraded_reclassify": true}'::jsonb where id = 1;

-- One-time upgrade: administrators, top management and accounting may record fund returns
update oe_role_permissions set permissions = permissions || '["requests.return"]'::jsonb
 where role in ('admin','tm','accounting') and not permissions ? 'requests.return'
   and not coalesce((select data ? 'upgraded_return' from oe_settings where id = 1), false);
update oe_settings set data = data || '{"upgraded_return": true}'::jsonb where id = 1;

-- Earlier default prefixes (OER, then ADC) become REQ, once; a custom prefix is left alone,
-- and so is ADC if an administrator sets it again later.
update oe_settings set data = jsonb_set(data, '{ref_prefix}', '"REQ"') where id = 1
   and data->>'ref_prefix' in ('OER', 'ADC') and not coalesce(data ? 'prefix_req', false);
update oe_settings set data = data || '{"prefix_req": true}'::jsonb where id = 1;

insert into oe_expense_categories (name, sort_order) values
  ('Bidding', 1),
  ('Collection', 2),
  ('Support', 3),
  ('Inspection', 4),
  ('Testing', 5)
on conflict (name) do nothing;

-- Default rule (applied once; change it in Settings): collection lines need a supporting document
update oe_expense_categories set require_document = true
 where name = 'Collection' and not coalesce((select data ? 'default_doc_rule' from oe_settings where id = 1), false);
update oe_settings set data = data || '{"default_doc_rule": true}'::jsonb where id = 1;

insert into oe_expense_types (category_id, name, code, calc_method, rate, alloc_fixed, erp_account, detail_label, sort_order)
select c.id, v.name, v.code, v.calc_method, v.rate, v.alloc_fixed, v.erp_account, v.detail_label, v.sort_order
from (values
  ('Bidding', 'Buy-out', 'BO', 'contract_pct', 2::numeric, null::numeric, '6033 Bidding Buy-Out', null, 1),
  ('Bidding', 'Pre & Post Bidding', 'PPB', 'contract_pct', 2::numeric, null::numeric, '6032 Bidding Expense', null, 2),
  ('Bidding', 'Planning', 'PLN', 'contract_pct', 1::numeric, null::numeric, '6032 Bidding Expense', null, 3),
  ('Bidding', 'Bid Documents', 'BD', 'manual', null::numeric, 25000::numeric, '6031 Bidding Documents', null, 4),
  ('Collection', 'DE Share', 'DE', 'collection_pct', 3::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 5),
  ('Collection', 'Construction Share', 'CS', 'collection_pct', 1::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 6),
  ('Collection', 'Royalty', 'RY', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 7),
  ('Support', 'As-Built', 'AB', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 8),
  ('Support', 'As-Stake', 'AS', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 9),
  ('Support', 'Allowance', 'ALW', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 10),
  ('Support', 'Insurance', 'INS', 'manual', null::numeric, null::numeric, '6100 Insurance/Bonds Expense', 'Type of insurance', 11),
  ('Support', 'CPES', 'CPES', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 12),
  ('Support', 'DOLE', 'DOLE', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 13),
  ('Support', 'DIT', 'DIT', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 14),
  ('Support', 'Billboard', 'BB', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 15),
  ('Support', 'Others', 'OTH', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', 'Specify', 16),
  ('Inspection', 'QAU', 'QAU', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 17),
  ('Testing', 'MQC', 'MQC', 'manual', null::numeric, null::numeric, '6204 Representation Expenses - SOP', null, 18)
) as v(category, name, code, calc_method, rate, alloc_fixed, erp_account, detail_label, sort_order)
join oe_expense_categories c on c.name = v.category
on conflict (category_id, name) do nothing;

insert into oe_district_rates (district, type_id, rate)
select v.district, t.id, v.rate from (values
  ('Cebu 1st', 'Bidding', 'Pre & Post Bidding', 1::numeric),
  ('Cebu 2nd', 'Bidding', 'Pre & Post Bidding', 1::numeric),
  ('Cebu City', 'Bidding', 'Pre & Post Bidding', 1::numeric),
  ('Region VII', 'Bidding', 'Pre & Post Bidding', 1::numeric)
) as v(district, category, type_name, rate)
join oe_expense_categories c on c.name = v.category
join oe_expense_types t on t.category_id = c.id and t.name = v.type_name
on conflict (district, type_id) do nothing;

-- Projects imported from the 'Project Listing' sheet, plus two internal buckets
insert into oe_projects (code, year, district, name, location, category, contractor, abc_amount, bid_amount,
  revised_contract, contract_value, duration_days, bidding_date, ntp_date, original_expiry, suspension_notes,
  site_engineer, checker, status, status_group, accomplishment, is_internal) values
  ('23HN0116', 2023, 'Cebu 6th', 'Diversion Road, Sudtunggan (Basak) to Gabi, Lapu-Lapu', 'Lapu-Lapu City', 'Roads', 'ADC', 9800000, 9770000, null, 9770000, null, '2023-03-14', '2023-05-11', '2023-07-23', null, null, null, 'Ongoing', 'Ongoing', null, false),
  ('23HN0160', 2023, 'Cebu 6th', 'Cordova–Lapu-Lapu City Bridge', 'Lapu-Lapu City', 'Bridge', 'QM Builders', 98840000, 98840000, null, 98840000, 272, null, '2023-11-03', '2024-08-01', 'Revised expiry Jul 10, 2025 (suspensions/resumptions; rev. duration 254 days)', null, null, 'Ongoing', 'Ongoing', null, false),
  ('23HN0009', 2023, 'Cebu 6th', 'Rehab Mactan Circumferential Rd (K0014+000–920)', 'Lapu-Lapu City', 'Roads', 'QM Builders', 48020000, 48000000, null, 48000000, 111, '2022-10-26', '2023-02-15', '2023-06-05', null, null, null, 'Completed', 'Completed / Closeout', 1, false),
  ('23HG0050', 2023, 'Cebu City', 'Road Widening, N. Bacalso Ave (Cebu South Rd) (Re-bid)', 'Cebu City', 'Roads', 'ADC', 14406000, 14306000, null, 14306000, 92, null, '2023-07-07', '2023-10-07', null, null, null, 'Completed', 'Completed / Closeout', null, false),
  ('23H00063', 2023, 'Region VII', 'Multi-Purpose Office Building, DPWH RO VII, SRP', 'SRP, Cebu City', 'Building', 'ADC', 28950000, 28850000, null, 28850000, 210, null, '2023-09-13', '2024-04-10', null, null, null, 'For Retention', 'Completed / Closeout', null, false),
  ('23HO0242', 2023, 'Cebu 7th', 'Seawall Protection, Brgy. Montañeza, Malabuyoc (Sec 1)', 'Malabuyoc', 'Sea Wall', null, 26145400, 25753000, null, 25753000, 187, '2023-03-14', null, null, null, null, null, 'Unprogrammed', 'Not yet awarded / Bidding', null, false),
  ('23HO0245', 2023, 'Cebu 7th', 'Seawall Protection, Brgy. Poblacion, Alegria (Sec 1)', 'Alegria', 'Sea Wall', 'QM Builders', 20985600, 20670700, null, 20670700, 182, '2022-10-26', null, null, null, null, null, 'Unprogrammed', 'Not yet awarded / Bidding', null, false),
  ('23HO0247', 2023, 'Cebu 7th', 'Seawall Protection, Brgy. Poblacion, Alegria (Sec 2)', 'Alegria', 'Sea Wall', null, 19371100, 18080500, null, 18080500, 180, null, null, null, null, null, null, 'Unprogrammed', 'Not yet awarded / Bidding', null, false),
  ('23HO0305', 2023, 'Cebu 7th', 'Improvement of Bugho–Bala–Buguil Road, Moalboal', 'Moalboal', 'Roads', 'ADC', 7311000, 7311000, null, 7311000, 46, null, '2025-01-09', '2025-02-24', null, null, null, 'For Retention', 'Completed / Closeout', 1, false),
  ('24HO0008', 2024, 'Cebu 7th', 'Improvement of Bugho–Bala–Buguil Road, Brgy. Bala, Moalboal', 'Moalboal', 'Roads', 'ADC', 7422410, 7311000, null, 7311000, 44, '2023-11-21', '2024-02-16', '2024-03-31', null, 'Engr. Jason Pajo', 'Arnel Delicano', 'Completed', 'Completed / Closeout', 1, false),
  ('24HO0028', 2024, 'Cebu 7th', 'Dumanjug CIS Drainage System, Dumanjug', 'Dumanjug', 'Drainage', 'ADC', 4898200, 4825000, null, 4825000, null, '2023-11-23', '2024-02-16', '2024-05-27', null, 'Engr. Jason Pajo', 'Arnel Delicano', 'Completed (for acceptance)', 'Completed / Closeout', 1, false),
  ('24HO0038', 2024, 'Cebu 7th', 'Drainage System, Brgy. Balabagon, Moalboal', 'Moalboal', 'Drainage', 'ADC', 29394300, 28953000, 28510000, 28510000, null, '2023-11-28', '2024-06-03', '2024-12-24', null, 'Engr. Jason Pajo', 'Arnel Delicano', 'Completed (for final billing)', 'Completed / Closeout', 1, false),
  ('24HO0054', 2024, 'Cebu 7th', 'Banko Banko Bridge (B00461CB), Santander–Barili–Toledo Rd', 'Badian', 'Bridge', 'ADC', 19597400, 19303000, null, 19303000, null, '2023-12-05', '2024-02-16', '2024-06-09', null, 'Engr. Jason Pajo', 'Arnel Delicano', 'Completed (for acceptance)', 'Completed / Closeout', 1, false),
  ('24HO0058', 2024, 'Cebu 7th', 'Evacuation Center, Brgy. Poblacion, Alegria', 'Alegria', 'Building', 'ADC', 29698200, 29252000, null, 29252000, null, '2024-07-04', '2024-07-19', '2024-12-15', null, 'Engr. Jason Pajo', 'Arnel Delicano', 'Completed (for retention)', 'Completed / Closeout', 1, false),
  ('24HO0124', 2024, 'Cebu 7th', 'Drainage System Phase 2, Brgy. Tunga, Moalboal', 'Moalboal', 'Drainage', 'ADC', 29398200, 28957000, null, 28957000, null, '2024-03-07', '2024-04-01', null, 'Expired; for final billing', 'Engr. Jason Pajo', 'Arnel Delicano', 'Ongoing/expired – for final billing', 'Completed / Closeout', null, false),
  ('24HE0170', 2024, 'Cebu 2nd', 'Road at Sitio Matin-aw, Brgy. Tonggo, San Fernando', 'San Fernando', 'Roads', 'ADC', 4900000, 4890000, null, 4890000, 32, '2024-03-13', '2024-04-03', '2024-05-05', null, 'Engr. George Mabascog', 'James Marata', 'Completed', 'Completed / Closeout', 1, false),
  ('24HE0191', 2024, 'Cebu 2nd', 'Rehab Multi-Purpose Bldg (Brgy. Hall), Brgy. Linao, Minglanilla', 'Minglanilla', 'Building', 'ADC', 4950000, 4945000, null, 4945000, null, '2024-04-08', '2024-05-13', '2024-10-06', null, 'Engr. Laye', 'James Marata', 'For Retention', 'Completed / Closeout', 1, false),
  ('24HN0065', 2024, 'Cebu 6th', 'Diversion Road, Sudtunggan (Basak) to Gabi Phase 2, Lapu-Lapu', 'Lapu-Lapu City', 'Roads', 'ADC', 24500000, 24480000, null, 24480000, null, '2024-03-25', '2024-04-17', '2024-09-14', 'Suspended due to ROW', 'Engr. Ritchie Ostia', 'Silven', 'Suspended (ROW)', 'Suspended', 0.21, false),
  ('24HN0128', 2024, 'Cebu 6th', 'Basak–Sudtunggan Bypass Road Phase 3, Lapu-Lapu', 'Lapu-Lapu City', 'Roads', 'QM Builders', 99000000, 98950000, null, 98950000, null, null, null, null, 'Suspended due to ROW', 'Engr. Ritchie Ostia', 'Silven', 'Suspended (ROW)', 'Suspended', null, false),
  ('23HN0202', 2024, 'Cebu 6th', 'Solar Water System, Lapu-Lapu City', 'Lapu-Lapu City', 'Water Supply', 'ADC', 29400000, 29390000, null, 29390000, null, '2024-06-26', '2024-07-10', '2025-05-07', null, 'Engr. Ritchie Ostia', 'Silven', 'Completed (for acceptance)', 'Completed / Closeout', 1, false),
  ('24HD0103', 2024, 'Cebu 4th', 'Flood Control & Drainage, Malingin River, Bogo City', 'Bogo City', 'Flood Control', 'ADC', 19600000, 19590500, null, 19590500, null, null, null, null, null, 'Engr. Alvin Vergara', 'Charles Bayal', 'Completed (for acceptance)', 'Completed / Closeout', 1, false),
  ('24HD0105', 2024, 'Cebu 4th', 'Flood Control & Drainage, Taytayan Creek, Bogo City', 'Bogo City', 'Flood Control', 'ADC/QM JV', 49000000, 48985000, null, 48985000, null, '2024-07-05', '2024-07-18', '2025-02-04', null, 'Engr. Alvin Vergara', 'Charles Bayal', 'Completed (for retention)', 'Completed / Closeout', 1, false),
  ('24HD0106', 2024, 'Cebu 4th', 'Flood & Drainage System, Brgy. Gawaygaway, San Remigio', 'San Remigio', 'Flood Control', 'ADC', 19600000, 19500000, null, 19500000, null, '2024-06-24', '2024-07-02', '2024-12-14', null, 'Engr. Alvin Vergara', 'Charles Bayal', 'Completed (for retention)', 'Completed / Closeout', 1, false),
  ('24H00099', 2024, 'Region VII', 'Multi-Purpose Office Building Phase 2, DPWH RO VII, SRP', 'SRP, Cebu City', 'Building', 'ADC', 24125000, 24074000, 24075000, 24075000, null, '2024-05-04', '2024-06-14', '2024-12-10', null, 'Engr. George Mabascog', 'James Marata', 'Completed (for retention)', 'Completed / Closeout', 1, false),
  ('24HG0108', 2024, 'Cebu 2nd', 'DPWH Cebu 4th DEO Motorpool Building, Dalaguete', 'Dalaguete', 'Building', 'ADC', null, 29379000, null, 29379000, 190, '2024-09-21', '2024-10-17', '2025-04-25', '1st susp Oct 21, 2024 (90d); indefinite susp Jan 19, 2025; resume Dec 4, 2025; rev. susp Jun 12, 2026', 'Engr. Emilio', 'Clifford', 'Ongoing', 'Ongoing', 0.43, false),
  ('24HG0109', 2024, 'Cebu 2nd', 'DPWH Cebu 4th DEO QAS Building, Dalaguete', 'Casay, Dalaguete', 'Building', 'QG', null, 19580000, null, 19580000, null, null, null, null, null, 'Engr. Emilio', 'Clifford', 'Ongoing', 'Ongoing', 0.9, false),
  ('25HO0058', 2025, 'Cebu 7th', 'Tubod Bridge (B00502CB), Sibonga–Dumanjug Rd', 'Dumanjug', 'Bridge', 'ADC/QM JV', null, 13562000, null, 13562000, 98, null, '2025-02-19', '2025-05-28', 'No suspension', 'Engr. Alvin', 'Jhon Wil', 'Expired – for final billing', 'Completed / Closeout', 1, false),
  ('25HO0096', 2025, 'Cebu 7th', 'Dumanjug CIS Drainage System Phase 2, Dumanjug', 'Dumanjug', 'Flood Control', 'ADC', null, 14479000, null, 14479000, 140, '2025-02-01', '2025-03-27', '2025-08-14', '30-day suspension; revised Nov 5, 2025', 'Engr. Alvin', 'Jhon Wil', 'Expired – for final billing', 'Completed / Closeout', 0.9, false),
  ('25HO0095', 2025, 'Cebu 7th', 'Drainage System, Brgy. Balabagon, Moalboal', 'Moalboal', 'Drainage', 'ADC/QM JV', null, 24009000, null, 24009000, 198, '2025-02-19', '2025-04-10', '2025-10-25', '90-day suspension; revised Jan 21, 2026', 'Engr. Jason Pajo', 'Arnel Delicano', 'Ongoing', 'Ongoing', null, false),
  ('25HO0097', 2025, 'Cebu 7th', 'Drainage System Phase 3, Brgy. Tunga, Moalboal', 'Moalboal', 'Drainage', 'ADC/QM JV', null, 14479500, null, 14479500, 160, '2025-02-18', '2025-03-27', '2025-09-03', '90-day suspension; revised Dec 2, 2025 (for indefinite suspension)', 'Engr. Jason Pajo', 'Arnel Delicano', 'For indefinite suspension', 'Suspended', null, false),
  ('25HO0040', 2025, 'Cebu 7th', 'Improvement of Ilaya–Sima–Looc–Poblacion Road, Dumanjug', 'Dumanjug', 'Roads', 'ADC/QM JV', null, 14627000, null, 14627000, 114, '2025-02-11', '2025-03-17', '2025-07-09', '90-day suspension + 30-day TE; revised Oct 6, 2025', 'Engr. Alvin', 'Jhon Mark', 'Expired – for final billing', 'Completed / Closeout', 0.883, false),
  ('25HO0069', 2025, 'Cebu 7th', 'Drainage System, Brgy. Tapon, Dumanjug', 'Dumanjug', 'Drainage', 'QM Builders', null, 48264000, null, 48264000, 235, '2025-02-11', '2025-03-17', '2025-10-04', 'Resumption Aug 11, 2025; suspension Nov 6, 2025', 'Engr. Alvin', 'Jhon Mark', 'Suspended', 'Suspended', 0.226, false),
  ('25HO0168', 2025, 'Cebu 7th', 'Ronda Multi-Purpose Building Phase 1, Ronda', 'Ronda', 'Building', 'ADC/QM JV', 49999000, 48020000, null, 48020000, 265, '2025-03-13', '2025-07-11', '2026-04-02', '90-day suspension; revised Jul 1, 2026', 'Engr. Ryan', 'Redentor', 'Suspended', 'Suspended', null, false),
  ('25HO0172', 2025, 'Cebu 7th', 'Concreting Cotcoton–Bullogan FMR, Dumanjug', 'Dumanjug', 'Roads', 'ADC/QM JV', null, null, null, null, null, null, null, null, null, 'Engr. Jason Pajo', 'Arnel Delicano', 'Not yet awarded', 'Not yet awarded / Bidding', null, false),
  ('25HO0121', 2025, 'Cebu 7th', 'Road, Brgy. Sta. Filomena–Madridejos, Alegria', 'Alegria', 'Roads', 'ADC/QM JV', null, null, null, null, null, null, null, null, 'Advance work', 'Engr. Ryan', 'Redentor', 'Advance work – unawarded', 'Not yet awarded / Bidding', null, false),
  ('RONDA FMR', 2025, 'Cebu 7th', 'Concreting FMR, Ronda (DAR)', 'Ronda', 'Roads', 'ADC', null, null, null, null, null, null, null, null, null, 'Engr. Jason Pajo', 'Arnel Delicano', 'For Bidding', 'Not yet awarded / Bidding', null, false),
  ('25HE0083', 2025, 'Cebu 2nd', 'Road to BUFA Mountain Resort, Brgy. Butong, Argao', 'Argao', 'Roads', 'ADC/QM JV', 39200000, 38415000, null, 38415000, 125, '2025-03-26', '2025-07-01', '2025-10-30', '90-day suspension; Jan 28, 2026 for time extension', 'Engr. Ruben / Engr. Laye', 'Jhonwel', 'Suspended', 'Suspended', 0.1, false),
  ('25HE0086', 2025, 'Cebu 2nd', 'Road to Bugasok Falls & Balay sa Agat Cave, Brgy. Conalum, Argao', 'Argao', 'Roads', 'ADC/QM JV', 49000000, 48020000, null, 48020000, 143, '2025-03-26', '2025-07-01', '2025-11-17', '90-day suspension; Feb 15, 2026 for time extension', 'Engr. Ruben / Engr. Laye', 'Jhonwel', 'Suspended', 'Suspended', 0.201, false),
  ('25HE0130', 2025, 'Cebu 2nd', 'Road, Brgy. Tabayag–Tiguib (Tiguib Highlands), Argao', 'Argao', 'Roads', null, null, null, null, null, null, null, null, null, null, 'Engr. Emilio', null, 'For Re-bid', 'Not yet awarded / Bidding', null, false),
  ('25HN0017', 2025, 'Cebu 6th', 'Causeway, Brgy. Marigondon, Lapu-Lapu Phase 2', 'Lapu-Lapu City', 'Causeway', 'ADC', null, 14675000, null, 14675000, 215, '2024-11-08', '2025-02-11', '2025-09-14', null, 'Engr. Ritchie', 'Silven', 'For Final Billing', 'Completed / Closeout', 1, false),
  ('25HN0180', 2025, 'Cebu 6th', 'Road, Sudtunggan (Basak) to Babag Phase 3, Lapu-Lapu', 'Lapu-Lapu City', 'Roads', null, null, null, null, null, null, null, null, null, null, 'Engr. Ritchie', 'Silven', 'For Bidding', 'Not yet awarded / Bidding', null, false),
  ('25HH0117', 2025, 'Cebu City', 'Revetment, Bulacao River, Brgy. To-ong, Cebu City', 'Cebu City', 'Flood Control', 'ADC/QM JV', null, 38612000, null, 38612000, 222, '2025-01-01', '2025-03-27', '2025-11-24', 'For suspension (Feb 2, 2026); V.O. ongoing', 'Engr. Jaypee', 'Danie', 'For suspension (V.O. ongoing)', 'Suspended', 0.584, false),
  ('25HH0128', 2025, 'Cebu City', 'Mambaling South Boulevard, Cebu City', 'Cebu City', 'Boulevard', 'ADC/QM JV', null, 93624000, null, 93624000, 333, '2025-03-19', '2025-03-27', '2026-02-26', 'Indefinite suspension', 'Engr. Jaypee', 'Danie', 'Suspended', 'Suspended', 0, false),
  ('25H00102', 2025, 'Region VII', 'Multi-Purpose Office Building Phase III, DPWH RO VII, SRP', 'SRP, Cebu City', 'Building', 'ADC', null, 14185500, null, 14185500, 175, '2025-07-21', '2025-08-12', '2026-02-03', 'No suspension', 'Engr. George', null, 'Ongoing', 'Ongoing', 0.9, false),
  ('ADVANCES', null, null, 'Advances (not yet charged to a project)', null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'Internal', 'Internal', null, true),
  ('FOR-ASSIGNMENT', null, null, 'For assignment (project to be identified)', null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'Internal', 'Internal', null, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- FIRST ADMIN: create your user in Authentication → Users, then run:
--   update oe_profiles set role = 'admin', is_active = true, full_name = 'Your Name'
--    where email = 'you@company.com';
-- ---------------------------------------------------------------------
