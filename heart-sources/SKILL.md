---
name: heart-sources
description: 当用户提到「用心读书」「用心书源」「Read With Heart」「ParsingBook」时触发。注意区分：用心读书/Read With Heart ≠ 阅读/Legado ≠ 香色/Xiangse，三者书源格式互不兼容。用于生成、修复、转换、调试用心读书书源。
---

# Read With Heart Book Source（AI 自动写源）

只做用心读书（Read With Heart / ParsingBook）文本阅读源（`type: 1`）与网络听书源（`type: 4`），V2 规则。
本地工具与 Web API 均只处理明文 UTF-8 JSON（`*.mrs.json`，不支持离线 `.mrs` 二进制加解密互转）。
Fail closed：结构自检 + 页面样本四链路实测通过才交付，官方 App 实测前不报 `pass`。

## 书源骨架（顶层对象）

```json
{
  "type": 1, "siteName": "站点", "version": 1, "host": "https://example.com/",
  "ruleSearch":   { "mode":"http", "engine":"xpath", "method":"GET", "url":"/search?keyword=@{keyword}", "bookList":"//*[@class='list']/*", "bookName":"//a", "bookUrl":"//a/@href" },
  "ruleBookInfo": { "mode":"http", "engine":"xpath", "method":"GET", "chapterListUrl":"" },
  "ruleChapter":  { "mode":"http", "engine":"xpath", "method":"GET", "chapterList":"//*[@id='chapterlist']/li", "chapterName":"//a", "chapterUrl":"//a/@href" },
  "ruleContent":  { "mode":"http", "engine":"xpath", "method":"GET", "contents":"//*[@id='content']/text()" }
}
```

- 顶层是明文 JSON 对象（也支持导入解包 `ruleData` 包装与 `{ site }` 包装）。`siteName`/`host` 必填，`version` 数字递增（可为 0）。
- **`type` 合同**：V2 网络书源仅允许 **`1`**（文本阅读）与 **`4`**（网络听书）；`0` 仅作 App 兼容回退警告（新建/转换源必须显式写 `1` 或 `4`）；**`2` 对 V2 听书无效**；`3` 仅限本地文件；漫画/短剧不在本技能范围。
- 规则段公共字段：`mode`(http/webview) `engine`(xpath/jsonpath/css) `method`(GET/POST) `url` `params` `header`(`{String:String}`) `preRequests` `request` `response` `requestEncode`/`responseEncode`(`utf-8`/`gbk`) `forbidCookie` `forbidSSL` `filterErrorCodes`(`int[]`)。
- **`forbidRedirect` 边界**：仅持久化在 `preRequests[]` JSON 中，正式规则段（`ruleSearch`/`ruleBookInfo`/`ruleChapter`/`ruleContent`/`ruleFinder`）无该 JSON 字段（仅内部运行时有 `config.forbidRedirect`）。

## 字段合同

| 段 | 必填（官方最小集） | AI 写源建议（不强制） |
|---|---|---|
| ruleSearch | url / bookList | bookName、bookUrl、bookAuthor、aliasName、ruleExtra.*、pageMax |
| ruleBookInfo | （可为空，空则沿用搜索信息） | bookName、bookAuthor、chapterListUrl、toolsUrl、importUrl、ruleExtra.* |
| ruleChapter | chapterList | chapterName、chapterUrl、chapterTime、page、next |
| ruleContent | contents | cleaner、page、next、commentUrl、**playUrl** |

- 官方校验仅要求：search=url+bookList、chapter=chapterList、content=contents，且**至少存在一个规则段**；其余字段官方不强制，AI 写源仍按建议列写全。
- **听书源**：`type` 必须为 **`4`**（不再使用 `2`）；`ruleContent.playUrl` **必填**，提取音频地址（jsonpath 可用 `$..content`；相对地址自动按 `host` 补全）；`contents` 可给文本/歌词（可空）；音频需专用请求头时写 `ruleContent.header`（`playUrl` 为空时用正文 URL 与正文 Header）。搜索/详情/目录结构与文本源一致。
- `aliasName`：又名/原名；非空时按 `bookName OR aliasName` 匹配并作显示名。列表子字段以列表项作独立文档求值（如 `//a`、`//a/@href`），单值 URL 多命中取首个 `(//a[@rel='next']/@href)[1]`。
- 旧字段禁项：`baseUrl`→`host`；`headers`→`header`；`requestInfo`→`request`；`list`→`chapterList`；`name`→`chapterName`；章节 `url`→`chapterUrl`；`lines`→`contents`；`encode`→区分 `requestEncode`/`responseEncode`；`imageUrl`→`coverUrl`。

## V2 协议硬约束（最易错）

1. **规则执行与表达式**：基础规则/`@all` → `@get{}`/`${}`/`@{}`/`@tools{}`/`{{}}` → 字段级 `<js>` 与 `##` 正则。
   - **`<js>` 与 `##` 正则按规则原文从左到右顺序执行**（JS 失败回退上一步；正则失败保留输入）。
   - `${key}` 未匹配保留原文（支持算术/拼接 `${pageIndex + 1}`），`@{key}` 未匹配置空。
   - `##a` 过滤、`##a#b` 单次替换、`##a##b` 全局、`##^.*?id=(\d+).*$##$1` 捕获组；**`##@@##` 在 App 中不串联**。
   - `@tools{}` 当前仅可靠支持 `timestamp()`（`sortAsc`/`sortDesc` 返回空；哈希优先 `<js>return app.md5/sha256(...);</js>`）。
2. **`config` 时机与同步/异步边界**：
   - 业务体（字段/`request`/`response`/`preRequests`）执行前包装器已解析 `config` 为对象，**禁止再写 `JSON.parse(config)`**；**例外**：`publicJavascript` 顶层立即语句运行在 `JSON.parse(config)` 之前，只写纯函数声明并由业务体传入 `config`。
   - 普通字段/`<js>`/`request`/`response`/`preRequests` **不等待 Promise**（30s 超时）；**仅 `toolsUrl`/`commentUrl` `@js:` 支持异步 `await app.get/post`**。`loginUrl` 无 `@js:`（只接受绝对 HTTP(S) URL 或本地 `@html:`）。
   - 字段 `<js>` 禁止 `eval`/`new Function`/`fetch`/`OS`。
3. **Header、Cookie 与请求安全分层**：
   - 场景 `header` 非空时不合并公共 `header`（必须写全，值须为 `{String:String}`）；Cookie 优先级：显式 `Cookie` > `loginCookies` > HTTP 缓存。
   - 按失败层级配置：`requestEncode`/`responseEncode`（仅 `utf-8`/`gbk`，无 `encoding`）→ `filterErrorCodes`（`int[]`，仅放行已抵达 HTTP 状态码）→ `forbidCookie`（仅停用自动注入）→ `forbidSSL`（**仅限** TLS 证书报错，禁止用于 HTTP 降级或掩盖 4xx/5xx，须保留风险提示）→ `preRequests[].forbidRedirect`。
4. **地址传递与 `request`/`response` JS**：`bookUrl`→`config.infoUrl`，`chapterListUrl`→`config.bookUrl`，`chapterUrl`→`config.chapterUrl`；`config.url` 仅首屏地址。`request @js:` 改 `config` 并 `return JSON.stringify(config)`（按 `config.host` 补全）；`response @js:` 用 `html`+`config`；Document 子集 `document.select("css")`。全局 `get(k)`/`put(k,v)` 可用，新代码优先 `@get{}` / `app.sp`。
5. **`@get{}` 与 `putData`**：`putData` 按 `siteIdent` 隔离持久化，**读改写不是原子事务**（并发请求勿改同一 key）。Header 键存为 **camelCase**（`contentType`）。`@get{loginCookies}` 等对象在 JS 上下文中序列化为 JSON 字符串，JS 读对象优先 `app.sp.get(key)`，规则内优先点路径 `@get{preRepHeader1.contentType}`。
6. **前置请求 `preRequests[]`**：
   - 每项：`url`(必)、`method`、`mode`、`header`、`params`、`request`、`response{engine, put, respones}`（**必须保留拼写 `respones`**）、`preRequestType`(0 常规/1 浏览器过盾/2 图片验证码)、`forbidCookie`、`forbidSSL`、`forbidRedirect`、`filterErrorCodes`、`domains`。
   - 自动写入 `preUrlN`/`preResHeaderN`/`preRepHeaderN`、`verifyHeader`/`verifyCookies`、`config.verifyCode`。
7. **页面入口（`toolsUrl` / `commentUrl` / `loginUrl`）与 `openParams`**：
   - `toolsUrl`/`commentUrl` 支持 URL、相对 URL、`@js:`（可 `await`）、`URL,{"header":{...}}`、`{url,header}`、`@html:`、`{html,baseURL}`（HTML 模式只保证 Cookie）。
   - 远程 `loginUrl` 须为绝对 HTTP(S) URL（App 不补 `host`）；`window.ParsingBook.setOpenParamValue/s` bridge **仅注入本地 `@html:`**。
   - `openParams` 顶层为定义数组（`key` 唯一，`type`: `input|single|multiple`），运行时 `config.openParams` 为 `[String:String]` 扁平字典。
8. **正文富文本与证据分级**：
   - `---CATALOG---` + `---CONTENT---`；<img /> 须自闭合并给网络图/SVG 显式 `width`+`height`；<note /> 须自闭合且 `text` 必填；`src`/`ident` 尾随 `,{"header":{...}}` 用单引号包裹 JSON。
   - <comment ident="..." count="N" /> 须自闭合且 `count`>0，**Swift 当前要求 `ident` 为绝对 HTTP(S) URL 才可点击**（裸 ID/相对路径不回退 `commentUrl`）。
   - 可选能力 5 级证据：`absent | declared | static_validated | runtime_emitted | app_interaction_verified`（静态检查不等于 App 交互通过）。
9. **Native 能力与已知差异**：`App`/`app`/`APP`（`md5/sha1..512`、`base64`、`aes.encrypt/decrypt`、`rsa`、`bcrypt`、`nlp.chs/cht`、`strToBytes/bytesToStr`、`time`、`uuid`、`sp.put/get/delete`、`setTimeout`、`post/get`、`socket`、`doc`、`toast`、`log`）。Built-in `CryptoJS` 恒可用（V2 JS 超时 30s）。**已知 App bug**：`app.showDialog` 对确认和取消均传 `0`，勿依赖其分支。
10. **分页（`page` vs `next`）与 `pageMax`**：
    - **`page` 非空严格屏蔽 `next`**（含 `page="1"`）。`page` 并发后续页从原始配置重建并**重跑 `request` JS，不再执行首页 URL/params 模板预处理**，动态页码须在 `request @js:` 用 `config.pageIndex` 构造。
    - `pageMax` 为空时：`ruleSearch` 若能证明支持 `pageIndex` 则按 `pageIndex+1` 探测；`ruleFinder[]` 为空默认返回 `1`（除非证明支持 `pageIndex`）。`next` 区分「下一页」与「下一章」防串章。
11. **发现 `ruleFinder[]`**：数组，每项含 `uuid`（确定性且唯一）、`name`、`structure`、筛选数组 `list`（每项 `{name,type,list}`，**内层 `list` 须为 `[{name,value}]` 的 JSON 序列化字符串**）、公共请求字段、`pageMax`、书籍字段与 `ruleExtra`。读选中值优先遍历 **`config.selectList`**（优于 `config.filters` 和旧 `config._<type>`）。

## 生成决策

1. 采样真实 HTTP 页面（服务端直出，勿信 DevTools DOM）；API/JSON → JSONPath，稳定 HTML → CSS/XPath。
2. 能用静态规则不写 JS；公共纯函数放 `publicJavascript`（由业务体传入 `config`）。
3. webview 是正常能力，先于重型解密复刻评估；正文清洗按 去标签 → 实体转义 → 空白整理 → 独立标题行 → `App.nlp.chs()` 顺序。
4. 签名/时间/拼接先固定输入自测；时间毫秒 `>1e12` 转秒；Node 模拟 AES/RSA 非真实密码学，必须 App 实测。

## Convert and verify

依赖：Python 3、Node.js。`scripts/` 相对本技能目录；书源与产物放用户工作目录，勿写入技能目录。

```bash
python3 scripts/source-check.py <书源.mrs.json> [--strict]   # 退出码 0 PASS / 1 strict-warn / 2 FAIL
node scripts/heart-verify.js <书源.mrs.json> --keyword 关键词   # jsonpath 本地模拟（非真机等价）
```

App 开启「电脑写源」（Web API）后自动化实测：
- `POST` **`application/x-www-form-urlencoded;charset=utf-8`**（`%20` 空格编码，非 JSON 体）至仅限回环/RFC1918 的 `http://localhost:8080/api/site/{group,search,bookinfo,chapter,content,finder,cancelRequest}`，直接传 canonical V2 字段。
- 解析 `ResponsesModel` 须先查 `resultData` 并过滤 `list` 中的请求轨迹对象（`httpStatus`/`errorMag`/`jsParsing`/`responseBody`/`responseNewBody`/`originalUrl`/`newUrl`），区分 `responseType === 1` 传输失败与空匹配；超时/中止调用 `/api/site/cancelRequest`（`"0".."3"`），详见 `references/web-api.md`。

## Delivery status

- `need_input`：缺站点 URL、缺样本页面、或搜索策略未确认。
- `fail`：source-check FAIL 或字段合同违反。
- `blocked`：反爬/登录墙、页面不可达、存在人工迁移项未完成、或官方 App 未实测。
- `pass`：source-check PASS **且** 页面样本四链路（搜索/详情或目录/章节/正文 + 分页/清洗）实测通过 **且** 官方 App 实测通过（Node 模拟或静态校验不等于 `pass`）。

## References

- `references/protocol.md` — V2 运行时机 / `config.*` / 页面入口 / `preRequests[]` / Native / 富文本证据分级 / 分页与 `ruleFinder`
- `references/web-api.md` — 本地 Web API（form-urlencoded、轨迹过滤、cancelRequest、`.mrs` vs JSON 边界）
- `references/site-template.full.json` — 全量 V2 字段模板
- `references/practice/gbk-demo-source.json` — GBK 站点实战样本
- `references/refactor-beautify.md` — 书源重构与美化清单
- `references/convert-from-legado.md` — Legado → RWH 转换（CSS-first、正则差异、人工迁移边界）

## Examples

- “帮我给这个小说站写用心读书书源” / “给这个源写听书规则（type 4）”
- “这个书源正文取不到怎么排查？” / “正文下一页和下一章怎么避免串章？”
- “把 `.mrs` 转成 `.json`” → 明确说明无离线 `.mrs` 加解密算法，本地仅处理明文 `*.mrs.json`
- “Web API 怎么调试书源？” / “把这个阅读/Legado 书源转成用心书源”
