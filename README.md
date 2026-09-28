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
| `supabase/bootstrap_accounts.sql` | Template you run once in the SQL Editor to create admin / top management / accounting / liaison |
| `supabase/functions/oe-invite-user/` | Edge Function used by Settings → Users to invite people (checks the caller's permission in the database) |
| `scripts/bootstrap-users.mjs` | Terminal alternative to the SQL template, using the Auth admin API |
| `vercel.json` | Security headers (CSP, HSTS, no framing, no indexing) and asset caching |
| `middleware.js` | Vercel Edge Middleware: method allow-list, scanner block, per-IP rate limit |
| `docs/` | The original files: `ExpenseMonitoring.jsx`, `supabase_schema.sql`, `SETUP.md` (functional manual), the PDF manual |

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
5. Dashboard → **Authentication → URL Configuration**: Site URL = your Vercel address; add it under Redirect URLs
   (invite and password-reset links return there).

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
**Settings → Users** inside the app (administrator only).

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
