/* The order of the modules in the side panel.

   Each person arranges their own panel and the arrangement is kept in that browser's localStorage: it is a
   preference about one screen, not company data, so it needs no table, no migration and no round trip. A
   browser that has never been arranged -- or whose storage was cleared -- falls back to the order in NAV.

   Only the ORDER is stored here. Which modules a person may open is decided by their role every time the panel
   is drawn (NAV.perms in App.jsx), so an id in storage that they cannot open, or that no longer exists in this
   build, is ignored rather than trusted. That also means a module added in a later build appears at the end of
   an already-arranged panel instead of disappearing from it.

   Kept out of App.jsx so scripts/nav-order-selftest.mjs can check the rules in Node, without a browser. */

export const NAV_ORDER_KEY = "oe-nav-order";
const VALID_ID = /^[a-z][a-z0-9_-]{0,31}$/; // ids we write; anything else in storage is someone else's

/** The ids saved in this browser, or [] when there is nothing usable. Never throws. */
export function readNavOrder(store) {
  const ls = store !== undefined ? store : typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return [];
  try {
    const raw = JSON.parse(ls.getItem(NAV_ORDER_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const x of raw) if (typeof x === "string" && VALID_ID.test(x) && !out.includes(x)) out.push(x);
    return out;
  } catch (e) {
    return []; // not ours, or not JSON: the panel falls back to its built-in order
  }
}

/** Saves the ids. Returns false when storage refused them (private mode), so nothing pretends to be saved. */
export function writeNavOrder(store, ids) {
  const ls = store !== undefined ? store : typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return false;
  try {
    ls.setItem(NAV_ORDER_KEY, JSON.stringify((ids || []).filter((x) => typeof x === "string" && VALID_ID.test(x))));
    return true;
  } catch (e) {
    return false;
  }
}

/** Forgets the arrangement, so the panel goes back to the order in NAV. */
export function clearNavOrder(store) {
  const ls = store !== undefined ? store : typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return false;
  try {
    ls.removeItem(NAV_ORDER_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

/** The modules in the order to draw them: the arranged ones first, then anything the arrangement does not
 *  mention, keeping the order it had. items are the modules this person may open. */
export function applyNavOrder(items, order) {
  const list = Array.isArray(items) ? items : [];
  const wanted = Array.isArray(order) ? order : [];
  const byId = new Map(list.map((n) => [n.id, n]));
  const out = [];
  for (const id of wanted) if (byId.has(id)) out.push(byId.get(id));
  for (const n of list) if (!wanted.includes(n.id)) out.push(n); // new or never-arranged modules go last
  return out;
}

/** The order with one module moved up (-1) or down (+1). Out of range or unknown leaves it untouched. */
export function moveInOrder(ids, id, delta) {
  const list = (Array.isArray(ids) ? ids : []).slice();
  const from = list.indexOf(id);
  const to = from + (delta || 0);
  if (from < 0 || to < 0 || to >= list.length) return list;
  list.splice(to, 0, list.splice(from, 1)[0]);
  return list;
}

/** The order with one module put at an index, used while dragging. */
export function placeInOrder(ids, id, index) {
  const list = (Array.isArray(ids) ? ids : []).slice();
  const from = list.indexOf(id);
  if (from < 0) return list;
  const to = Math.max(0, Math.min(list.length - 1, index));
  if (to === from) return list;
  list.splice(to, 0, list.splice(from, 1)[0]);
  return list;
}

/** What to store after someone arranges the modules they can see: their new sequence, then any ids already in
 *  storage that are not among them. Two people sharing a browser have different modules, so one arranging
 *  theirs must not throw away the other's. */
export function mergeNavOrder(visibleIds, stored) {
  const seen = Array.isArray(visibleIds) ? visibleIds : [];
  const kept = (Array.isArray(stored) ? stored : []).filter((x) => !seen.includes(x));
  return [...seen, ...kept];
}
