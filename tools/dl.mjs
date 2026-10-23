import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const url = "https://codeload.github.com/nextlevelbuilder/ui-ux-pro-max-skill/tar.gz/refs/heads/main";
console.log("fetching...");
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) throw new Error("HTTP " + res.status);
const total = Number(res.headers.get("content-length") ?? 0);
console.log("content-length:", total);

let got = 0;
const counter = new TransformStream({
  transform(chunk, controller) {
    got += chunk.byteLength;
    if (got % (512 * 1024) < chunk.byteLength) console.log("  ", Math.round((got / total) * 100) + "%", got);
    controller.enqueue(chunk);
  },
});

await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream("tools/skill.tgz"));
console.log("done", got, "bytes");
