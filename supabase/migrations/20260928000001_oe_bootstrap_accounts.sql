-- =====================================================================
--  PROJECT EXPENSE MONITORING — account bootstrap and access hardening
--  Runs after 20260928000000_oe_schema.sql (supabase db push applies both in order).
--  Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Nothing for anonymous visitors, not even the helper functions.
--    (RLS policies still call these as the signed-in "authenticated" role.)
-- ---------------------------------------------------------------------
revoke execute on function oe_is_active()   from public, anon;
revoke execute on function oe_is_admin()    from public, anon;
revoke execute on function oe_has_perm(text) from public, anon;
revoke execute on function oe_require(text)  from public, anon;
revoke execute on function oe_my_name()      from public, anon;
grant  execute on function oe_is_active(), oe_is_admin(), oe_has_perm(text), oe_require(text), oe_my_name() to authenticated;

-- ---------------------------------------------------------------------
-- 2. oe_bootstrap_profile: give an EXISTING sign-in (created in Authentication → Users)
--    its name, role and access. For the developer / SQL Editor only.
-- ---------------------------------------------------------------------
create or replace function oe_bootstrap_profile(p_email text, p_full_name text, p_role text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_email text := lower(trim(p_email));
begin
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    raise exception 'No sign-in with email %. Create it first (Authentication → Users → Add user) or use oe_create_login().', v_email;
  end if;
  if not exists (select 1 from oe_role_permissions where role = p_role) then
    raise exception 'Unknown role "%". Roles: %', p_role, (select string_agg(role, ', ' order by sort_order) from oe_role_permissions);
  end if;
  insert into oe_profiles (id, email, full_name, role, is_active)
  values (v_id, v_email, coalesce(nullif(trim(p_full_name), ''), split_part(v_email, '@', 1)), p_role, true)
  on conflict (id) do update
    set email = excluded.email, full_name = excluded.full_name, role = excluded.role, is_active = true;
  return v_id;
end $$;
revoke execute on function oe_bootstrap_profile(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. oe_create_login: create a confirmed email + password sign-in AND its profile straight
--    from SQL, so the first accounts (admin, top management, accounting, liaison) can be
--    made without the dashboard. For the developer / SQL Editor only.
--    An email that already has a sign-in keeps its password; only the profile is updated.
-- ---------------------------------------------------------------------
create or replace function oe_create_login(p_email text, p_password text, p_full_name text, p_role text) returns uuid
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_id uuid;
  v_email text := lower(trim(p_email));
begin
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Invalid email address "%".', p_email;
  end if;
  if not exists (select 1 from oe_role_permissions where role = p_role) then
    raise exception 'Unknown role "%". Roles: %', p_role, (select string_agg(role, ', ' order by sort_order) from oe_role_permissions);
  end if;

  select id into v_id from auth.users where lower(email) = v_email;

  if v_id is null then
    if length(coalesce(p_password, '')) < 8 then
      raise exception 'Use a password of at least 8 characters for %.', v_email;
    end if;
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token, is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      crypt(p_password, gen_salt('bf')), now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', p_full_name),
      now(), now(),
      '', '', '', '', '', '', '', '', false
    );
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text, 'email',
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
            now(), now(), now());
  else
    raise notice 'Sign-in % already exists; password left unchanged, profile updated.', v_email;
  end if;

  perform oe_bootstrap_profile(v_email, p_full_name, p_role);
  return v_id;
end $$;
revoke execute on function oe_create_login(text, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Reset a bootstrapped account's password from SQL (developer only), for example after
--    handing over the first credentials. Never callable through the API.
-- ---------------------------------------------------------------------
create or replace function oe_set_login_password(p_email text, p_password text) returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
declare v_id uuid;
begin
  if length(coalesce(p_password, '')) < 8 then raise exception 'Use at least 8 characters.'; end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then raise exception 'No sign-in with email %.', p_email; end if;
  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = v_id;
end $$;
revoke execute on function oe_set_login_password(text, text) from public, anon, authenticated;
