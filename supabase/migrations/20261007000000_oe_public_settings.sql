-- What the sign-in page may know before anyone signs in: only whether "Try the demo with sample data" is offered.
-- Administrators switch it in Settings → System (oe_settings.data.demo_enabled; missing means on).
-- Nothing else from oe_settings is exposed; visitors who are not signed in still read no tables.
create or replace function oe_public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'demo_enabled',
    coalesce((select data->'demo_enabled' <> 'false'::jsonb from oe_settings where id = 1 and data ? 'demo_enabled'), true)
  );
$$;
revoke execute on function oe_public_settings() from public;
grant  execute on function oe_public_settings() to anon, authenticated;
