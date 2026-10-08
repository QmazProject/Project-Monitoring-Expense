// Checks the order of the approvals queue (src/approvals-queue.js): the requests waiting longest first,
// oldest of them at the very top, then everything else newest first. Crafted dates, so the boundary and the
// tie cases can be checked without waiting three days or opening a browser.
// usage: npm run approvals:selftest
import { APPROVAL_AGING_DAYS, groupApprovalQueue } from "../src/approvals-queue.js";

let fails = 0;
const check = (cond, what) => {
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) fails++;
};

// The app counts whole days from the day a request was filed (statusSince + daysSince), so the test does the
// same: a request filed n days ago has waited n days, whatever the time of day.
const DAY = 86400000;
const NOW = Date.parse("2026-10-07T00:00:00Z");
const ago = (days, hours = 9) => new Date(NOW - days * DAY + hours * 3600000).toISOString();
const req = (ref, daysOld, hours) => ({ id: ref, ref_no: `REQ-2026-${String(ref).padStart(4, "0")}`, created_at: ago(daysOld, hours), _age: daysOld });
const days = (r) => r._age; // what daysSince(statusSince(r,"on_hold")) returns in the app
const refs = (xs) => xs.map((r) => r.ref_no.slice(-4));

check(APPROVAL_AGING_DAYS === 3, `the threshold is ${APPROVAL_AGING_DAYS} days, in one place`);

// Scenario 1 - nothing is old: the queue is just the new requests, newest first, and there is no group label
{
  const { queue, aging } = groupApprovalQueue([req(8, 0), req(9, 1), req(10, 2)], days);
  check(refs(queue).join() === "0008,0009,0010", `nothing old: newest first (${refs(queue).join(" > ")})`);
  check(aging === 0, "nothing old: no needs-attention group, so its label is not shown");
}

// Scenario 2 - one old request leads, the rest stay newest first
{
  const { queue, aging } = groupApprovalQueue([req(10, 0), req(2, 8), req(9, 1)], days);
  check(refs(queue).join() === "0002,0010,0009", `one old request leads (${refs(queue).join(" > ")})`);
  check(aging === 1, "one old request: the group holds exactly it");
}

// Scenario 3 - several old requests, oldest of them first
{
  const { queue, aging } = groupApprovalQueue([req(5, 4), req(2, 8), req(4, 6)], days);
  check(refs(queue).join() === "0002,0004,0005", `old requests are oldest first (${refs(queue).join(" > ")})`);
  check(aging === 3, "old requests: all three need attention, so nothing is left for the new group");
}

// Scenario 4 - the boundary. The app counts whole days, so the test states the day count each case has.
{
  const two = req(21, 2), three = req(22, 3), four = req(23, 4);
  const { queue, aging, waitDays } = groupApprovalQueue([two, three, four], days);
  check(aging === 2, "2 days stays new; 3 and 4 days need attention (the threshold includes 3)");
  check(refs(queue).join() === "0023,0022,0021", `boundary order: 4d, 3d, then the 2d one (${refs(queue).join(" > ")})`);
  check(waitDays.get(two.id) === 2 && waitDays.get(three.id) === 3, "the days waited are reported for the label");
  // one day either side of the threshold, on its own
  check(groupApprovalQueue([req(30, APPROVAL_AGING_DAYS - 1)], days).aging === 0, `${APPROVAL_AGING_DAYS - 1} days: new`);
  check(groupApprovalQueue([req(31, APPROVAL_AGING_DAYS)], days).aging === 1, `${APPROVAL_AGING_DAYS} days: needs attention`);
}

// Scenario 5 - identical timestamps: the reference number decides, and it decides consistently
{
  const same = (ref) => ({ id: ref, ref_no: `REQ-2026-${String(ref).padStart(4, "0")}`, created_at: ago(1), _age: 1 });
  const a = groupApprovalQueue([same(41), same(43), same(42)], days);
  check(refs(a.queue).join() === "0043,0042,0041", `same timestamp, new group: highest reference first (${refs(a.queue).join(" > ")})`);
  const b = groupApprovalQueue([same(43), same(41), same(42)], days);
  check(refs(a.queue).join() === refs(b.queue).join(), "same timestamp: the order does not depend on the order they arrived in");
  const oldSame = (ref) => ({ id: ref, ref_no: `REQ-2026-${String(ref).padStart(4, "0")}`, created_at: ago(9), _age: 9 });
  const c = groupApprovalQueue([oldSame(51), oldSame(53), oldSame(52)], days);
  check(refs(c.queue).join() === "0051,0052,0053", `same timestamp, needs attention: lowest reference first (${refs(c.queue).join(" > ")})`);
}

// Scenario 6 - the whole queue is one list, so paging over it cannot lose or repeat a request
{
  const input = [];
  for (let i = 1; i <= 25; i++) input.push(req(i, i % 7)); // a mix of ages, deliberately unsorted
  const { queue, aging } = groupApprovalQueue(input, days);
  check(queue.length === input.length, `every request is in the list once (${queue.length} of ${input.length})`);
  check(new Set(queue.map((r) => r.id)).size === input.length, "no request appears twice");
  check(new Set(input.map((r) => r.id)).size === new Set(queue.map((r) => r.id)).size, "no request is dropped");
  const front = queue.slice(0, aging), back = queue.slice(aging);
  check(front.every((r) => days(r) >= APPROVAL_AGING_DAYS), "everything in the front group is at or past the threshold");
  check(back.every((r) => days(r) < APPROVAL_AGING_DAYS), "everything after it is below the threshold");
  check(front.every((r, i) => i === 0 || days(front[i - 1]) >= days(r)), "the front group never gets younger as it goes down");
  check(back.every((r, i) => i === 0 || days(back[i - 1]) <= days(r)), "the group after it never gets older as it goes down");
  // paging the single list in any size covers it exactly once
  for (const per of [5, 10, 7]) {
    const paged = [];
    for (let p = 0; p * per < queue.length; p++) paged.push(...queue.slice(p * per, (p + 1) * per));
    check(paged.map((r) => r.id).join() === queue.map((r) => r.id).join(), `paging ${per} at a time gives back the same order`);
  }
}

// Odds and ends the page can actually hand it
{
  check(groupApprovalQueue([], days).queue.length === 0 && groupApprovalQueue([], days).aging === 0, "an empty queue is empty, not an error");
  check(groupApprovalQueue(undefined, days).queue.length === 0, "no queue at all is not an error");
  const noDate = { id: "x", ref_no: "REQ-2026-0099", created_at: null, _age: null };
  const r = groupApprovalQueue([noDate], () => null);
  check(r.aging === 0 && r.waitDays.get("x") === 0, "a request with no usable date counts as new, not as ancient");
  const custom = groupApprovalQueue([req(61, 5), req(62, 1)], days, 10);
  check(custom.aging === 0, "a higher threshold moves requests back into the new group");
}

console.log(fails ? `\nAPPROVALS SELFTEST: ${fails} failed` : "\nAPPROVALS SELFTEST: all checks passed");
process.exit(fails ? 1 : 0);
