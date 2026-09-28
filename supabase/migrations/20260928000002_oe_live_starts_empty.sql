-- =====================================================================
--  PROJECT EXPENSE MONITORING — live starts empty
--  The first migration seeds 44 sample projects from the old 'Project Listing' sheet so a
--  fresh database looks populated. Live is meant to start as a brand-new system: this removes
--  those sample projects once, keeping the two internal buckets (ADVANCES, FOR-ASSIGNMENT)
--  that the reclassification workflow needs. Projects you added yourself, and any seeded
--  project that already carries requests or allocations, are left alone.
--  Demo mode is unaffected: its sample data lives only in the browser.
-- =====================================================================

do $$
begin
  if coalesce((select data ? 'seed_projects_removed' from oe_settings where id = 1), false) then
    return;
  end if;

  delete from oe_projects p
   where p.is_internal = false
     and p.code in (
  '23HN0116',
  '23HN0160',
  '23HN0009',
  '23HG0050',
  '23H00063',
  '23HO0242',
  '23HO0245',
  '23HO0247',
  '23HO0305',
  '24HO0008',
  '24HO0028',
  '24HO0038',
  '24HO0054',
  '24HO0058',
  '24HO0124',
  '24HE0170',
  '24HE0191',
  '24HN0065',
  '24HN0128',
  '23HN0202',
  '24HD0103',
  '24HD0105',
  '24HD0106',
  '24H00099',
  '24HG0108',
  '24HG0109',
  '25HO0058',
  '25HO0096',
  '25HO0095',
  '25HO0097',
  '25HO0040',
  '25HO0069',
  '25HO0168',
  '25HO0172',
  '25HO0121',
  'RONDA FMR',
  '25HE0083',
  '25HE0086',
  '25HE0130',
  '25HN0017',
  '25HN0180',
  '25HH0117',
  '25HH0128',
  '25H00102')
     and not exists (select 1 from oe_request_lines l where l.project_id = p.id)
     and not exists (select 1 from oe_line_reclass x where x.project_id = p.id)
     and not exists (select 1 from oe_project_allocations a where a.project_id = p.id);

  update oe_settings set data = data || '{"seed_projects_removed": true}'::jsonb where id = 1;
end $$;
