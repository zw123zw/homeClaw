const urls = [
  "https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/README.zh.md",
  "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
  "https://codeload.github.com/nextlevelbuilder/ui-ux-pro-max-skill/tar.gz/refs/heads/main",
];
for (const u of urls) {
  try {
    const r = await fetch(u, { redirect: "follow" });
    console.log(u, "=>", r.status, r.headers.get("content-length") ?? "");
  } catch (e) {
    console.log(u, "=> FAIL", e.cause?.code ?? e.message);
  }
}
