-- Deleting a user (Settings → Users → Delete, done by the oe-delete-user function).
-- A person who filed, approved or touched anything keeps a profile row so their name stays on those records;
-- the row is marked deleted and the sign-in account is removed, so the same email can be invited again.
-- A person with no records is removed completely.

-- The profile used to disappear with the sign-in account (on delete cascade). Requests point at profiles, so that
-- deletion would have failed, or taken the requests with it. Profiles now outlive the account.
alter table oe_profiles drop constraint if exists oe_profiles_id_fkey;

alter table oe_profiles
  add column if not exists deleted_at      timestamptz,
  add column if not exists deleted_by_name text;

-- What a person has in the system, for the confirmation shown to the administrator.
create or replace function oe_user_activity(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  if not oe_has_perm('settings.users') then
    raise exception 'Your role can''t manage users.';
  end if;
  select jsonb_build_object(
    'requests',             (select count(*) from oe_requests where liaison_id = p_id),
    'requests_in_progress', (select count(*) from oe_requests where liaison_id = p_id and status in ('on_hold','open','disbursed','paid')),
    'approvals',            (select count(*) from oe_requests where approved_by = p_id),
    'events',               (select count(*) from oe_request_events where actor_id = p_id),
    'documents',            (select count(*) from oe_line_documents where uploaded_by = p_id),
    'returns',              (select count(*) from oe_line_returns where created_by = p_id),
    'reclass',              (select count(*) from oe_line_reclass where created_by = p_id),
    'devices',              (select count(*) from oe_push_subscriptions where user_id = p_id),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('ref_no', r.ref_no, 'status', r.status, 'request_date', r.request_date, 'role', r.rel) order by r.created_at desc)
        from (
          select ref_no, status, request_date, created_at, case when liaison_id = p_id then 'filed' else 'approved' end as rel
            from oe_requests
           where liaison_id = p_id or approved_by = p_id
           order by created_at desc
           limit 8
        ) r), '[]'::jsonb)
  ) into v;
  return v;
end $$;
revoke execute on function oe_user_activity(uuid) from public, anon;
grant  execute on function oe_user_activity(uuid) to authenticated;
