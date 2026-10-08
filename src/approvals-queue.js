/* The order of the approvals queue.

   Approvers read the queue from the top, so the newest request belongs there -- except that a request nobody
   has got to for days then sinks out of sight. The queue is therefore one list in two groups: the requests
   that have been waiting at least APPROVAL_AGING_DAYS, oldest first because the oldest is the one being
   forgotten, and then everything else newest first.

   This decides order and nothing else. Which requests are in the queue, who may see them, and what approving
   or rejecting one does are all unchanged and stay where they were (ApprovalsPage and the database).

   Kept out of App.jsx so scripts/approvals-selftest.mjs can check the order against crafted dates in Node,
   without a browser and without waiting three days. */

/** A request waiting this many whole days or more needs attention. Change it here and nowhere else. */
export const APPROVAL_AGING_DAYS = 3;

/** Newest first, with the reference number breaking a tie so the order cannot wobble between refreshes. */
const byNewest = (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.ref_no).localeCompare(String(a.ref_no));

/**
 * Splits the waiting requests into the two groups and returns them as one list in display order.
 *
 * @param {Array}    waiting   requests waiting for approval; the caller has already filtered them
 * @param {Function} days      how many whole days one request has been waiting (the app passes its own
 *                             statusSince + daysSince, so this agrees with "Days in status" elsewhere)
 * @param {number}   agingDays the threshold, for tests that need a different one
 * @returns {{queue: Array, aging: number, waitDays: Map}} queue is the whole list in display order; aging is
 *          how many entries at the front of it need attention (0 means no such group); waitDays maps a
 *          request id to the days it has waited, for the label on the entry.
 */
export function groupApprovalQueue(waiting, days, agingDays = APPROVAL_AGING_DAYS) {
  const list = Array.isArray(waiting) ? waiting : [];
  const age = (r) => {
    const n = days(r);
    return Number.isFinite(n) ? Math.max(0, n) : 0; // a request with no usable date counts as new, not ancient
  };
  const waitDays = new Map(list.map((r) => [r.id, age(r)]));
  const older = list.filter((r) => waitDays.get(r.id) >= agingDays).sort((a, b) => -byNewest(a, b));
  const recent = list.filter((r) => waitDays.get(r.id) < agingDays).sort(byNewest);
  return { queue: [...older, ...recent], aging: older.length, waitDays };
}
