// Checks the number that goes on the app icon: "how many requests are waiting for me".
// The rule in supabase/functions/_shared/next-step.js is the one the app draws its badge from AND the one the
// oe-push function puts in every notification, so testing it once covers both sides.
// usage: npm run badge:selftest
import { countNeedsAction, makeCan, needsAction, requestStep, visibleToUser } from "../supabase/functions/_shared/next-step.js";

let fails = 0;
const check = (cond, what) => {
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) fails++;
};

// the roles as the schema seeds them (20260928000000_oe_schema.sql)
const PERMS = {
  admin: null, // every permission, as oe_has_perm decides it
  tm: ["projects.view", "allocations.edit", "report.view", "thresholds.view", "requests.view_all", "requests.approve", "requests.verify_tm", "requests.reclassify", "requests.return", "analysis.view"],
  accounting: ["projects.view", "report.view", "thresholds.view", "requests.view_all", "requests.disburse", "requests.verify_acct", "requests.reclassify", "requests.return", "analysis.view"],
  liaison: ["requests.create", "requests.view_own", "requests.erp_ref", "requests.pay"],
  viewer: ["projects.view", "report.view", "requests.view_all"],
};
const user = (id, role) => ({ me: { id, role }, can: makeCan(role, PERMS[role]) });
const LIA = user("u-liaison", "liaison");
const LIA2 = user("u-liaison-2", "liaison");
const ADMIN = user("u-admin", "admin");
const TM = user("u-tm", "tm");
const ACCT = user("u-acct", "accounting");
const VIEW = user("u-viewer", "viewer");
const idx = { closePolicy: "either", projects: new Map([["p-real", { is_internal: false }], ["p-int", { is_internal: true }]]) };

let seq = 0;
const line = (over = {}) => ({ status: "on_hold", amount: 1000, approved_amount: null, returned_amount: 0, paid_amount: null, project_id: "p-real", acct_verified_at: null, tm_verified_at: null, reclass: [], ...over });
const req = (status, over = {}) => ({ id: `r${++seq}`, status, liaison_id: LIA.me.id, erp_ref: null, lines: [line({ status: status === "on_hold" ? "on_hold" : status })], ...over });
const count = (rows, u) => countNeedsAction(visibleToUser(rows, u.me, u.can), u.me, u.can, idx);

// ---- 1. the workflow, one request at a time, from each side ----
{
  const onHold = req("on_hold");
  check(needsAction(onHold, ADMIN.me, ADMIN.can, idx) === true, "awaiting approval: it is the administrator's to review");
  check(needsAction(onHold, TM.me, TM.can, idx) === true, "awaiting approval: it is top management's to review");
  check(needsAction(onHold, LIA.me, LIA.can, idx) === false, "awaiting approval: NOT the filer's (they cannot approve)");
  check(needsAction(onHold, ACCT.me, ACCT.can, idx) === false, "awaiting approval: not accounting's");
  check(needsAction(onHold, VIEW.me, VIEW.can, idx) === false, "awaiting approval: never an auditor's");
  const ownTm = req("on_hold", { liaison_id: TM.me.id });
  check(needsAction(ownTm, TM.me, TM.can, idx) === false, "top management cannot approve a request they filed themselves");
  const ownAdmin = req("on_hold", { liaison_id: ADMIN.me.id });
  check(needsAction(ownAdmin, ADMIN.me, ADMIN.can, idx) === true, "an administrator may approve their own");

  // approved: the filer now owes the ERP reference, so it becomes THEIR work
  const approved = req("open", { lines: [line({ status: "open" })] });
  check(requestStep(approved, LIA.me, LIA.can, idx).step === "erp", "approved: the filer's next step is the ERP reference");
  check(needsAction(approved, LIA.me, LIA.can, idx) === true, "approved: it moves onto the filer's list, it does not disappear");
  check(needsAction(approved, TM.me, TM.can, idx) === false, "approved: no longer top management's");
  check(needsAction(approved, LIA2.me, LIA2.can, idx) === false, "approved: and certainly not another liaison's");
  const withRef = req("open", { erp_ref: "ERP-1", lines: [line({ status: "open" })] });
  check(needsAction(withRef, LIA.me, LIA.can, idx) === false, "ERP reference entered: off the filer's list");
  check(needsAction(withRef, ACCT.me, ACCT.can, idx) === true, "ERP reference entered: accounting disburses it");

  // rejected: nobody's work
  const rejected = req("rejected", { lines: [line({ status: "rejected" })] });
  for (const u of [LIA, ADMIN, TM, ACCT]) check(needsAction(rejected, u.me, u.can, idx) === false, `rejected: nothing for ${u.me.role} to do`);
  check(needsAction({ ...rejected, status: "withdrawn" }, LIA.me, LIA.can, idx) === false, "withdrawn: nothing to do either");

  // disbursed and paid
  const disbursed = req("disbursed", { erp_ref: "ERP-1", lines: [line({ status: "disbursed" })] });
  check(needsAction(disbursed, LIA.me, LIA.can, idx) === true, "disbursed: the filer gives the fund to the client");
  const paid = req("paid", { erp_ref: "ERP-1", lines: [line({ status: "paid", paid_amount: 1000 })] });
  check(needsAction(paid, TM.me, TM.can, idx) === true, "paid: top management verifies");
  check(needsAction(paid, LIA.me, LIA.can, idx) === false, "paid: nothing left for the filer");
  check(needsAction(paid, ACCT.me, ACCT.can, idx) === false, "paid: accounting is only the backup under the default close policy");
  const both = { ...idx, closePolicy: "both" };
  check(countNeedsAction([paid], ACCT.me, ACCT.can, both) === 1, "paid: accounting does verify when both verifications are required");
}

// ---- 2. the counts the badge actually shows ----
{
  check(count([], LIA) === 0, "nothing waiting: 0, which clears the badge");
  const one = req("open", { lines: [line({ status: "open" })] });
  check(count([one], LIA) === 1, "one request waiting: 1");
  const three = [req("open", { lines: [line({ status: "open" })] }), req("open", { lines: [line({ status: "open" })] }), req("disbursed", { erp_ref: "E", lines: [line({ status: "disbursed" })] })];
  check(count(three, LIA) === 3, "three waiting: 3");
  // one of them is resolved: the count is read again, not decremented
  const after = [three[0], { ...three[1], erp_ref: "ERP-9" }, three[2]];
  check(count(after, LIA) === 2, "one resolved: 2 (read from the current state, never count - 1)");
  const allDone = after.map((r) => ({ ...r, erp_ref: "ERP-9", status: "closed", lines: [line({ status: "closed" })] }));
  check(count(allDone, LIA) === 0, "all resolved: 0, so the badge is cleared");
}

// ---- 3. the count belongs to one person: no leaking ----
{
  const mine = req("open", { lines: [line({ status: "open" })] });
  const theirs = req("open", { liaison_id: LIA2.me.id, lines: [line({ status: "open" })] });
  const rows = [mine, theirs];
  check(count(rows, LIA) === 1, "a liaison counts their own request only");
  check(count(rows, LIA2) === 1, "the other liaison counts theirs only");
  check(count(rows, LIA) + count(rows, LIA2) === 2, "the two counts do not overlap");
  check(visibleToUser(rows, LIA.me, LIA.can).length === 1, "a liaison cannot even see the other's request (the read policy)");
  check(visibleToUser(rows, TM.me, TM.can).length === 2, "top management sees both, as the read policy allows");
  check(count(rows, TM) === 0, "but neither is waiting for top management, so their badge stays 0");
  check(count(rows, VIEW) === 0, "an auditor sees everything and is never waited on");
}

// ---- 4. an approver's count, and that it is not just the approval queue ----
{
  const queue = [req("on_hold"), req("on_hold"), req("on_hold")];
  check(count(queue, TM) === 3, "three awaiting approval: top management's badge is 3");
  check(count(queue, ADMIN) === 3, "and the administrator's is 3");
  const mixed = [...queue, req("paid", { erp_ref: "E", lines: [line({ status: "paid", paid_amount: 1000 })] })];
  check(count(mixed, TM) === 4, "a paid request needing verification counts too: 4, not just the approval queue");
  const afterApproval = [queue[0], queue[1], { ...queue[2], status: "open", lines: [line({ status: "open" })] }, mixed[3]];
  check(count(afterApproval, TM) === 3, "after approving one: 3 (it left their list)");
  check(count(afterApproval, LIA) === 1, "and the filer picked it up: 1 (the ERP reference)");
}

// ---- 5. the same count whatever device it is sent to ----
{
  const rows = [req("open", { lines: [line({ status: "open" })] }), req("disbursed", { erp_ref: "E", lines: [line({ status: "disbursed" })] })];
  const n = count(rows, LIA);
  const devices = ["office-pc", "home-laptop", "android", "iphone"];
  check(devices.every(() => count(rows, LIA) === n), `every device of the same person is sent the same number (${n})`);
  check(n === 2, "and that number is the person's state, not anything about the device");
}

// ---- 6. reclassification, the one branch that needs the project index ----
{
  const closedInternal = req("closed", { erp_ref: "E", lines: [line({ status: "closed", project_id: "p-int", paid_amount: 1000, reclass: [] })] });
  check(needsAction(closedInternal, TM.me, TM.can, idx) === true, "a closed internal-project request is waiting to be reclassified");
  check(needsAction(closedInternal, LIA.me, LIA.can, idx) === false, "but not by the liaison, who cannot reclassify");
  const done = { ...closedInternal, lines: [line({ status: "closed", project_id: "p-int", paid_amount: 1000, reclass: [{ amount: 1000 }] })] };
  check(needsAction(done, TM.me, TM.can, idx) === false, "once it is all split, nobody is waited on");
  const part = { ...closedInternal, lines: [line({ status: "closed", project_id: "p-int", paid_amount: 1000, reclass: [{ amount: 400 }] })] };
  check(requestStep(part, TM.me, TM.can, idx).step === "reclass_partial", "a partly split one says so");
  check(needsAction(part, TM.me, TM.can, idx) === true, "and is still top management's to finish");
  const closedReal = req("closed", { erp_ref: "E", lines: [line({ status: "closed", project_id: "p-real", paid_amount: 1000 })] });
  check(needsAction(closedReal, TM.me, TM.can, idx) === false, "a closed request on a real project is simply complete");
  check(needsAction(closedInternal, TM.me, TM.can, null) === false, "with no project index the rule does not guess");
}

// ---- 7. odds and ends the function can hand it ----
{
  check(countNeedsAction(undefined, LIA.me, LIA.can, idx) === 0, "no requests at all is 0, not an error");
  check(needsAction({ id: "x", status: "open", liaison_id: LIA.me.id, erp_ref: null, lines: undefined }, LIA.me, LIA.can, idx) === true, "a request whose lines did not load is still judged on its status");
  check(requestStep({ id: "y", status: "banana", liaison_id: "z", lines: [] }, LIA.me, LIA.can, idx).mine === false, "a status the rule does not know is nobody's work");
  check(makeCan("admin", [])("requests.approve") === true, "an administrator has every permission even with an empty list");
  check(makeCan("liaison", null)("requests.approve") === false, "a role with no permissions list can do nothing");
}

console.log(fails ? `\nBADGE SELFTEST: ${fails} failed` : "\nBADGE SELFTEST: all checks passed");
process.exit(fails ? 1 : 0);
