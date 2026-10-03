-- Invite status for Settings → Users: when a person was invited and when they set their password.
-- invited_at  : copied from auth.users.invited_at by the sign-up trigger (and set again by the invite function)
-- accepted_at : set by oe_accept_invite(), which the app calls right after the invited person confirms a password

alter table oe_profiles
  add column if not exists invited_at  timestamptz,
  add column if not exists accepted_at timestamptz;

-- New sign-ins created by an invite carry the invite time over to the profile.
create or replace function oe_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into oe_profiles (id, email, full_name, invited_at)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)), new.invited_at)
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function oe_handle_new_user() from public, anon, authenticated;

-- Called by the signed-in person themselves once their password is saved. Idempotent; touches no other column,
-- so the self-change guard on role / is_active is not involved.
create or replace function oe_accept_invite() returns void
language sql security definer set search_path = public as $$
  update oe_profiles set accepted_at = now()
   where id = auth.uid() and accepted_at is null;
$$;
revoke execute on function oe_accept_invite() from public, anon;
grant  execute on function oe_accept_invite() to authenticated;

-- Backfill from Supabase Auth for invites sent before this migration:
-- invited = auth.users.invited_at; accepted = the person has a password and has signed in through the link.
do $$
begin
  update oe_profiles p
     set invited_at  = coalesce(p.invited_at, u.invited_at),
         accepted_at = coalesce(p.accepted_at,
                         case when u.invited_at is not null and nullif(u.encrypted_password, '') is not null
                              then coalesce(u.last_sign_in_at, u.email_confirmed_at) end)
    from auth.users u
   where u.id = p.id;
exception when others then
  raise notice 'oe invite status backfill skipped: %', sqlerrm;
end $$;
