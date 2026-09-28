// Headless smoke test: loads a built bundle into jsdom and walks the sign-in flows.
// usage: npm run build && node scripts/smoke-test.mjs dist demo   (or: build with VITE_ keys set, then "live")
import { JSDOM } from "jsdom";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [distDir, mode] = process.argv.slice(2);
const dom = new JSDOM(`<!doctype html><html><head><title>Sign in</title></head><body><div id="root"></div></body></html>`, {
  url: "http://localhost:4173/",
  pretendToBeVisual: true,
});
const { window } = dom;
const expose = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
expose("window", window);
expose("document", window.document);
expose("navigator", window.navigator);
for (const k of ["HTMLElement", "Element", "Node", "SVGElement", "HTMLIFrameElement", "MutationObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "location", "history", "FileReader",
  "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "matchMedia", "DOMParser", "XMLSerializer", "Image"]) {
  if (window[k] !== undefined) expose(k, window[k]);
}
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
expose("matchMedia", window.matchMedia);
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
expose("ResizeObserver", window.ResizeObserver);

class WSStub { static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3; constructor(){ this.readyState=3; } send(){} close(){} addEventListener(){} removeEventListener(){} }
if (!globalThis.WebSocket) expose("WebSocket", WSStub);
if (!window.WebSocket) window.WebSocket = globalThis.WebSocket;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => window.document.body.textContent || "";
const buttons = () => [...window.document.querySelectorAll("button")];
const clickButton = (re) => {
  const b = buttons().find((x) => re.test(x.textContent || ""));
  if (!b) throw new Error(`No button matching ${re}. Buttons: ${buttons().map((x) => x.textContent.trim()).join(" | ")}`);
  b.click();
  return b;
};
const expect = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}\n--- body text ---\n${text().slice(0, 1500)}`);
  console.log("ok   " + what);
};

const entry = readdirSync(join(distDir, "assets")).find((f) => /^index-.*\.js$/.test(f));
await import(pathToFileURL(join(distDir, "assets", entry)).href);
await sleep(600);

if (mode === "demo") {
  expect(/Choose a demo account/.test(text()), "demo picker shown when no keys are configured");
  expect(!/Sign in with your account/.test(text()), "no live switch without keys");
  clickButton(/Patrick/);
  await sleep(800);
  expect(/Demo mode with sample data/.test(text()), "demo shell rendered after picking Patrick");
  expect(/Project report/.test(text()) && /Settings/.test(text()), "administrator sees Project report and Settings");
  clickButton(/Sign out/);
  await sleep(500);
  expect(/Choose a demo account/.test(text()), "back to demo picker after sign out");
  clickButton(/Mae/);
  await sleep(800);
  expect(/New request/.test(text()) && !/Approvals/.test(text()), "liaison sees New request and not Approvals");
} else {
  expect(/Use the username and password from your administrator/.test(text()), "live sign-in form shown when keys are configured");
  expect(/Try the demo/.test(text()), "'Try the demo' offered on the live form");
  expect(window.document.title === "Sign in", "tab title stays 'Sign in' before sign-in");
  clickButton(/Try the demo/);
  await sleep(600);
  expect(/Choose a demo account/.test(text()), "demo picker shown after switching");
  expect(/Sign in with your account/.test(text()), "way back to live sign-in offered");
  clickButton(/Jane/);
  await sleep(800);
  expect(/Demo mode with sample data/.test(text()), "demo shell rendered for Jane (accounting)");
  expect(window.document.title === "Project Expense Monitoring", "tab title set after sign-in");
  clickButton(/Sign out/);
  await sleep(700);
  expect(/Use the username and password from your administrator/.test(text()), "sign out from demo returns to the live form");
  // Empty submit shows the validation note without calling the network
  clickButton(/^\s*Sign in\s*$/);
  await sleep(200);
  expect(/Enter your username and password/.test(text()), "empty live submit is refused client-side");
}
console.log(`\nSMOKE ${mode}: all checks passed`);
process.exit(0);
