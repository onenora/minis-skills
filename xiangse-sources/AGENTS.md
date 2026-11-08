# 项目记录

## xiangse-sources 技能

- `SKILL.md`：书源骨架（11 个 action 键）、闪退/导入约束、requestInfo / 字段流水线 / JS 环境、从站点推导流程、命令、交付状态。
- `scripts/xs.js`：零依赖 CLI（Node ≥18）。`lint` 结构检查、`fmt` 规范化并可直出 `.xbs`、`probe` 实网全链路评估（容错 HTML 解析、XPath 1.0 子集、JSONPath 子集、GBK 编解码、`params`/`nativeTool` JS 沙箱、5xx 退避重试）、`try` 单页调规则、`sniff` 站点结构侦察。模块导出 `lint`/`fmtSource`/`readSource`/`writeSource`/`xpath`/`jsonPath`/`fieldValue`/`probeSource` 等。
- `scripts/xbs.js`：XXTEA XBS ↔ JSON（decode/encode/roundtrip/selftest）。
- `references/example-xheiyan.json`：从零推导的示例草稿（GET 搜索、og 详情、详情页全目录、正文去导航、分类筛选），`fmt` 后即成品，交付状态 `pass`（App 实测搜索/详情/目录/正文/发现页）。
- `references/patterns.md`：惯用写法与反例。

## 引擎语义约定

- URL 字段原样在 action 间传递，请求时按本 action `host` 补全。
- JSONPath 确定路径返回标量，含 `..`/`*`/`?()`/切片返回数组。
- 单字段 JS 异常只置空该字段并告警；webView 请求判 `sim`，由 App 定论。
- 源列表显示 `sourceName(desc)`，空串 desc 显示 `()`，故 fmt 删除空 desc；换源只列同名书，默认用通用关键词测链路。

## 致谢

本技能为独立新实现，部分思路参考 [cloudmantou/xiangseSkill](https://github.com/cloudmantou/xiangseSkill)，非原 skill 复刻。
