# 项目记录

## heart-sources 技能（2026-08 重写为「AI 全自动写源」）

目标：AI 自动生成用心读书书源。对齐上游 `freenovel123/read-with-heart-docs`（2026-08）+ `common.js`。

- **SKILL.md 单主文件**：骨架 + 字段合同 + V2 硬约束（表达式/流水线/Header 二选一/Cookie 优先级/地址传递/前置请求 `respones`/toolsUrl·commentUrl/URL 补全/富文本标签/Native/openParams/page·next/发现）+ 验证 + 交付状态。
- **移除**：references/kb、schema/rules/workflows（并入）、index/site-template/url-patterns/xpath-patterns、`minis://` 与 `/var/minis/`。
- **保留**：protocol.md、web-api.md、site-template.full.json、practice/gbk-demo-source.json、source-check.py、evals、refactor-beautify.md（重构清单）、convert-from-legado.md（阅读→RWH 映射）。

## 上游对齐（2026-11，对齐 `mrs-skills 1.0.6`）

维持本仓库轻量、主机无关、Minis 优先风格（无第三方依赖、不引入完整 TS/MCP server），同步上游关键能力边界与 Swift V2 运行时细节：

- **`type` 合同收口**：V2 网络书源仅允许 `1`（文本阅读）与 `4`（网络听书）；`0` 为 App 兼容回退警告（新建/转换源须显式写 `1` 或 `4`）；`2` 对 V2 听书无效；`3` 仅本地文件。
- **`.mrs` vs 明文 JSON 边界**：本地工具与 Web API 仅操作明文 UTF-8 JSON（`*.mrs.json`，支持 flat / `ruleData`-wrapper / `legacy-site-wrapper`）；无 `.mrs` 二进制/加密与 `.json` 的离线互转算法，仅 App `/api/site/export` 返回 AES 加密串。
- **`forbidRedirect` 作用域**：仅持久化在 `preRequests[]` JSON 中，不写入 `ruleSearch/ruleBookInfo/ruleChapter/ruleContent/ruleFinder`（那些仅存在运行时 `config.forbidRedirect`）。
- **Web API 契约修正（`references/web-api.md`）**：改为 `POST application/x-www-form-urlencoded;charset=utf-8`（空格编码 `%20`、非 JSON 体）、仅限回环/RFC1918 私网 IPv4、直接接收 canonical V2 字段；解析 `ResponsesModel` 时优先查 `resultData` 并过滤 `list` 中的请求轨迹键（`httpStatus`/`errorMag`/`jsParsing`/`responseBody`/`responseNewBody`/`originalUrl`/`newUrl`），区分 `responseType === 1` 传输失败与空匹配，超时/中止调用 `/api/site/cancelRequest`（`"0".."3"`）。
- **Swift V2 运行时勘误同步（`SKILL.md`、`references/protocol.md`）**：
  - `config` 在业务体前已由包装器 `JSON.parse`，禁止在业务体重复 `JSON.parse(config)`；`publicJavascript` 顶层立即语句运行在 `JSON.parse` 之前，应只放纯函数声明。
  - 普通字段/`<js>`/`request`/`response`/`preRequests` 同步执行（不等待 Promise）；仅 `toolsUrl`/`commentUrl` `@js:` 支持 `await app.get/post`；`loginUrl` 无 `@js:`（仅绝对 HTTP(S) URL 或本地 `@html:`）。
  - `<js>` 与 `##` 正则按源码从左到右顺序执行；`##@@##` 在 App 不串联；`@tools{}` 仅可靠支持 `timestamp()`（`sortAsc/Desc` 空，哈希优先 `app.md5/sha256`）；字段 `<js>` 禁 `eval`/`Function`/`fetch`/`OS`；`app.showDialog` 已知 bug 对确认/取消均传 `0`。
  - `putData` 按 `siteIdent` 隔离且读改写非原子事务；Header 键存为 camelCase；`@get{loginCookies}` 等对象在 JS 上下文序列化为 JSON 字符串；`page` 非空严格屏蔽 `next`，`page` 并发后续页重跑 `request` JS 但不重跑首页模板预处理，`pageMax` 为空在 `ruleSearch` 与 `ruleFinder` 探测行为不同；`ruleFinder[].list[].list` 为 JSON 序列化数组字符串，`config.selectList` 优先于 `config._<type>`。
  - `<comment ident count />` 须绝对 HTTP(S) `ident` 才可点击（不回退 `commentUrl`）；补充 5 级 `optionalCapabilities` 证据（`absent | declared | static_validated | runtime_emitted | app_interaction_verified`）与请求安全 5 层（`requestEncode/responseEncode` → `filterErrorCodes` → `forbidCookie` → `forbidSSL` → `preRequests[].forbidRedirect`）。
- **模板与转换与用例**：修复 `site-template.full.json` 中 `ruleSearch` 重复 `"requestType": 0`；更新 `convert-from-legado.md`（CSS-first、远程 `loginUrl` 补全、正则与 `@put` 语义、`type: 4`、人工迁移清单）；新增 `evals/evals.json` 3 条边界用例（`web-api-form-encoding`、`mrs-vs-json-boundary`、`audio-type4-and-sync-async`）。

## 脱敏

测试书源仅调试不入库；实践样本 `practice/gbk-demo-source.json` 已脱敏（站名/域名/author/remarks）。
