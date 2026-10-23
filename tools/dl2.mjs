import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const url = "https://codeload.github.com/mattpocock/skills/tar.gz/refs/heads/main";
console.log("fetching", url);
const res = await fetch(url, { redirect: "follow" });
console.log("status:", res.status);
if (!res.ok) throw new Error("HTTP " + res.status);
await pipeline(Readable.fromWeb(res.body), fs.createWriteStream("tools/mp-skills.tgz"));
console.log("saved", fs.statSync("tools/mp-skills.tgz").size, "bytes");
