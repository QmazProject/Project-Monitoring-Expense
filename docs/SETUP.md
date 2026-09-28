# Project Expense Monitoring: setup

Three pieces: the database (`supabase_schema.sql`), one edge function for inviting users (`supabase/functions/oe-invite-user`), and the app (`ExpenseMonitoring.jsx`). All tables are prefixed `oe_`, so the system can live in its own Supabase project or share one with another system.

## 1. Database

1. In Supabase, open **SQL Editor**, paste all of `supabase_schema.sql`, and run it. It is safe to run again later; existing rows are kept.
2. It creates the tables, row level security, the workflow functions, the roles and access rights, the expense categories and types, the SOP district rates, and the 44 projects from the Project Listing sheet (plus two internal buckets, ADVANCES and FOR-ASSIGNMENT).
3. Already ran an earlier version? Run the updated file again. It adds what's new, removes what's retired, and keeps your existing requests and settings.

## 2. Sign-in settings

1. **Authentication → Sign In / Providers**: turn off *Allow new users to sign up*. People only get in by invite.
2. **Authentication → URL Configuration**: set *Site URL* to the app's address and add the same address under *Redirect URLs*. Invite and password-reset links return there.

## 3. First administrator

1. **Authentication → Users → Add user**: enter your email and a password, and tick *Auto confirm*.
2. In SQL Editor, run (with your details):

```sql
update oe_profiles set role = 'admin', is_active = true, full_name = 'Your Name'
 where email = 'you@company.com';
```

Everyone else is invited from **Settings → Users** in the app.

## 4. Invite function

With the Supabase CLI, from the folder that contains `supabase/`:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy oe-invite-user
```

It uses the project's built-in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`; nothing to configure. It only works for users whose role has *Manage users and access rights*.

## 5. App

1. Open `ExpenseMonitoring.jsx` and fill `CONFIG` at the top with the project URL and **anon** key (Project Settings → API). Never use the service_role key in the app.
   Optional: set `usernameDomain` to your company email domain (for example `example.com.ph`). People can then sign in with just their username, the part of their email before @. A full email address always works too.
2. Host it like any React app, for example with Vite on Vercel:
   - `npm create vite@latest oe-expenses -- --template react`
   - replace `src/App.jsx` with `ExpenseMonitoring.jsx` (it has `export default App`)
   - `npm run build` and deploy.
3. Optional: `npm i @supabase/supabase-js` and switch `loadSupabase()` to the npm import (see the comment in CONFIG) if you prefer not to load it from the CDN.

Without keys the app runs in demo mode with made-up sample data, so you can try every role safely. In demo mode the sign-in screen is a quick account picker (Patrick, administrator; Aljumer, top management; Jane, accounting; Mae, liaison). Once CONFIG has your Supabase keys, it switches to the username and password form automatically; live accounts are created in Supabase.

## Sign-in page

The sign-in page is deliberately unbranded: no logo, company name or system name, and the browser tab reads "Sign in" until someone signs in. The background is a contour-map pattern drawn by the app itself, so nothing is loaded from outside. The database shares nothing with visitors who have not signed in.

Upgrading from a version that had a company logo: rerunning `supabase_schema.sql` deletes the stored logo and its settings. For the same reason, set the `<title>` of the page you host the app in to something neutral such as "Sign in"; the app changes it after sign-in.

## Roles out of the box

| Role | Can do |
|---|---|
| Administrator | Everything, including users and access rights |
| Top management | Project report, approve or reject, set allocations, verify paid lines |
| Accounting | Project report, mark disbursed, verify paid lines |
| Liaison | New request, own request list, ERP reference, mark paid |
| Auditor (read only) | Project report, project listing, all requests |

Change any of this in **Settings → Access rights**. The database checks the same permissions, so hiding a tab also blocks the action.

## Reclassifying funds filed under FOR-ASSIGNMENT or ADVANCES

When the specific projects are identified later, open the request and click **Reclassify** on the line (shown once the fund is disbursed). Add each project and its amount; anything not assigned stays on the internal project, and the split can be edited or removed later. Project usage and the report follow the split, the original line stays exactly as approved and paid, and every change is logged in the request history. By default top management and accounting can do this (**Settings → Access rights → Reclassify lines from internal projects**). Record the matching reclass in Acumatica separately.

## Analysis

The **Analysis** tab (top management and accounting by default; **Access rights → Analysis**) has two analyses, each with a target of 7 days that can be changed on the page:

- **Request to disbursement**: days from the request date to the disbursement date, split into approval (top management), ERP reference (liaison) and disbursement (accounting), with the slowest step highlighted, a table per liaison, and requests not yet disbursed showing which step they are waiting on.
- **Disbursed to paid**: days from disbursement to the date each line was given to the client, with a table per liaison and the funds not yet given, oldest first.

**Expenses** shows which categories and expense types carry the most amount: totals by category, a ranking of expense types with share and running total (types making up 80% of the amount are highlighted), a monthly trend by category, and the top projects for any type you click. Filter by request date, project, and amount basis (approved to date, released, or including requests still for approval).

## Supporting documents

By default the **Collection** category requires a supporting document (DE share, construction share, royalty). To change which categories do, go to **Settings → Expense categories and types**, edit a category and tick or untick **Require a supporting document**. Every request line in a required category needs at least one attached file (PDF, JPG, PNG or WebP, up to 10 MB each) before the request can be submitted, and top management can open the files from Approvals or the request details. Lines in other categories (Support included) can still carry optional files: use the paperclip next to the line. Rerunning `supabase_schema.sql` applies the Collection default only once, so a later change you make in Settings is kept.

Running `supabase_schema.sql` creates the private Storage bucket `oe-documents` and its access rules for you; nothing to set up by hand. Files are never public: the app opens them through short-lived signed links, and only the uploader and people who can see the request (top management, accounting, administrators) can read them. Another liaison cannot.

While a request is still **For approval**, the liaison who filed it (or an administrator) can open it and use **Attach more** on any line to add files, for example when top management asks for another document, or remove a file they attached. A line in a required category always keeps at least one file, and every addition or removal is recorded in the request history. Once the request is approved or rejected, its documents are locked.

## Editing or cancelling a request that is for approval

While a request is **For approval**, or **Open** (approved but not yet disbursed, with or without the ERP reference), the liaison who filed it (or an administrator) sees **Withdraw** in the request details. It offers two choices:

- **Edit request** opens the request in the New request form with everything filled in. Amounts, lines, dates, the description and documents can be changed, lines added or removed. Saving keeps the same reference number, the request stays in the approval queue, and the history records the change (for example "total 78,000.00 → 75,500.00"). The same checks as filing apply, and the edit is refused if top management approved or rejected the request in the meantime.
  Editing an approved request sends it **back to For approval**: the previous approval and any ERP reference are cleared (the amounts may have changed), top management approves it again, and the liaison re-enters the ERP reference afterwards. Lines where top management had approved a different amount show "Previously approved" while editing.
- **Cancel request** withdraws it for good (with an optional reason); it moves to Rejected / withdrawn. If an ERP reference was already entered, void that cash advance in Acumatica.

Once a request is disbursed, it can no longer be edited or withdrawn.

## Export to Excel (Project report)

**Export to Excel** on the Project report creates a workbook with three sheets, following the filters set on the page:

- **Records**: every request line on the projects in the report, with a "Counts as" column (Approved to date, In approval, Not counted) and the amount it adds.
- **Summary**: the report as on screen, with the five totals at the top and, per project, approved to date, in approval, allocation and share used for each expense category, then the totals. Amber marks usage from the "near limit" level, red once over.
- **By expense type**: the same comparison for each expense type on each project, with filters; its total row follows the filter.

The Summary and By expense type amounts are Excel formulas that add up the Records sheet, so any figure can be traced back to its lines.

The Excel library (ExcelJS 4.4.0, about 1 MB) is loaded from cdn.jsdelivr.net only when someone exports, with an integrity check so the browser refuses a file that differs from that exact release. If your network blocks that site, host `exceljs.min.js` yourself and point `CONFIG.excelJsUrl` at it (keep `excelJsIntegrity` if it is the same file, or set it to an empty string).

## Paying the client and fund returns

Every disbursed line tracks three amounts: **paid to the client**, **returned**, and what is **still with the liaison**.

**Mark as paid (liaison).** Select the lines, then **Mark paid…**. Each line's amount is prefilled with everything still with the liaison; lower it if less was given. A line paid in full becomes **Paid**. A line paid in part becomes **Partly paid**, and the rest can only be settled by accounting recording its return (the liaison can't pay it later). A line is marked paid once.

**Return fund (accounting, top management, administrators).** Available on Disbursed and Partly paid lines, including on a Partially paid request. The amount is prefilled with everything still with the liaison (a full return); lower it for a partial return. Each return records the date, the receipt or reference number and the reason, and a line can have several partial returns, all listed on the line.

How a line ends up:

- Everything given to the client: **Paid**, then verified and closed as usual.
- Part given, the rest returned: **Paid** once the last peso is returned, then verified and closed. A Partly paid line can't be verified until then.
- Everything returned: **Returned**. If every line on a request comes back, the request is **Returned** (its own card on the Request list).

On the Project report and in the Excel export, only returned money is removed, like a rejected line. Money given to the client, and money still with the liaison, keeps counting until it is returned. "Needs my action" shows accounting the returns waiting to be recorded.

Safeguards, all enforced in the database:

- Only accounting, top management and administrators can record a return, checked by role as well as by permission (the Settings checkbox is locked for other roles). Someone who filed the request can't record its return, except an administrator (who may also approve their own requests); every return is logged with who recorded it.
- Amounts can't exceed what is still with the liaison, can't be zero, and a line can't be paid twice. Paid plus returned can never exceed the approved amount.
- Dates can't be in the future or before the disbursement; a return needs a receipt number and a reason.
- On a FOR-ASSIGNMENT line, a return can't cut into money already reclassified to projects, and a split can't exceed what is left after returns.
- A return is final (no undo). Returned and fully paid lines can't be paid, returned or reclassified again.
- Request records can't be edited directly through the database API; every change goes through the checked workflow functions.
