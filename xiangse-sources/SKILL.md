---
name: xiangse-sources
description: 当用户提到「香色」「香色闺阁」「Xiangse」「StandarReader」「XBS」「转换书源」「JSON转XBS」「书源可用性」时触发。用于规范、评估、从站点推导、修复与转换香色/StandarReader 2.56.1 书源（JSON 或 XBS），含零依赖 XBS 编解码与离线规则引擎。Normalize, probe, build-from-site, repair, and convert Xiangse/StandarReader 2.56.1 book sources (JSON or XBS) with zero-dependency tooling.
---

# Xiangse 香色书源

StandarReader 2.56.1 书源；写源以文本（`text`）为主，评估兼容 `comic`/`video`。Fail closed：无 roundtrip + 官方 App 证据不报 `pass`。

## 书源格式（JSON 骨架）

顶层 `{alias: source}`，一个文件可含多个源。`fmt` 输出 App 标准结构：11 个 action 键全在，非核心为桩 `{actionID, parserID:"DOM"}`，`shudanList` 为 `{}`。

```json
{
  "站点名": {
    "sourceName": "站点名", "sourceUrl": "https://site", "sourceType": "text",
    "enable": 1, "weight": "9999", "authorId": "",
    "lastModifyTime": "<unix秒字符串>", "miniAppVersion": "2.56.1", "loginUrl": "", "httpHeaders": {},
    "searchBook":     { "actionID": "searchBook", "parserID": "DOM", "host": "https://site", "validConfig": "",
                        "requestInfo": "…", "responseFormatType": "html",
                        "list": "…", "bookName": "…", "author": "…", "cover": "…", "cat": "…", "status": "…",
                        "wordCount": "…", "desc": "…", "lastChapterTitle": "…", "updateTime": "…", "detailUrl": "…" },
    "bookDetail":     { "…": "同上书籍字段；requestInfo 缺省即请求 detailUrl" },
    "chapterList":    { "list": "…", "title": "…", "url": "…", "nextPageUrl": "…", "moreKeys": { "maxPage": 50 } },
    "chapterContent": { "content": "…", "nextPageUrl": "…" },
    "bookWorld":      { "分类名": { "requestInfo": "…", "list": "…", "…": "…", "moreKeys": { "requestFilters": "…" }, "_sIndex": 0 } },
    "relatedWord": {}, "searchShudan": {}, "shudanDetail": {}, "shudanList": {}, "shupingHome": {}, "shupingList": {}
  }
}
```

action 可用键：`host`（本 action 相对 URL 的补全基址）· `httpHeaders` · `requestInfo` · `responseFormatType` · `responseEncode`/`requestParamsEncode` · 字段规则 · `nextPageUrl` · `moreKeys`（`pageSize`/`maxPage`/`skipCount`/`requestFilters`/`removeHtmlKeys`）· `JSParser`。完整示例：`references/example-xheiyan.json`（草稿，`fmt` 后即成品）。

## 写源必备约束

闪退 / 导入：

- `weight` 必须字符串（数字触发 `-[__NSCFNumber length]`）；`enable` 整数 1/0；`lastModifyTime` 字符串。
- `bookWorld` 为分类字典，禁 `categories` 数组（`-[__NSArrayI allKeys]`）。
- `parserID` 仅 `DOM`/`JS`；`responseFormatType` 取 `""`/`html`/`xml`/`json`/`data`/`base64str`，禁 `text`。
- 禁 Legado 字段（`bookSourceName`/`ruleSearch`/`java.*`/`method`/`body`…）；数组顶层是 Legado 源，需转换。
- 无段评/章评：书评/书单 action 只放桩，Legado 段评一律舍弃。

requestInfo：

- 模板：`/s?q=%@keyWord&p=%@pageIndex`，变量 `%@keyWord`/`%@pageIndex`/`%@offset`/`%@result`/`%@filter`。缺省 = 上一步 URL（`result`）。
- `@js:` 返回 URL 字符串或对象 `{url, POST:true, httpParams, httpHeaders, forbidCookie, cacheTime}`；`webView:1`+`webViewJs` 走页面执行；`response:` 直接给响应体不发请求。
- 相对 URL 原样在 action 间传递，请求时用本 action `host` 补全；JS 里自行拼接时注意不要重复 host。
- GBK 站点：`responseEncode`/`requestParamsEncode` 填编码号，`2147485234`=GB18030、`2147485233`=GBK、`2147485232`=GB2312、`2147486211`=Big5、`4`=UTF-8。

字段规则（流水线，从左到右）：

- `规则A||规则B`：备选，前者为空才试后者。`|@replace:文本` 或 `||@replace:文本`：删去该文本。`%@result` 模板：拼接当前值。
- 末段 `@js:` 收到当前值 `result`（无提取段时收到整页原文），`return` 结果即字段值；提取可能为空时先判空再调方法。
- XPath：列表子字段用 `//x` 相对当前项（项被视为独立文档），避 `./`、`.//`；元素取文本，`/@href` 取属性，多命中按行拼接，URL 字段取首行。
- JSON：`$.a.b` 或 `a/b`；确定路径返回标量，含 `..`/`*`/`?()`/切片返回数组（`$..p|@js: result.join('\n')`）。

JS 环境：

- `params`：`keyWord`/`pageIndex`/`offset`/`filters.<key>`/`queryInfo`（上一步书籍对象：`detailUrl`/`url`/`bookName`…）/`responseUrl`/`lastResponse`。
- `params.nativeTool`：`XPathParserWithSource(html).queryWithXPath(xp)[i].content()`、`md5Encode`、`base64Decode`、`setCache`/`getCache`、`log`。`config`：`host`/`httpHeaders`。
- 无内置 `CryptoJS`/`atob`/`btoa`，需要就内联；用 `var`/普通函数，避 `?.`/`??`。
- `JSParser`：`function 名(config, params, result){}`；列表返回 `{list:[…]}`，正文返回字符串或 `{content}`，详情返回书籍对象；多页返回 `{nextPageUrl, autoRequestMore:true}`，下一轮 `params.lastResponse` 为上页响应。
- `requestFilters`：字符串 `key\n标题::值\n…`（多组空行分隔，首选）或数组 `[{key, items:[{title,value}]}]`；取值 `params.filters.key`。
- `nextPageUrl` 必须配 `moreKeys.maxPage`；正文分页加同章守卫。
- 源列表显示为 `sourceName(desc)`：`sourceName` 只写站点名，`desc` ≤12 字；无描述时删掉 `desc` 键（空串显示为 `名()`），宣传语不进书源。

惯用写法与反例：`references/patterns.md`。

## 从站点推导书源

1. `sniff <首页>`：编码、移动版、表单（搜索 method/action/字段）、链接模式（书/章 URL 规律）、疑似接口。
2. 搜索：表单 GET 用模板；POST 用 `@js:` 对象。`try <url> --post 'k=词'` 看结果页，`try <页> --list '项规则' bookName=… detailUrl=…` 调规则。
3. 详情：先看 `og:novel:*` meta；目录在详情页或独立页（JS 从 `queryInfo.detailUrl` 推导）。
4. 目录 / 正文：`try` 验证列表数与正文；正文用 `||@js:` 去广告；检查章内分页（`下一页` vs `下一章`）。
5. 分类（可选）：`bookWorld` + `requestFilters`；无搜索的站点可只做分类。
6. 写草稿 JSON → `fmt` 补齐 → `lint` → `probe` 全链路 ok → `fmt out.xbs` 交付。

## Convert and verify

依赖 Node ≥18，零三方包。`scripts/` 相对本技能目录；书源、报告、产物放用户工作目录，不写进技能目录。

```bash
node scripts/xs.js lint  src.json|src.xbs …         # 结构/闪退检查，退出码 0 通过 / 1 警告 / 2 失败
node scripts/xs.js fmt   draft.json out.xbs          # 补桩、类型修正、键排序；.xbs 自带 roundtrip + sha256
node scripts/xs.js probe src.xbs|dir … --jobs 8 --report r.json   # 搜索→详情→目录→正文 实网评估
node scripts/xs.js try   <url|file> [k=规则…] [--list 规则] [--post 'a=1'] [--encode gbk]
node scripts/xs.js sniff <url>
node scripts/xbs.js decode in.xbs out.json | encode in.json out.xbs | roundtrip in.json out | selftest
```

`probe` 结论：`ok` 可用 · `broken` 失效（规则/接口改版，附失败阶段）· `dead` 站点不可达（换域、证书、404/5xx）· `blocked` 反爬盾/验证码 · `sim` 需 App 实测（webView 等脚本不可模拟）。默认关键词为通用词（文本 `都市,我的`，依次尝试直到有结果），测链路不测收录；`--keyword 书名` 单个书名时额外标「无同名」（App 换源只列同名书）。无搜索的源自动改用首个分类入口。`sim`/`blocked` 交给 App「检测站点」或手动搜索定论。批量评估按文件合并 `--report`，可用源可再 `fmt` 成合集 `.xbs`。沙箱 / 代理拒绝的跳转目标会显示为 `dead`，换网络复测再定论。

## Delivery status

`need_input` 缺 URL/源文件 · `fail` lint 失败或 roundtrip 失败 · `blocked` 反爬/需登录，或 probe ok 但官方 App 未实测 · `pass` probe ok + roundtrip 过 **且** 官方 App 实测（导入/搜索/详情/目录/正文）。模拟永远不等于 `pass`。
