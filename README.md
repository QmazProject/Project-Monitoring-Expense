# Project Expense Monitoring

React + Vite front end, Supabase (Postgres, Auth, Storage, Edge Functions) back end, deployed on Vercel.
The whole user interface lives in `src/App.jsx` (the original `ExpenseMonitoring.jsx`, unchanged in look and
behaviour). It carries its own CSS, so no Tailwind or other UI library is needed.

Two ways in, both on the same sign-in page:

- **Live**: username (or email) and password. Accounts are created by the developer (see Phase 2). There is
  no public sign-up; anonymous visitors can read nothing.
- **Demo**: a one-click account picker with sample data that lives only in the browser and resets on reload.
  Hide it on production with `VITE_DEMO_ENABLED=false`.

## Folder map

| Path | What it is |
|---|---|
| `src/App.jsx` | The application (all pages, workflow, demo API, Supabase API, styles) |
| `src/env.js` | Copies `VITE_*` values from `.env` into the app's CONFIG |
| `src/main.jsx`, `index.html` | Vite entry point (tab title stays "Sign in" until someone signs in) |
| `supabase/migrations/20260928000000_oe_schema.sql` | Full schema: tables, RLS, workflow functions, seeds (idempotent) |
| `supabase/migrations/20260928000001_oe_bootstrap_accounts.sql` | Developer-only functions to create the first accounts, plus extra grants hardening |
| `supabase/migrations/20260928000002_oe_live_starts_empty.sql` | Removes the sample projects once so live starts empty |
| `supabase/migrations/20260929000000_oe_acumatica_and_role_guards.sql` | Acumatica items table and mapping column, database-side role guards |
| `supabase/bootstrap_accounts.sql` | Template you run once in the SQL Editor to create admin / top management / accounting / liaison |
| `supabase/functions/oe-invite-user/` | Edge Function used by Settings → Users to invite people (checks the caller's permission in the database) |
| `scripts/bootstrap-users.mjs` | Terminal alternative to the SQL template, using the Auth admin API |
| `vercel.json` | Security headers (CSP, HSTS, no framing, no indexing) and asset caching |
| `middleware.js` | Vercel Edge Middleware: method allow-list, scanner block, per-IP rate limit |
| `docs/` | The original files: `ExpenseMonitoring.jsx`, `supabase_schema.sql`, `SETUP.md` (functional manual), the PDF manual; `upstream-2026-09-29/` holds the later app version that was merged in |

## Roles and modules

Every page is gated by a permission; the database checks the same permission again inside each workflow
function, so hiding a tab also blocks the action. Defaults (change them in **Settings → Access rights**):

| Role (`role` value) | Modules | Workflow actions |
|---|---|---|
| Administrator (`admin`) | Everything | Everything, including Users, Access rights, Expense setup, System settings |
| Top management (`tm`) | Project report, Approvals, Request list (all), Analysis, Project listing | Approve / reject, set allocations, verify paid lines (TM side), reclassify, record fund returns |
| Accounting (`accounting`) | Project report, Request list (all), Analysis, Project listing | Mark disbursed, verify paid lines (accounting side), reclassify, record fund returns |
| Liaison (`liaison`) | New request, Request list (own) | File / edit / withdraw requests, enter ERP reference, attach documents, mark lines paid |
| Auditor (`viewer`) | Project report, Project listing, Request list (all) | Read only |

Request lifecycle: For approval → Open (approved) → Disbursed → Paid / Partly paid → Closed, with Rejected,
Withdrawn, Returned and Reclassified as side exits. `docs/SETUP.md` explains each step in detail.

## Phase checklist

### Phase 0. Project framework (done)
- [x] Vite + React project around the untouched UI (`src/App.jsx`)
- [x] supabase-js bundled from npm instead of a CDN
- [x] Demo and live modes side by side on the sign-in page
- [x] Config from `.env` (`VITE_*`), `.env.example` documented
- [x] Schema turned into `supabase/migrations` for `supabase db push`
- [x] Developer bootstrap for the first accounts (SQL template + Node script)
- [x] `oe-invite-user` Edge Function (was referenced by the app but missing)
- [x] Vercel security headers, edge middleware, sign-ups disabled in Supabase config
- [x] Captcha (Cloudflare Turnstile) wired but off until a site key is set
- [x] Forgot-password removed from the sign-in page; resets are done by the administrator in SQL
- [x] Live starts with an empty project listing (migration 0002)
- [x] 2026-09-29 upstream update merged: Acumatica items and per-type mapping, Particulars columns, new printed form layout, admin-only administrator access, own-role rights lock (migration 20260929000000 + invite function redeploy)

### Phase 1. Supabase project
1. Create a project at supabase.com (or use an existing one; every object is prefixed `oe_`).
2. Link and push the database:
   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```
3. Deploy the invite function (it uses the project's built-in secrets, nothing to configure):
   ```bash
   supabase functions deploy oe-invite-user
   ```
4. Dashboard → **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
   (`supabase/config.toml` already has `enable_signup = false`; `supabase config push` applies it to the hosted project too.)
5. Dashboard → **Authentication → URL Configuration**: Site URL = your Vercel address; under Redirect URLs add
   `https://<your app>.vercel.app/**` (invite links return to `/invite/set-password`, the set-password page).
6. Invite email design: `supabase/templates/invite.html` is a branded template (name, email, role, "Set my password"
   button). Apply it with `supabase config push` (it reads `[auth.email.template.invite]` in `supabase/config.toml`),
   or paste its contents into Dashboard → **Authentication → Emails → Templates → Invite user** and set the subject to
   "You're invited to Project Expense Monitoring". The sender name ("Supabase Auth") only changes with custom SMTP
   (see Later, below).

   **Careful:** `supabase config push` sends the whole `[auth]` section, including Site URL and Redirect URLs, so
   `config.toml` carries the deployed address (`https://project-monitoring-expense.vercel.app`, with `/**` in the
   redirect list because invites return to `/invite/set-password`). If the app moves, change it there first. After
   any push, check Dashboard → Authentication → URL Configuration still shows the Vercel address.

### Phase 2. First accounts (developer)
Pick one:

- **SQL Editor**: open `supabase/bootstrap_accounts.sql`, replace the emails, names and passwords, paste it into
  Supabase → SQL Editor and run. Each `oe_create_login(...)` line creates a confirmed sign-in and its role.
  Do not commit real passwords.
- **Dashboard + SQL**: Authentication → Users → Add user (tick *Auto confirm*), then in SQL Editor:
  `select oe_bootstrap_profile('email', 'Full name', 'role');`
- **Terminal**: put `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`, copy
  `scripts/bootstrap-users.example.json` to `scripts/bootstrap-users.json`, edit it, run `npm run bootstrap:users`.

Roles: `admin`, `tm`, `accounting`, `liaison`, `viewer`. After that, everyone else is invited from
**Settings → Users** inside the app (administrator only). The Users list shows each invite's status: *Pending*
until the person sets a password, then *Accepted*. The invited person gets an email link that
opens the app at `/invite/set-password`, a *Set your password* page showing their name, email and role. They type and retype
a password, press *Confirm password*, and are returned to the sign-in page (email prefilled) to sign in
with it.

### Phase 3. Run locally
```bash
cp .env.example .env      # fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev               # http://localhost:5173
```
Leave the two keys empty and the app runs in demo mode only.

`npm run test:smoke` builds the app and walks the demo sign-in flow headlessly (jsdom) as a quick regression check.

### Phase 4. GitHub
```bash
git remote add origin https://github.com/YOUR-ORG/project-expense-monitoring.git
git push -u origin main
```
`.env`, `scripts/bootstrap-users.json` and `dist/` are ignored by git. Never commit the service_role key.

### Phase 5. Vercel
1. Vercel → Add New Project → import the GitHub repository. Framework preset: **Vite** (read from `vercel.json`).
2. Settings → Environment Variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optionally `VITE_USERNAME_DOMAIN`,
   `VITE_DEMO_ENABLED` (`false` to hide the demo on production), later `VITE_TURNSTILE_SITE_KEY`.
3. Deploy. Then put the Vercel URL into Supabase → Authentication → URL Configuration (Phase 1, step 5).

### Phase 6. Protection (now and later)
Already in place:
- **Database**: Row Level Security on every table, no grants for `anon`, all request changes only through checked
  SQL functions, Storage bucket private with signed links, developer-only bootstrap functions not callable via the API.
- **Auth**: sign-ups disabled, invite-only, minimum password length 8, Supabase's built-in per-IP rate limits on
  sign-in and token refresh (Dashboard → Authentication → Rate Limits; tune them there).
- **Edge** (`middleware.js`): only GET/HEAD/OPTIONS reach the site, empty-UA and scanner requests are refused,
  per-IP rate limit on page loads with a 5-minute block. Vercel's platform DDoS mitigation is always on in front of it.
- **Headers** (`vercel.json`): strict Content Security Policy, HSTS, no framing, no indexing, no referrer leaks.

Later:
- **Captcha**: Supabase → Authentication → Attack protection → enable Cloudflare Turnstile with your secret key;
  set `VITE_TURNSTILE_SITE_KEY` in Vercel and redeploy. The sign-in form then shows the widget and sends its token.
- **Vercel Firewall**: Project → Firewall → turn on *Attack Challenge Mode* during an attack, add IP / country rules,
  and (Pro plan) rate-limit rules that are enforced across all edge regions rather than per isolate.
- **Custom SMTP** in Supabase for invites and password resets (the built-in sender is limited to a few emails per hour).

## Where the data lives (Supabase)

Everything the live system stores is in your Supabase project. Nothing is kept in the browser except the
signed-in session. Demo mode never touches Supabase: its sample data is built in memory and resets on reload.

| Table / object | Holds | Written by |
|---|---|---|
| `auth.users` (Supabase Auth) | Sign-ins: email, password hash, confirmation | Developer bootstrap, invite function |
| `oe_profiles` | One row per user: full name, role, active flag | Auth trigger, admin (Settings → Users), bootstrap |
| `oe_role_permissions` | Roles and the permission keys each one has | Admin (Settings → Access rights) |
| `oe_settings` | One row: reference prefix, close policy, near-limit %, idle minutes, form title, upgrade flags | Admin (Settings → System) |
| `oe_projects` | Project listing (code, district, contract value, dates, status, accomplishment) plus the internal buckets ADVANCES and FOR-ASSIGNMENT | Users with *Add and edit projects* |
| `oe_project_allocations` | Per-project overrides of the allocation for an expense type | Users with *Set project allocations* |
| `oe_expense_categories` | Bidding, Collection, Support, Inspection, Testing (and the supporting-document rule) | Settings → Expense categories |
| `oe_expense_types` | Expense types under each category with calc method, rate, fixed allocation, ERP account | Settings → Expense categories |
| `oe_district_rates` | SOP rate overrides per district and expense type | Settings → Expense categories |
| `oe_acumatica_items` | Acumatica INV IDs and descriptions; each expense type maps to one, shown on the printed form | Settings → Acumatica items |
| `oe_counters` | Reference-number sequence per prefix and year | `oe_create_request` only |
| `oe_requests` | Request header: reference no., dates, project, liaison, status, approval / ERP / disbursement stamps | Workflow functions only |
| `oe_request_lines` | Each line: project, expense type, amount, approved amount, paid / returned amounts, line status | Workflow functions only |
| `oe_request_events` | Full history log of every action on a request | Workflow functions only |
| `oe_line_reclass` | Splits of FOR-ASSIGNMENT / ADVANCES lines to real projects | `oe_reclassify_line` |
| `oe_line_returns` | Each fund return: amount, date, receipt no., reason, who recorded it | `oe_return_line` |
| `oe_line_documents` | Metadata of attached files (path, name, size, type) | `oe_create_request`, `oe_add_line_documents` |
| Storage bucket `oe-documents` (private) | The attached PDF / image files, one folder per uploader | Liaison uploads; read through signed links |

Pages map onto these as follows: **Project listing** and **Project report** read `oe_projects`, allocations, types
and the request lines; **New request / Approvals / Request list** read and write requests, lines, events, returns,
reclass and documents through the `oe_*` SQL functions; **Analysis** reads requests, lines and events; **Settings**
edits profiles, roles, settings, categories, types and rates. Row Level Security decides who can read which rows,
and the request tables accept no direct writes from the app at all.

A brand-new live system starts with an empty project listing (the sample projects from the original sheet are
removed by the third migration; the two internal buckets stay), the default categories, types and rates, and no
requests. Add projects in **Project listing → Add project**.

## Role rules enforced in the database

- Nobody can change their own role or access.
- Only an administrator can give, change or remove administrator access, or invite an administrator.
- A non-administrator cannot change the rights of their own role.
- Fund returns are limited to administrators, top management and accounting, by role as well as by permission.
- The invite function refuses an email that already has an account.

## Notes from the 2026-09-29 review

- **Dates** are checked against the company's calendar day. The timezone is stored in Settings data as
  `timezone` (default `Asia/Manila`); change it with `update oe_settings set data = data || '{"timezone": "Asia/Manila"}'`.
- **Approval** is refused if the liaison edited the request (lines or amounts) while the approver had it open.
  The approver reloads and reviews again.
- **User managers**: a role that has *Users, access rights and system settings* is powerful by design. It can
  create roles and put people on them. The database stops such a user, when they are not an administrator, from
  touching administrators, from granting user-management rights to any role, and from inviting people into a
  role that has them. Give this permission only to administrators unless you accept that.
- **Re-running the original schema file** by hand (`docs/supabase_schema.sql`) drops the policies of tables that
  later migrations added. Use `supabase db push`, or re-run the later migrations afterwards.

## Passwords

There is no "Forgot password" on the sign-in page and no self-service reset. When someone forgets their
password, an administrator sets a new one in Supabase → SQL Editor:

```sql
select oe_set_login_password('person@yourcompany.com', 'NewStrongPassword!');
```

(Authentication → Users → *Reset password* in the Supabase dashboard also works.) The set-password screen the
app still has is only reached from an invite link, so invited people can choose their first password.

## Environment variables

| Name | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env`, Vercel | Project URL |
| `VITE_SUPABASE_ANON_KEY` | `.env`, Vercel | anon / publishable key (safe in the browser) |
| `VITE_USERNAME_DOMAIN` | `.env`, Vercel | Optional; lets people type `jane` instead of `jane@company.com` |
| `VITE_DEMO_ENABLED` | `.env`, Vercel | `false` hides "Try the demo" |
| `VITE_TURNSTILE_SITE_KEY` | `.env`, Vercel | Captcha site key (later) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `.env` only | For `npm run bootstrap:users`; never in Vercel, never in git |

## Notes

- **Self-hosted Supabase**: the Content Security Policy in `vercel.json` allows `*.supabase.co`. Add your own
  host to `connect-src`, `img-src` and `frame-src` if the API lives elsewhere.
- **Node**: Vite builds on Node 20.19+ or 22+. supabase-js prints an engine warning on Node 20; it is only a warning.
  Vercel builds with Node 22 by default.
- **Re-running migrations**: both migration files are idempotent; `supabase db push` only applies files it has not
  applied yet. To re-apply the schema on a project that was set up from the old `supabase_schema.sql`, run
  `supabase migration repair` or simply paste the file into the SQL Editor again.
