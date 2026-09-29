# Upstream update merged on 2026-09-29

Source: `ExpenseMonitoring (2).jsx` and `index.ts` in this folder, a later version of the app developed in
another project. They were three-way merged onto `src/App.jsx` (base: `docs/ExpenseMonitoring.jsx`) with no
conflicts, and the invite function's new rule was added to `supabase/functions/oe-invite-user/index.ts`.

No SQL came with the update, so the database side was written here:
`supabase/migrations/20260929000000_oe_acumatica_and_role_guards.sql`.

## What the update brings

- **Acumatica items**: a new Settings tab with the INV ID list. An item in use can't be removed.
- **Per-type mapping**: each expense type can be mapped to an Acumatica item (Expense categories and types → edit).
  The bidding types, Royalty and Insurance are mapped by default; the rest show "Not mapped yet" until confirmed.
- **Particulars column** in Approvals and request details (the line's remarks), instead of small text under each line.
- **Printed form**: columns are No., Project ID, Code, Acumatica details, Particulars and Amount. The three
  signature lines and "Type of request" are gone; bottom boxes show "Requested by" with the date submitted and
  "Approved by top management" with the date and time.
- **Role rules**, enforced in the database as well as on screen: only an administrator can give, change or remove
  administrator access or invite an administrator; a non-administrator can't change the rights of their own role.

## To apply on the live project

```bash
supabase db push
supabase functions deploy oe-invite-user
```
