-- A stable name for each browser in oe_push_subscriptions.
--
-- The push address (endpoint) is not a stable identifier: the same browser is given a new one whenever it
-- re-subscribes -- a new VAPID key pair, a save that failed and was retried, or the push service rotating the
-- address. With the address as the only unique key, every rotation inserted another row and left the old one
-- behind, so one PC could appear as three devices. Worse, a push service may keep answering 201 for an address
-- whose subscription is gone, so a test send looked delivered when the device that asked got nothing.
--
-- device_id is made once per browser and kept in that browser's localStorage, so (user_id, device_id) names the
-- device for as long as it keeps its storage. Several devices per person stay fully supported: one row each.

alter table oe_push_subscriptions add column if not exists device_id text;
comment on column oe_push_subscriptions.device_id is
  'Stable id for the browser or installed app this row belongs to (made in the browser, kept in its localStorage). Null for rows saved before this column existed; they are adopted the next time that browser saves its subscription.';

-- The arbiter for the app's upsert (on_conflict=user_id,device_id). Not a partial index: Postgres cannot infer
-- one from an ON CONFLICT clause that has no matching WHERE. Rows left over from before this column exists carry
-- device_id null, and nulls do not collide in a unique index, so they stay as they are and keep working.
create unique index if not exists oe_push_subscriptions_user_device
  on oe_push_subscriptions(user_id, device_id);

-- The address stays unique on its own. That is what tells the app a subscription now belongs to someone else
-- (the save fails, and the browser starts a fresh subscription), so it is deliberately left in place.

-- Forgetting devices nobody has used for a long time. last_seen_at is written every time a browser saves its
-- subscription, which happens on every sign-in, so an active device is refreshed constantly. A device that has
-- not been seen for 90 days is dropped; the next time that browser opens the app it subscribes again.
-- Runs for the signed-in person only (oe-push calls it after a device test), so it can never reach another
-- account's devices.
create or replace function public.oe_prune_push_subscriptions(p_user_id uuid, p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_user_id is null or coalesce(p_days, 0) < 30 then
    return 0; -- never prune everyone at once, and never with a window short enough to drop a live device
  end if;
  with gone as (
    delete from oe_push_subscriptions
     where user_id = p_user_id
       and last_seen_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*) into n from gone;
  return n;
end;
$$;
revoke all on function public.oe_prune_push_subscriptions(uuid, integer) from public;
grant execute on function public.oe_prune_push_subscriptions(uuid, integer) to service_role;
