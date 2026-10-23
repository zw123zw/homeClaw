const fs = require("fs");
const p = "tools/jsdom-globals.mjs";
let t = fs.readFileSync(p, "utf8");
if (!t.includes("matchMedia")) {
  t = t.replace("  window.console = globalThis.console;",
`  window.console = globalThis.console;
  // jsdom 未实现 matchMedia：补一个默认不匹配的实现
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    });
  }`);
  fs.writeFileSync(p, t, "utf8");
  console.log("matchMedia shim added");
}
