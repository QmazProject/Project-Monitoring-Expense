// Checks how the side panel remembers the order someone arranged it in (src/nav-order.js): what is read back,
// what a move does, what happens to modules the arrangement does not mention, and that storage which is full,
// blocked or holding someone else's data never breaks the panel.
// usage: npm run nav:selftest
import { NAV_ORDER_KEY, applyNavOrder, clearNavOrder, mergeNavOrder, moveInOrder, placeInOrder, readNavOrder, writeNavOrder } from "../src/nav-order.js";

let fails = 0;
const check = (cond, what) => {
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) fails++;
};

const storage = (start) => {
  const m = new Map(start ? [[NAV_ORDER_KEY, start]] : []);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _raw: () => m.get(NAV_ORDER_KEY) };
};
// the modules an administrator sees, in the order the app ships them
const NAV = ["report", "new", "approvals", "requests", "analysis", "projects", "settings"].map((id) => ({ id, label: id }));
const ids = (xs) => xs.map((n) => n.id);

// reading what is there
{
  check(readNavOrder(storage()).length === 0, "a browser that has never been arranged has no order");
  check(readNavOrder(null).length === 0, "no storage at all is not an error");
  check(readNavOrder(storage('["approvals","report"]')).join() === "approvals,report", "a saved order is read back");
  check(readNavOrder(storage("not json at all")).length === 0, "rubbish in storage is ignored, not thrown");
  check(readNavOrder(storage('{"a":1}')).length === 0, "something that is not a list is ignored");
  check(readNavOrder(storage('["approvals","approvals","report"]')).join() === "approvals,report", "a repeated id is only counted once");
  check(readNavOrder(storage('["approvals",5,null,"<script>","report"]')).join() === "approvals,report", "entries that are not plain ids are dropped");
  const threw = { getItem: () => { throw new Error("blocked"); } };
  check(readNavOrder(threw).length === 0, "storage that throws is treated as empty");
}

// writing
{
  const s = storage();
  check(writeNavOrder(s, ["approvals", "report"]) === true, "an order is saved");
  check(s._raw() === '["approvals","report"]', `it is saved as a plain list (${s._raw()})`);
  check(writeNavOrder(s, ["approvals", "oops!", 7]) === true && s._raw() === '["approvals"]', "only real ids are written");
  check(writeNavOrder(null, ["a"]) === false, "no storage: saving reports that it did not save");
  const full = { setItem: () => { throw new Error("quota"); } };
  check(writeNavOrder(full, ["approvals"]) === false, "storage that is full reports that it did not save");
  const c = storage('["approvals"]');
  check(clearNavOrder(c) === true && c._raw() === undefined, "the arrangement can be forgotten");
}

// drawing the panel in the saved order
{
  check(ids(applyNavOrder(NAV, [])).join() === ids(NAV).join(), "no arrangement: the panel keeps the order it ships with");
  const moved = applyNavOrder(NAV, ["approvals", "requests"]);
  check(ids(moved).slice(0, 2).join() === "approvals,requests", `arranged modules come first (${ids(moved).slice(0, 3).join(" > ")})`);
  check(ids(moved).length === NAV.length, "no module is lost");
  check(ids(moved).slice(2).join() === "report,new,analysis,projects,settings", "the rest keep the order they shipped in, after them");
  // a module added in a later build, and one that no longer exists
  const future = [...NAV, { id: "payments", label: "payments" }];
  check(ids(applyNavOrder(future, ["approvals"])).includes("payments"), "a module added later still appears");
  check(ids(applyNavOrder(future, ["approvals"])).pop() === "payments", "it appears at the end of an arranged panel");
  check(ids(applyNavOrder(NAV, ["approvals", "gone-away", "report"])).join() === "approvals,report,new,requests,analysis,projects,settings", "an id for a module that no longer exists is ignored");
  // a liaison sees only three of them
  const liaison = NAV.filter((n) => ["new", "requests", "report"].includes(n.id));
  check(ids(applyNavOrder(liaison, ["approvals", "requests", "report"])).join() === "requests,report,new", "ids this role cannot open are skipped, the rest still obey the order");
  check(applyNavOrder(undefined, ["a"]).length === 0 && applyNavOrder(NAV, undefined).length === NAV.length, "missing arguments do not break the panel");
}

// moving one module
{
  const base = ids(NAV);
  check(moveInOrder(base, "approvals", -1).join() === "report,approvals,new,requests,analysis,projects,settings", "move up swaps with the one above");
  check(moveInOrder(base, "approvals", 1).join() === "report,new,requests,approvals,analysis,projects,settings", "move down swaps with the one below");
  check(moveInOrder(base, "report", -1).join() === base.join(), "the top one cannot move up");
  check(moveInOrder(base, "settings", 1).join() === base.join(), "the bottom one cannot move down");
  check(moveInOrder(base, "nope", -1).join() === base.join(), "an unknown module changes nothing");
  check(moveInOrder(base, "approvals", 0).join() === base.join(), "moving nowhere changes nothing");
  // four moves up take the fourth module to the top, one step at a time
  let order = base.slice();
  for (let i = 0; i < 3; i++) order = moveInOrder(order, "requests", -1);
  check(order[0] === "requests", `repeating move up walks a module to the top (${order.slice(0, 3).join(" > ")})`);
  check(order.length === base.length && new Set(order).size === base.length, "nothing is lost or duplicated by moving");
}

// dropping one module at a position, which is what dragging does
{
  const base = ids(NAV);
  check(placeInOrder(base, "settings", 0).join() === "settings,report,new,approvals,requests,analysis,projects", "dragging to the top puts it first");
  check(placeInOrder(base, "report", 6).pop() === "report", "dragging to the bottom puts it last");
  check(placeInOrder(base, "report", 99).pop() === "report", "dragging past the bottom stops at the bottom");
  check(placeInOrder(base, "report", -5)[0] === "report", "dragging above the top stops at the top");
  check(placeInOrder(base, "report", 0).join() === base.join(), "dropping a module where it already is changes nothing");
  check(placeInOrder(base, "nope", 2).join() === base.join(), "dragging an unknown module changes nothing");
  check(new Set(placeInOrder(base, "analysis", 1)).size === base.length, "nothing is lost or duplicated by dragging");
}

// two people sharing one browser
{
  const admin = ["approvals", "requests", "report", "new", "analysis", "projects", "settings"];
  const liaisonArranged = ["requests", "new", "report"];
  const merged = mergeNavOrder(liaisonArranged, admin);
  check(merged.slice(0, 3).join() === "requests,new,report", "the person arranging gets exactly the order they chose");
  check(merged.includes("approvals") && merged.includes("settings"), "the other person's modules are not thrown away");
  check(new Set(merged).size === merged.length, "no id ends up in the list twice");
  check(mergeNavOrder(["a"], undefined).join() === "a" && mergeNavOrder(undefined, ["b"]).join() === "b", "a missing side is handled");
}

// the whole round trip, as the app does it
{
  const s = storage();
  let order = readNavOrder(s);
  let shown = ids(applyNavOrder(NAV, order));
  check(shown.join() === ids(NAV).join(), "first visit: the panel ships in its usual order");
  order = moveInOrder(shown, "approvals", -1);
  order = moveInOrder(order, "approvals", -1);
  writeNavOrder(s, mergeNavOrder(order, readNavOrder(s)));
  shown = ids(applyNavOrder(NAV, readNavOrder(s)));
  check(shown[0] === "approvals", `moved twice and saved, Approvals is at the top (${shown.slice(0, 3).join(" > ")})`);
  clearNavOrder(s);
  check(ids(applyNavOrder(NAV, readNavOrder(s))).join() === ids(NAV).join(), "reset puts the panel back to the order it ships with");
}

console.log(fails ? `\nNAV ORDER SELFTEST: ${fails} failed` : "\nNAV ORDER SELFTEST: all checks passed");
process.exit(fails ? 1 : 0);
