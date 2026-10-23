const fs = require("fs");

console.log("=== 删除测试：哪些模块是 pass-through 浅模块 ===\n");

// mock-server/store.ts 的 applyService 与 homehub/adapter/mock.ts 的 applyService 重复
const a = fs.readFileSync("apps/mock-server/src/store.ts", "utf8");
const b = fs.readFileSync("apps/homehub/src/adapter/mock.ts", "utf8");
const hasApplyA = a.includes("export function applyService");
const hasApplyB = b.includes("export function applyService");
console.log("applyService 重复定义:", hasApplyA && hasApplyB ? "YES - 需抽公共实现" : "no");

// 检查 mock-server 与 homehub 的 seed 数据重复
const seedExists = fs.existsSync("apps/mock-server/src/fixtures.ts");
const seedHh = fs.existsSync("apps/homehub/src/adapter/seed.ts");
console.log("实体种子数据:", seedExists ? "mock-server/fixtures.ts" : "-", "|", seedHh ? "homehub/adapter/seed.ts" : "缺失");

// 检查 mock-server 是否绕过 HomeHub 直接实现业务
console.log("\n=== 架构约束检查 ===");
const chat = fs.readFileSync("apps/mock-server/src/chat.ts", "utf8");
console.log("mock-server 是否自带策略/审计:", chat.includes("recordAudit") ? "含审计" : "无审计（仅 M0 契约验证用）");
