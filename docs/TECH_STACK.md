# Project Expense Monitoring: Tech Stack

This is a React single-page app with Supabase as the whole backend, hosted on Vercel and installable as a phone app (PWA). It uses plain JavaScript, not TypeScript, on the front end.

## Front end

| Layer | Technology |
|---|---|
| UI framework | **React 19** (`react`, `react-dom`), written as JSX |
| Build tool / dev server | **Vite 8** with `@vitejs/plugin-react` |
| Installable app | **vite-plugin-pwa**, which uses Workbox for the service worker. It can be installed on Android and iOS, and `public/sw-push.js` handles push notifications |
| Styling | Mostly inline React `style={{...}}` objects. There's no Tailwind or CSS framework |
| Font | **Poppins**, bundled with the app through `@fontsource/poppins` |
| State | Built-in React hooks (`useState`, `createContext`). There's no Redux or Zustand |
| Routing | Hand-written routing, not React Router. `vercel.json` rewrites paths like `/approvals` and `/projects` to `index.html` |
| Excel export | **ExcelJS 4.4.0**, loaded from the jsDelivr CDN when needed |
| Bot protection | **Cloudflare Turnstile** captcha on sign-in |

The code is very concentrated: `src/App.jsx` alone is about 10,600 lines. Besides it, `src/` only has a few small helpers (`main.jsx`, `env.js`, `nav-order.js`, `push-device.js`, `approvals-queue.js`).

## Backend: Supabase (backend-as-a-service)

- **Database:** PostgreSQL 17, managed through SQL migrations in `supabase/migrations/`.
- **Auth:** Supabase Auth handles sign-in, invites, forgot/reset password, and roles (admin, liaison and others).
- **Data access:** `@supabase/supabase-js` v2, with database functions called by RPC, Realtime channels and Storage.
- **Edge Functions:** written in TypeScript and run on Deno:
  - `oe-invite-user`: sends user invites
  - `oe-push`: sends Web Push notifications
  - `oe-delete-user`: deletes a user
  - `_shared/`: helpers the three functions share (web push, next approval step, push targets)

## Hosting and infrastructure

- **Vercel** hosts the site (`vercel.json` uses the Vite framework preset).
- **Vercel Edge Middleware** (`middleware.js`, using `@vercel/edge`) rate-limits each IP, blocks scanner tools and refuses request methods the app never uses.
- Strict security headers are set in `vercel.json`, including CSP, HSTS and X-Frame-Options.
- Push notifications use the **Web Push / VAPID** standard (the `web-push` library).

## Tooling and tests

- **Node.js 20 or newer**, with npm scripts in `scripts/` for creating starter accounts, generating icons and VAPID keys, and running self-tests.
- **Playwright** (`playwright-core`) and **jsdom** for the smoke and mobile tests.
- **@resvg/resvg-js** turns SVG into the PNG app icons.

## In short

React 19 + Vite on the front end, Supabase (Postgres, Auth, Realtime, Storage, Edge Functions) on the back end, and Vercel for hosting.
