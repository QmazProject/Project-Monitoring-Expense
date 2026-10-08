-- The two things the database advisor is right about. Nothing here changes what a function does -- only
-- whether its search path can be moved, and who is allowed to start it.

-- 1. oe_touch_updated_at ran with whatever search_path the caller happened to have. It is a trigger function
--    fired while someone writes a row, so pinning the search path removes any chance of the names inside it
--    resolving somewhere unexpected. The body is byte-for-byte the one from 20260928000000; only the
--    "set search_path" is added, and the triggers that call it by name are unaffected.
create or replace function oe_touch_updated_at() returns trigger
language plpgsql set search_path = public as $$ begin new.updated_at := now(); return new; end $$;

-- 2. oe_prune_push_subscriptions could be called by anyone, signed in or not.
--
--    20261007000003 revoked it "from public", which removes the grant held by the PUBLIC pseudo-role but NOT
--    the ones Supabase's default privileges hand to anon and authenticated for every new function in this
--    schema. So POST /rest/v1/rpc/oe_prune_push_subscriptions answered 200 for an anonymous caller, and a
--    caller could pass somebody else's user id and delete that person's device rows (only ones unseen for the
--    30-day floor, and the browser re-subscribes the next time it opens the app -- but it was not theirs to
--    delete). Compare oe_withdraw_request, which has always answered "permission denied" to anon.
--
--    Only the oe-push function calls this, and it uses the service role. Revoked the way section 6 of
--    20260928000000 revokes the workflow functions: from public AND anon AND authenticated, by name.
revoke execute on function public.oe_prune_push_subscriptions(uuid, integer) from public, anon, authenticated;
grant  execute on function public.oe_prune_push_subscriptions(uuid, integer) to service_role;

-- Left alone on purpose, and why -- so nobody "fixes" them later and breaks the system:
--
-- * The 23 other SECURITY DEFINER functions the advisor lists for `authenticated` are the security model, not
--   a hole in it: requests change only through these functions, which check the caller's role, the request's
--   status and its ownership themselves (oe_require / oe_has_perm) before touching a row. Signed-in users are
--   meant to be able to call them; direct table writes are what section 6 revokes.
-- * oe_public_settings() is callable by anon by design: the sign-in page has to know whether to offer the
--   demo before anyone has signed in. It returns one boolean and reads nothing else.
-- * oe_usage_summary() has no internal role check by design: the New Request form needs allocation usage to
--   show the balance after a line, and api.loadAll calls it for every role. Adding a report.view check would
--   stop liaisons being able to sign in.
