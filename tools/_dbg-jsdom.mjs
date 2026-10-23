import { JSDOM } from "jsdom";
const dom = new JSDOM("<div/>");
const { window } = dom;
const e = new window.KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true });
console.log("code=", JSON.stringify(e.code), "key=", JSON.stringify(e.key), "isComposing=", e.isComposing);
let hit = 0;
dom.window.document.addEventListener("keydown", (ev) => { hit++; console.log("listener saw code=", JSON.stringify(ev.code)); });
dom.window.document.dispatchEvent(e);
console.log("hit=", hit);
