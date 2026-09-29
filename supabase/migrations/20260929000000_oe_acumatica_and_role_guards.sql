-- =====================================================================
--  PROJECT EXPENSE MONITORING — Acumatica items and role guards (2026-09-29)
--  Matches the app update that added Settings → Acumatica items, the per-type Acumatica
--  mapping shown on the printed form, and the stricter role rules. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Acumatica items (INV ID + description) and the mapping on each expense type
-- ---------------------------------------------------------------------
create table if not exists oe_acumatica_items (
  id          uuid primary key default gen_random_uuid(),
  inv_id      text not null unique,
  description text not null default '',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

alter table oe_expense_types
  add column if not exists acumatica_item_id uuid references oe_acumatica_items(id) on delete restrict;
create index if not exists oe_types_acu_idx on oe_expense_types (acumatica_item_id);

alter table oe_acumatica_items enable row level security;
drop policy if exists oe_acu_read  on oe_acumatica_items;
drop policy if exists oe_acu_write on oe_acumatica_items;
create policy oe_acu_read  on oe_acumatica_items for select to authenticated using ((select oe_is_active()));
create policy oe_acu_write on oe_acumatica_items for all    to authenticated
  using ((select oe_has_perm('settings.expenses'))) with check ((select oe_has_perm('settings.expenses')));

revoke all on oe_acumatica_items from anon;
grant select, insert, update, delete on oe_acumatica_items to authenticated;

-- The INV ID list used when filing cash advances (edit it in Settings → Acumatica items)
insert into oe_acumatica_items (inv_id, description, sort_order) values
  ('OPGAE0031', 'Coordination – Material Testing Fees', 1),
  ('OPGAE0025', 'Coordination - External Agencies', 2),
  ('OPGAE0026', 'Coordination - Local Offices', 3),
  ('OPGAE0027', 'Coordination - Operation (External)', 4),
  ('OPGAE0028', 'Coordination - Operation (Local)', 5),
  ('OPGAE0029', 'Coordination – Planning Phase', 6),
  ('OPGAE0030', 'Coordination – Construction Phase', 7),
  ('OPGAE0032', 'Coordination – Project Initiation Phase', 8),
  ('OPGAE0033', 'Coordination – Settlement Fees', 9),
  ('OPPRE0009', 'Royalty Expense', 10),
  ('OPPRE0008', 'Bidding Buy-Out', 11),
  ('OPPRE0007', 'Bidding Expense', 12),
  ('OPPRE0006', 'Bidding Documents', 13),
  ('OPGAE0007', 'Insurance/Bonds Expense', 14)
on conflict (inv_id) do nothing;

-- One-time default mapping for the types whose Acumatica item is unambiguous. Every other type
-- shows "Not mapped yet" until management confirms it in Settings → Expense categories and types.
update oe_expense_types t
   set acumatica_item_id = a.id
  from (values ('BO', 'OPPRE0008'), ('PPB', 'OPPRE0007'), ('BD', 'OPPRE0006'), ('PLN', 'OPGAE0029'),
               ('RY', 'OPPRE0009'), ('INS', 'OPGAE0007')) as m(code, inv_id)
  join oe_acumatica_items a on a.inv_id = m.inv_id
 where t.code = m.code and t.acumatica_item_id is null
   and not coalesce((select data ? 'acu_mapped' from oe_settings where id = 1), false);
update oe_settings set data = data || '{"acu_mapped": true}'::jsonb where id = 1;

-- ---------------------------------------------------------------------
-- 2. Role guards, enforced in the database (the screens show the same rules)
--    a) nobody changes their own role or access (already there)
--    b) only an administrator may give, change or remove administrator access
--    c) a non-administrator may not change the rights of their own role
--    The service role (bootstrap, invite function) has no auth.uid() and is not affected.
-- ---------------------------------------------------------------------
create or replace function oe_profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed boolean := new.role is distinct from old.role or new.is_active is distinct from old.is_active;
begin
  if auth.uid() is null or not changed then
    return new;
  end if;
  if new.id = auth.uid() then
    raise exception 'You cannot change your own role or access. Ask another administrator.';
  end if;
  if not oe_is_admin() and (old.role = 'admin' or new.role = 'admin') then
    raise exception 'Only an administrator can give, change or remove administrator access.';
  end if;
  return new;
end $$;

drop trigger if exists oe_profiles_guard_trg on oe_profiles;
create trigger oe_profiles_guard_trg before update on oe_profiles
  for each row execute function oe_profiles_guard();

create or replace function oe_role_permissions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  my_role text;
  target  text := case when tg_op = 'DELETE' then old.role else new.role end;
begin
  if auth.uid() is not null and not oe_is_admin() then
    select role into my_role from oe_profiles where id = auth.uid();
    if target = my_role then
      raise exception 'You can''t change your own role''s rights. Ask an administrator.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists oe_role_permissions_guard_trg on oe_role_permissions;
create trigger oe_role_permissions_guard_trg before insert or update or delete on oe_role_permissions
  for each row execute function oe_role_permissions_guard();

revoke execute on function oe_profiles_guard()         from public, anon, authenticated;
revoke execute on function oe_role_permissions_guard() from public, anon, authenticated;
