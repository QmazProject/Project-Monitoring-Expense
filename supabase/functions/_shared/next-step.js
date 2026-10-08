/* What a request is waiting for, and whether it is waiting for YOU.

   This is the one definition of "needs my action" in PEMS. The app draws the side-panel counts and the app
   icon badge from it (src/App.jsx), and the oe-push function works out each recipient's badge number from it
   as well, so a badge that arrives with a notification is the same number the app shows when it is opened.

   It lives in supabase/functions/_shared because that is the only place `supabase functions deploy` bundles;
   the front end imports it from here, Node imports it in scripts/badge-selftest.mjs. Plain JavaScript with no
   imports of its own, so the same file runs in a browser, in Deno and in Node.

   The rule decides, the caller words it: requestStep returns a step name plus the numbers that go in the
   sentence, and App.jsx turns that into the text a person reads. That way the server never needs the app's
   currency formatting, and there is still only one copy of the rule. */

/** Roles that may record money coming back from a liaison. */
export const RETURN_ROLES = ["admin", "tm", "accounting"];

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* Money on a line once approved: paid to the client + returned + still with the liaison. */
export const lineApproved = (l) => Number(l.approved_amount ?? l.amount);
export const lineReturned = (l) => Number(l.returned_amount || 0);
/** What counts in the project report: returned money doesn't. */
export const lineNet = (l) => round2(lineApproved(l) - lineReturned(l));
export const linePaid = (l) => (l.paid_amount != null ? Number(l.paid_amount) : ["paid", "closed"].includes(l.status) ? lineNet(l) : 0);
/** Still in the liaison's hands (to give to the client, or to return). */
export const lineWithLiaison = (l) => (["disbursed", "part_paid"].includes(l.status) ? round2(lineNet(l) - linePaid(l)) : 0);
/** The lines that still count: the ones not declined, rejected, cancelled or returned. */
export const liveLines = (r) => (r.lines || []).filter((l) => !["declined", "rejected", "cancelled", "returned"].includes(l.status));

/** Who may do what. Administrators have every permission, exactly as oe_has_perm() decides it in the database. */
export const makeCan = (role, permissions) => {
  if (role === "admin") return () => true;
  const set = new Set(permissions || []);
  return (p) => set.has(p);
};

/** How much of a closed request's internal-project money has been split to real projects. */
export function reclassState(r, idx) {
  if (!idx) return null;
  const lines = (r.lines || []).filter((l) => ["disbursed", "part_paid", "paid", "closed"].includes(l.status) && (idx.projects.get(l.project_id) || {}).is_internal);
  if (!lines.length) return null;
  const total = lines.reduce((a, l) => a + lineNet(l), 0);
  const assigned = lines.reduce((a, l) => a + (l.reclass || []).reduce((b, x) => b + Number(x.amount), 0), 0);
  const remaining = round2(total - assigned);
  return { total, assigned, remaining, hasSplit: assigned > 0.004, complete: remaining <= 0.004 };
}

/**
 * The step a request is on.
 * @returns {{step: string, mine: boolean, meta: object}} step names the stage, mine is whether this person is
 *          the one who has to act, meta carries the numbers the wording needs.
 */
export function requestStep(r, me, can, idx = null) {
  const own = r.liaison_id === me.id;
  const lines = liveLines(r);
  const toPay = lines.filter((l) => l.status === "disbursed").length;
  const paidish = lines.filter((l) => l.status === "paid" || l.status === "closed").length;
  const needAcct = lines.some((l) => l.status === "paid" && !l.acct_verified_at);
  const needTm = lines.some((l) => l.status === "paid" && !l.tm_verified_at);
  // One verification (default): top management verifies, accounting is only the backup.
  const tmOnly = !idx || idx.closePolicy !== "both";
  const verifyMine = tmOnly ? can("requests.verify_tm") && needTm : (can("requests.verify_acct") && needAcct) || (can("requests.verify_tm") && needTm);
  const meta = { paidish, lineCount: lines.length, toReturn: 0, remaining: 0, tmOnly };

  switch (r.status) {
    case "on_hold": {
      // approvers can't approve their own request, except administrators
      const mine = can("requests.approve") && (!own || me.role === "admin");
      return { step: mine ? "review" : "await_approval", mine, meta };
    }
    case "open":
      if (!r.erp_ref) return { step: "erp", mine: can("requests.erp_ref") && own, meta };
      return { step: "await_disburse", mine: can("requests.disburse"), meta };
    case "disbursed": {
      const payMine = can("requests.pay") && own && toPay > 0;
      // partly paid lines: the rest must come back to accounting
      const toReturn = round2(lines.filter((l) => l.status === "part_paid").reduce((a, l) => a + lineWithLiaison(l), 0));
      meta.toReturn = toReturn;
      const returnMine = toReturn > 0 && can("requests.return") && RETURN_ROLES.includes(me.role) && (!own || me.role === "admin");
      if (payMine) return { step: "pay", mine: true, meta };
      if (returnMine) return { step: "return", mine: true, meta };
      if (verifyMine) return { step: "verify", mine: true, meta };
      if (toPay) return { step: "pay", mine: false, meta };
      if (toReturn > 0) return { step: "await_return", mine: false, meta };
      return { step: "await_verify", mine: false, meta };
    }
    case "paid":
      return { step: "await_verify", mine: verifyMine, meta };
    case "closed": {
      const st = reclassState(r, idx);
      if (!st) return { step: "complete", mine: false, meta };
      meta.remaining = st.remaining;
      if (st.complete) return { step: "reclass_done", mine: false, meta };
      const mine = can("requests.reclassify");
      if (!st.hasSplit) return { step: "reclass_todo", mine, meta };
      return { step: "reclass_partial", mine, meta };
    }
    default:
      return { step: "none", mine: false, meta };
  }
}

/** Whether this one request is waiting for this person. */
export const needsAction = (r, me, can, idx = null) => requestStep(r, me, can, idx).mine;

/** How many of these requests are waiting for this person -- the number on the app icon badge. */
export function countNeedsAction(requests, me, can, idx = null) {
  let n = 0;
  for (const r of requests || []) if (needsAction(r, me, can, idx)) n++;
  return n;
}

/** What a person can see, mirroring the oe_requests read policy: everything if their role may see or approve
 *  every request, otherwise only the ones they filed. The badge must count what they can actually see. */
export const visibleToUser = (requests, me, can) =>
  can("requests.view_all") || can("requests.approve") ? requests || [] : (requests || []).filter((r) => r.liaison_id === me.id);
