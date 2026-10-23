# 0004 设计系统偏离生成值的两处颜色

ui-ux-pro-max 生成的配色中，`destructive #EF4444` 在卡片背景上对比度 4.16:1、`border #475569` 对卡片 2.07:1，均未达 WCAG AA。调整 `destructive → #F26B6B`（5.29:1）、`border → #6B7C96`（3.69:1），其余令牌保持生成值。色相未变，仅提亮到可读区间；实测数据记录在 `design-system/homeclaw/MASTER.md` 的 Contrast Audit 表，可用 `node tools/contrast.mjs` 复现。

**Status**: accepted