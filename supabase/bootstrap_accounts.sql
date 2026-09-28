-- =====================================================================
--  FIRST ACCOUNTS — run ONCE in Supabase → SQL Editor, after `supabase db push`.
--  This file is NOT a migration on purpose: it holds credentials, so edit it locally,
--  run it, and do not commit real passwords.
--
--  Each line creates a confirmed sign-in (email + password) and its role, ready to use
--  on the live sign-in form. If the email already has a sign-in, its password is kept
--  and only the profile (name, role, access) is updated.
--
--  Roles: admin (Administrator), tm (Top management), accounting (Accounting),
--         liaison (Liaison), viewer (Auditor, read only)
-- =====================================================================

select oe_create_login('admin@yourcompany.com',      'ChangeMe-Admin-2026!',      'System Administrator', 'admin');
select oe_create_login('management@yourcompany.com', 'ChangeMe-TM-2026!',         'Top Management',       'tm');
select oe_create_login('accounting@yourcompany.com', 'ChangeMe-Accounting-2026!', 'Accounting Officer',   'accounting');
select oe_create_login('liaison@yourcompany.com',    'ChangeMe-Liaison-2026!',    'Liaison Officer',      'liaison');

-- Check the result
select p.email, p.full_name, p.role, r.label, p.is_active
  from oe_profiles p join oe_role_permissions r on r.role = p.role
 order by r.sort_order;

-- ---------------------------------------------------------------------
-- ALTERNATIVE: you created the sign-ins by hand in Authentication → Users (Add user,
-- tick "Auto confirm"). Then only the profile needs a role:
--
--   select oe_bootstrap_profile('admin@yourcompany.com', 'System Administrator', 'admin');
--
-- Change a bootstrapped password later:
--
--   select oe_set_login_password('admin@yourcompany.com', 'NewStrongPassword!');
-- ---------------------------------------------------------------------
