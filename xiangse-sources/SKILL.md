---
name: xiangse-sources
description: 当用户提到「香色」「香色闺阁」「Xiangse」「StandarReader」「XBS」「转换书源」「JSON转XBS」时触发。用于构建、修复、转换与验证香色/StandarReader 2.56.1 文本书源（JSON 或 XBS），含零依赖 XXTEA XBS 转换。Build, repair, convert, and verify Xiangse/StandarReader 2.56.1 text book sources (JSON or XBS), including xxtea-based XBS conversion with no binary dependencies.
---

# Xiangse 香色书源

只做 StandarReader 2.56.1 文本书源。Fail closed：无 roundtrip + 官方 App 证据不报 `pass`。

## 骨架

顶层对象，一个 alias 包一个源；四个核心 action 必含 `actionID`/`parserID`/`requestInfo`（字符串）/`responseFormatType`。

```json
{
  "alias": {
    "sourceName": "站点+版本",
    "sourceUrl": "https://…/",
    "sourceType": "text",
    "enable": 1,
    "weight": "9999",
    "lastModifyTime": "<unix秒>",
    "miniAppVersion": "2.56.1",
    "searchBook": {
      "actionID": "searchBook",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "…",
      "list": "…",
      "bookName": "…",
      "detailUrl": "…"
    },
    "bookDetail": {
      "actionID": "bookDetail",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "%@result",
      "title": "…",
      "cover": "…",
      "desc": "…"
    },
    "chapterList": {
      "actionID": "chapterList",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "%@result",
      "list": "…",
      "title": "//text()",
      "url": "//@href"
    },
    "chapterContent": {
      "actionID": "chapterContent",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "%@result",
      "content": "…"
    }
  }
}
```

## 硬约束（闪退 / 导入 / 契约）

- `weight` 必须字符串（数字触发 `-[__NSCFNumber length]` 崩溃）。
- `bookWorld` 用分类字典，禁 `categories` 数组（触发 `-[__NSArrayI allKeys]` 崩溃）。
- `bookWorld.*.moreKeys.requestFilters` 保持字符串：`category\n标题::值\n…`。
- `parserID` 仅 `DOM`/`JS`；`responseFormatType` 取 `""`/`base64str`/`html`/`xml`/`json`/`data`，禁 `text`。
- 禁 Legado 字段：`java.getParams`/`method`/`data`/`body`/`headers`/`bookSourceName`/`bookSourceUrl`。
- **无段评/章评能力**：StandarReader 2.56.1 只有四核心 action + bookWorld，无评论类 action。Legado 源的段评（`review=1` 注入 `<comment>` 徽标）,评论接口与章评一律舍弃：转换时不映射、不测试、不交付，正文走纯文本链路（番茄书源已按此处理）。
- 请求对象键：`url`/`POST`/`httpParams`/`httpHeaders`/`forbidCookie`/`forbidCache`/`cacheTime`。
- JS 用 `var` + 普通函数，避可选链/空值合并。`sourceName` 只写「站点名+版本」，宣传信息放 `delivery_notes`。

## requestInfo

- 替换式 `…?key=%@keyWord&p=%@pageIndex`；变量 `%@keyWord`/`%@pageIndex`/`%@offset`/`%@filter`。
- 链式 `%@result` 复用上一步 URL。
- JS 式 `@js:` 开头，内置 `params`/`config`/`result`，返回请求对象。
- 中文搜索 GET + `encodeURIComponent(params.keyWord)`。

## XPath / JSONPath

- 列表子字段双斜杠：`title: //text()`、`url: //@href`、`detailUrl: //@href`；避 `./`/`.//`。
- 备选 `||` 分隔；条件 `[contains(@class,'…')]`；JSON 响应用 `$` 前缀 JSONPath。
- 相对链接客户端自动补 host。

## 分页 / 分类 / 正文

- `nextPageUrl` 必须配 `moreKeys.maxPage`；正文分页加同章守卫（bookId/chapterId 相同且页号递增）。
- `moreKeys`：`pageSize`/`maxPage`/`skipCount`/`requestFilters`/`removeHtmlKeys`。
- 不假定内置 `CryptoJS`/`atob`/`webViewSniff`；正文优先接口链路，不可行再 webView；无法 live 验收报 `blocked/fail`，不交付密文/空正文。

## 转换

依赖：Node.js。`scripts/` 相对本技能目录；书源与产物放在用户工作目录（或模型判断的合适位置），不要写进技能目录。

```bash
node scripts/xbs.js decode in.xbs out.json     # xbs → json
node scripts/xbs.js encode in.json out.xbs     # json → xbs
node scripts/xbs.js roundtrip in.json out      # encode+decode 比对，失败报错并打印 sha256
node scripts/xbs.js selftest
```

零依赖纯 JS（Node 内置 fs/crypto）。流程：decode → 改 JSON → roundtrip 过 → 交付 `.xbs` + sha256。

## 交付状态

`need_input` 缺 URL/源文件/目标 App · `fail` 契约或 roundtrip 失败 · `blocked` 反爬/需登录/官方 App 不可用 · `pass` roundtrip 过 **且** 官方原版 App 实测（导入/搜索/详情/目录/正文/编辑器保存）。模拟永远不等于 `pass`。
