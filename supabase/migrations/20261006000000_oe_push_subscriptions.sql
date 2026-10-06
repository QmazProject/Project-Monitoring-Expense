-- Push notification subscriptions: one row per browser or installed app in which a person allowed notifications.
-- The signed-in person writes their own rows from the app; the oe-push edge function reads them with the service role
-- to send "a request needs your approval" (approvers) and "your request was approved / rejected" (liaison).

create table if not exists oe_push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references oe_profiles(id) on delete cascade,
  endpoint     text not null unique,       -- the push service address for this browser; unique per device + browser
  p256dh       text not null,              -- the browser's public key (base64url)
  auth         text not null,              -- the browser's auth secret (base64url)
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists oe_push_subscriptions_user on oe_push_subscriptions(user_id);

alter table oe_push_subscriptions enable row level security;
drop policy if exists oe_push_subscriptions_own on oe_push_subscriptions;
create policy oe_push_subscriptions_own on oe_push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, update, delete on oe_push_subscriptions to authenticated;
