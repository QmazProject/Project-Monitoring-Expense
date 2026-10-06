# Project Expense Monitoring: setup

Three pieces: the database (`supabase_schema.sql`), one edge function for inviting users (`supabase/functions/oe-invite-user`), and the app (`ExpenseMonitoring.jsx`). All tables are prefixed `oe_`, so the system can live in its own Supabase project or share one with another system.

## 1. Database

1. In Supabase, open **SQL Editor**, paste all of `supabase_schema.sql`, and run it. It is safe to run again later; existing rows are kept.
2. It creates the tables, row level security, the workflow functions, the roles and access rights, the expense categories and types, the SOP district rates, and the 44 projects from the Project Listing sheet (plus two internal buckets, ADVANCES and FOR-ASSIGNMENT).
3. Already ran an earlier version? Run the updated file again. It adds what's new, removes what's retired, and keeps your existing requests and settings.

## 2. Sign-in settings

1. **Authentication → Sign In / Providers**: turn off *Allow new users to sign up*. People only get in by invite.
2. **Authentication → URL Configuration**: set *Site URL* to the app's address and add `https://<the app's address>/**` under *Redirect URLs*. Invite links return to `/invite/set-password`, the page where the person chooses their password.

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

### Invite email design

The default Supabase invite email is plain text. A branded version lives in `supabase/templates/invite.html` (greeting by name, email and role, a *Set my password* button, expiry note). Apply it one of two ways:

- `supabase config push` from the folder that contains `supabase/` (the template is wired in `config.toml` under `[auth.email.template.invite]`; the push also sends the Site URL and Redirect URLs written there, so keep them at the deployed address), or
- Dashboard → **Authentication → Emails → Templates → Invite user**: paste the file's contents into the body and set the subject to *You're invited to Project Expense Monitoring*.

The role shown in the email comes from the invite function (`role_label` in the user's metadata), so redeploy the function after pulling this change. To change the sender name and address, set up custom SMTP (Authentication → Emails → SMTP Settings).

### Invite status in Settings → Users

Each row shows *Pending* (invited, hasn't set a password yet) or *Accepted* (password set). This needs migration `20261003000000_oe_invite_status.sql` (`supabase db push`), which also fills in the status for invites sent earlier.

The same stamp protects the invite: a person whose invite is still *Pending* can only ever reach the *Set your password* page, however they arrive (the email button, the plain link, a second click, a saved session, or typing the address). Opening an invite link a second time shows the sign-in page with "That link was already used or has expired".

The set-password tab keeps its session in memory only. It never writes to the browser's saved sign-in, so an administrator who is signed in on the same computer stays signed in while an invite is accepted there. When the password is confirmed, the tab reloads as the normal sign-in page with the person's email filled in.

## 5. App

1. Open `ExpenseMonitoring.jsx` and fill `CONFIG` at the top with the project URL and **anon** key (Project Settings → API). Never use the service_role key in the app.
   Optional: set `usernameDomain` to your company email domain (for example `example.com.ph`). People can then sign in with just their username, the part of their email before @. A full email address always works too.
2. Host it like any React app, for example with Vite on Vercel:
   - `npm create vite@latest oe-expenses -- --template react`
   - replace `src/App.jsx` with `ExpenseMonitoring.jsx` (it has `export default App`)
   - `npm run build` and deploy.
3. Optional: `npm i @supabase/supabase-js` and switch `loadSupabase()` to the npm import (see the comment in CONFIG) if you prefer not to load it from the CDN.

Without keys the app runs in demo mode with made-up sample data, so you can try every role safely. In demo mode the sign-in screen is a quick account picker (Patrick, administrator; Aljumer, top management; Jane, accounting; Mae, liaison). Once CONFIG has your Supabase keys, it switches to the username and password form automatically; live accounts are created in Supabase.

## 6. Push notifications

Approvers are told on their phone, tablet or PC when a request is filed, and liaisons when theirs is approved or rejected, even with the app closed, as long as the device has internet. This uses Web Push: the browser subscribes with the push service of its maker (Google, Apple, Mozilla), the subscription is stored in `oe_push_subscriptions`, and the `oe-push` function sends the message.

1. Run the migration: `npm run db:push` (creates `oe_push_subscriptions`).
2. Make the key pair once: `npm run push:keys`. It prints two things:
   - `VITE_VAPID_PUBLIC_KEY=…` → add to `.env` locally and to the Vercel environment variables, then redeploy.
   - `supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:…` → run it with a real contact address (push services use it to reach you about problems).
3. Deploy the function: `npm run functions:deploy` (deploys `oe-invite-user` and `oe-push`).
4. Check the crypto on your machine any time with `npm run push:selftest`.

What people see: after signing in, a bar offers **Turn on notifications** (approvers are told it is needed). The browser asks for permission once; a test notification follows at once. Each browser and device subscribes separately, so a person can have several. **Not now** hides the bar for that sign-in. If notifications are blocked in the browser, the bar says where to allow them. Signing out removes that device's subscription.

- **Android and desktop (Chrome, Edge, Firefox):** work in the browser and in the installed app.
- **iPhone and iPad:** notifications work only in the app added to the Home Screen (iOS 16.4 or later); the bar explains this in Safari.
- **Badge:** the "Needs my action" count shows on the installed app's icon, in the tab title, and as a red counter on the favicon.
- **What is sent:** the reference number, who filed it and the amount; nothing more. The notification opens Approvals or the Request list.
- **Camera:** attaching a document from the phone camera works through the file picker; no camera permission is asked for.

### What to expect on a desktop

A notification goes to every browser a person turned notifications on in, not to the person in general, so these cases differ:

- **Another tab open, or the app tab idle:** works. The notification comes from the browser's service worker, not from the open page. The 30-minute idle sign-out keeps the device registered; the notification then opens the sign-in page and, after signing in, the right page. Only an explicit **Sign out** removes the device (so a shared computer stops showing them).
- **Another browser** (Chrome, Edge, Firefox, Safari are separate): each one must sign in once and press **Turn on notifications**. Check what is registered with `supabase db query --linked "select p.role, s.user_agent, s.last_seen_at from oe_push_subscriptions s join oe_profiles p on p.id = s.user_id"`.
- **No browser window open:** works only while the browser is still running in the background. On Windows, Chrome and Edge do this by default (Settings → System → *Continue running background apps when the browser is closed*); on macOS the browser must be running, even with no window. If it isn't, the push service holds the message for 24 hours and delivers it when the browser next starts. Safari on macOS 13 or later delivers through the Notification Center even when closed.
- **Nothing appears although it is allowed:** Windows Settings → System → Notifications (the browser must be on, and Focus assist off), macOS System Settings → Notifications → the browser, and the browser's own site settings for the app's address.

Without `VITE_VAPID_PUBLIC_KEY` the bar is never shown and the app works as before.

## Sign-in page

The sign-in page is deliberately unbranded: no logo, company name or system name, and the browser tab reads "Sign in" until someone signs in. The background is a contour-map pattern drawn by the app itself, so nothing is loaded from outside. The database shares nothing with visitors who have not signed in.

Upgrading from a version that had a company logo: rerunning `supabase_schema.sql` deletes the stored logo and its settings. For the same reason, set the `<title>` of the page you host the app in to something neutral such as "Sign in"; the app changes it after sign-in.

## Page addresses

| Address | Screen |
|---|---|
| `/sign-in` | Sign-in page |
| `/invite/set-password` | Set your password (invite links) |
| `/project-report` | Project report, the first screen after signing in |
| `/new-request` | New request |
| `/approvals` | Approvals |
| `/requests` | Request list |
| `/analysis` | Analysis |
| `/projects` | Project listing |
| `/settings` | Settings |

After signing in, the app opens the first module the person's role can see (Project report for most roles). Opening a module's address while signed out shows the sign-in page, then that module once signed in. An address the role can't open, or one that doesn't exist, falls back to the first module. The browser's Back and Forward buttons move between modules, and Back never returns to the sign-in page. Each address is listed under `rewrites` in `vercel.json`; a new module needs its address added there too.

## Phones, tablets and the installed app

The same build works on three screen sizes; nothing changes for desktops (961px and wider).

- **Phones (up to 767px):** the side panel becomes a slide-out menu from the ☰ button. Wide tables (Project report, Project listing, Request list, Approvals lines, request details lines) show as stacked cards with the column name beside each value; other tables keep their first column pinned while scrolling sideways. Filters fold behind a *Filters and search* bar, the Request list shows three status cards until *All statuses* is tapped, each request line in New request has labelled fields with the total and Submit in a bar at the bottom, Approve and Reject stay at the bottom of the screen, Access rights shows one role at a time (chosen from a list), and fields are 16px so iPhones don't zoom in. Hovering details (the allocation meters, status chips) show on tap.
- **Tablets (768 to 960px):** the side panel is always the icon strip, so the page gets the width.
- **Installed app (PWA):** on Android phones and tablets, an *Install app* button appears next to Sign out in the side panel when the browser allows installing. Desktops don't get the button, because Chrome and Edge already show an install icon in the address bar. On iPhone and iPad, Safari users tap Share, then *Add to Home Screen*; the app shows that hint once. The installed app opens full screen with the green logo (`public/favicon.svg`, rendered to `public/icons/` by `npm run icons`). The service worker caches only the app's own files, never project or request data; offline, it opens and says *You're offline*. After a deploy, an open app shows *A new version is ready, Reload*. Invite emails still open in the browser; sign in from the installed app afterwards.

`npm run test:mobile` builds the demo and walks the key screens at 360px, 390px, 800px and 1280px in a headless Chromium, checking the stacked tables, field sizes, reachable buttons and that the desktop layout is unchanged. It needs a Chromium: `npx playwright install chromium`, or set `OE_CHROME` to the browser's path.

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
- A return is final (no undo). Returned and fully paid lines can't be paid or returned again. A split from an internal project can still be edited afterwards, as described under Reclassifying.
- Request records can't be edited directly through the database API; every change goes through the checked workflow functions.
