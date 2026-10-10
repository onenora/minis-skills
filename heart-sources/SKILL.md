---
name: heart-sources
description: 当用户提到「用心读书」「用心书源」「Read With Heart」「ParsingBook」时触发。注意区分：用心读书/Read With Heart ≠ 阅读/Legado ≠ 香色/Xiangse，三者书源格式互不兼容。用于生成、修复、转换、调试用心读书书源。
---

# Read With Heart Book Source（AI 自动写源）

只做用心读书（Read With Heart / ParsingBook）文本小说源（`type: 1`）与听书源（`type: 4`），V2 规则。Fail closed：结构自检 + 页面样本四链路实测通过才交付，官方 App 实测前不报 `pass`。

## 书源骨架（顶层对象）

```json
{
  "type": 1, "siteName": "站点", "version": 1, "host": "https://example.com/",
  "ruleSearch":   { "mode":"http", "engine":"xpath", "method":"GET", "url":"/search?keyword=@{keyword}", "bookList":"//*[@class='list']/*", "bookName":".//a/text()", "bookUrl":".//a/@href" },
  "ruleBookInfo": { "mode":"http", "engine":"xpath", "method":"GET", "chapterListUrl":"" },
  "ruleChapter":  { "mode":"http", "engine":"xpath", "method":"GET", "chapterList":"//*[@id='chapterlist']/li", "chapterName":".//a/text()", "chapterUrl":".//a/@href" },
  "ruleContent":  { "mode":"http", "engine":"xpath", "method":"GET", "contents":"//*[@id='content']/text()" }
}
```

- 顶层是对象（非数组）。`siteName`/`host` 必填，`version` 数字递增（可为 0）。`type`：`1`=文本小说（默认），`4`=听书，`0`=通用/默认引擎（真实源在跑）；漫画/短剧不在本技能范围。
- 规则段公共字段：`mode`(http/webview) `engine`(xpath/jsonpath/css) `method`(GET/POST) `url` `params` `header` `preRequests` `request` `response` `requestEncode` `responseEncode` `forbidCookie` `forbidSSL` `filterErrorCodes`。

## 字段合同

| 段 | 必填（官方最小集） | AI 写源建议（不强制） |
|---|---|---|
| ruleSearch | url / bookList | bookName、bookUrl、bookAuthor、aliasName、ruleExtra.*、pageMax |
| ruleBookInfo | （可为空，空则沿用搜索信息） | bookName、bookAuthor、chapterListUrl、toolsUrl、importUrl、ruleExtra.* |
| ruleChapter | chapterList | chapterName、chapterUrl、chapterTime、page、next |
| ruleContent | contents | cleaner、page、next、commentUrl、**playUrl** |

- 官方校验仅要求：search=url+bookList、chapter=chapterList、content=contents，且**至少存在一个规则段**；其余字段（含 bookName/bookUrl/chapterName/chapterUrl）官方不强制。AI 写源仍按建议列写全。

- 听书源：`type` 取 `4`（真实书源在跑）或官方 schema 的 `2`（听书），以 App 实际为准；`ruleContent.playUrl` **必填**，提取音频地址（jsonpath 可深度递归如 `$..content`；相对地址自动按 host 补全）；`contents` 可给文本/歌词（可空）；音频需要请求头时写在 `ruleContent.header`（官方：playUrl 为空时用正文 URL 与正文 Header）。搜索/详情/目录结构与文本源一致，可用 `request @js:` 改 `config.url/params` 区分音书类型（参考源 `tab_type`）。

- `aliasName`：又名/原名；非空时按 `bookName OR aliasName` 匹配并作显示名。
- 子字段必须相对列表节点：`.//a/text()`、`.//a/@href`。
- 旧字段禁项：`baseUrl`→`host`；`list`→`chapterList`；`name`→`chapterName`；`url`（章节旧名）→`chapterUrl`（等效兼容，优先新名）；`lines`→`contents`；`encode`→区分 `requestEncode`/`responseEncode`；`imageUrl`→`coverUrl`（官方标废弃）。

## V2 协议硬约束（最易错）

1. **表达式**：`${key}` 未匹配→**保留原文**（且支持 V2 算术/拼接表达式 `${pageIndex + 1}`、`${host + "/api"}`）；`@{key}` 未匹配→**置空**；`<js>return value;</js>` 字段级后处理（参数 `value`+`config`，**不能用于 request/response**）；`@js:` 仅用于 `request`/`response`（响应参数 `html`+`config`）；`@all` 跳基础解析直接给原文；**`@tools{fn(...)}` 工具函数**：`timestamp / timestampMs / formatTime(fmt) / urlEncode / urlDecode / base64Encode / base64Decode / md5 / sha256 / uuid / random(min,max)`。`##a` 过滤、`##a#b` 替换一次、`##a##b` 全局、`##^.*?id=(\d+).*$##$1` 捕获组。执行顺序（官方实现）：基础规则/`@all` → 变量替换 `@get→${}→@{}→@tools` → `{{}}` 提取 → `<js>` → `##正则`；`{{}}` 按内容前缀 `{`/`[` 自动选 jsonpath，否则 xpath。字段级 `<js>`/`##` 也可按原文从左到右逐步传值；JS 失败回退上一步结果；正则编译失败保留输入。
2. **Header 二选一非合并**：场景 header 非空时公共 `header` 不补入，必须在场景 header 写全所需字段。Cookie 优先级：请求显式 Cookie > `loginCookies` > HTTP 缓存；`forbidCookie:true` 关闭自动注入（显式 Cookie 仍生效）。
3. **地址传递**：搜索 `bookUrl`→详情 `config.infoUrl`→`config.url`；详情 `chapterListUrl`→章节 `config.bookUrl`→`config.url`（为空回退详情地址）；章节 `chapterUrl`→正文 `config.chapterUrl`→`config.url`。`infoUrl/bookUrl/chapterUrl` 是跨场景上下文地址，改一个不同步其他；`config.url` 只是当前首屏地址。分页：章节 `config.nextUrl` 优先（空用 bookUrl），正文 `config.chapterUrl` 优先（空用 url）；改分页入口只改对应地址字段。`bookUrl`/`chapterUrl` 可只解析 ID，目标场景 `request @js:` 用 `config.infoUrl`/`config.chapterUrl` 重建真实 URL；`request @js:` 内可直接给跨场景字段赋值（如 `config.chapterListUrl = config.infoUrl`）。
4. **request/response JS**：`request @js:` 改请求配置（可改 `config.url`/`config.host/params/header` 及跨场景地址字段，最终按 `config.host` 补全地址）；`response @js:` 用 `html`+`config` 预处理原始响应；Document 子集 v2.6.0+（`document.select("css")` 数组/`title()`/`attr()`）；规则/响应/前置 JS 可用全局 `get(key)`/`put(key,val)`（见 protocol §1）读写存储，新代码优先 `@get{}`。
5. **前置请求**：`preRequests[]` 每项：`url`(必填)、`method`、`mode`、`header`、`params`、`request`、`response{engine, put, respones}`（官方拼写是 **respones**）、`preRequestType`(0 常规/1 浏览器过盾/2 图片验证码)、`forbidCookie`、`forbidSSL`、`forbidRedirect`、`filterErrorCodes`、`domains`。自动保存 `preUrlN`/`preResHeaderN`/`preRepHeaderN`；过盾后 `verifyHeader`/`verifyCookies`；验证码注入 `config.verifyCode`。正式请求用 `@get{key}`（支持对象子路径 `@get{info.name}`）读取。header 继承：首个前置有自己的则用之，否则回退公共；后续继承上一步上下文。
6. **toolsUrl / commentUrl（V2）**：支持 直接 URL / 相对 URL / 同步或异步 `@js:`（`await app.get/post`，等待上限 30s，读存储用 `app.sp.get`，无裸 `getValue`）/ URL+尾随 Header / `{url, header}` / `@html:` / `{html, baseURL}`。返回对象 `header` 覆盖场景 header 同名。HTML 模式只保证 Cookie，Auth/UA/Token 不自动用于子资源。
7. **URL**：相对地址按运行时 `config.host` 自动补全；返回 `#` 或与原文相同视为空地址；图片 URL 附头：`value + ', {"header":{"Referer":"...","User-Agent":"..."}}'`；跨域收集 Cookie：URL 后追加 `{"domains":["a.com","b.org"]}`。
8. **正文富文本**：格式 `---CATALOG---` 章节标题 + `---CONTENT---` 正文（HTML/CSS/图片/段评/批注）。`<img>` 必须自闭合，网络图/网络 SVG 必须显式 `width`+`height`（否则分页不稳），`ident` 可点击跳 WebView；`src`/`ident` 可尾随 `,{"header":{...}}`（**单引号** JSON，避免与 HTML 双引号冲突；iOS 的 Cookie 头受 `HTTPCookieStorage` 接管，用自定义头验证）。`<comment ident count />`：`count` 须解析为 >0 整数才显示按钮，点击优先于翻页。`<note>` 批注：自闭合、`text` 必填（缺失整标签静默忽略）、remote(默认) 要 `ident`(URL)、manual 要 `id`、`label` 左红块、`autoHeight="true"` 自适应。服务端下发相对路径的段评标签（`ident="/p?para=..."`、`src="/chapter_review/svg..."`）时，书源在 content `<js>` 中拼 host；段评开关可用 openParams + URL 参数（如 `review=1`）控制。
9. **Native 函数**（App/app/APP 别名等价，另有底层桥 `OS`/`OSDocument`/`OSSocket`）：哈希 `md5`/`sha1..sha512`；`base64.encode/decode/decodeToBytes`；`aes.encrypt/decrypt(data,key,iv)`；`rsa.encrypt(data,pub)/decrypt(data,pri)`；**`bcrypt.genSalt(rounds)/hash(pwd,salt)`**；`nlp.chs/cht`；`string.toGBK/toUTF8`；`strToBytes/bytesToStr`；`time(unix,'yyyy-MM-dd HH:mm:ss')`；`uuid`；`sp.put/get/delete`（put 支持 String/Number/Object/Array/Date，禁 null/undefined/Function；按 siteIdent 隔离持久化）；**`setTimeout/clearTimeout`**；`post/get({url,params,header,timeout})`（Promise，必须 `await`；底层 code 0 成功/401 缺参/402 网络/408 超时；响应含 `responseBody/requestHeader/responseHeader/cookie`）；`socket(url, protocols, headers)`（`open/text/binary/error/close/push/finished`）；`doc(html,clean)`；`handleError`；`showDialog`；`toast`（type 拼写 `succee`）；`log`。**CryptoJS 内置**（加载顺序 prototype.js→crypto.min.js→common.js→publicJavascript，无需导入）；V2 JS 超时 30s（前置 `@js:` 同样 30s；V1 120s）。
10. **openParams**：定义 `name/key/value/defaultValue/type(input|single|multiple)/options`；运行时 `config.openParams` 是 `[String:String]` 扁平字典（多选逗号分隔，JS 里 `config.openParams.key` 是字符串不是对象）；写回 `window.ParsingBook.setOpenParamValue(key,v)`/`setOpenParamValues({...})`，HTML 事件用 `@setOpenParams('k','v')`。
11. **分页**：`page` 并发（URL 页码明确）vs `next` 串行（页面下一页链接）。「下一页」≠「下一章」：next 规则限定链接文本含「下一页/下页/继续阅读」，排除「下一章/下章/返回目录」；URL 形态 `123_2.html`(同章) vs `124.html`(下一章)。
12. **发现（如用）**：顶层 `ruleFinder` 为数组，每项 `uuid`(分类ID) + `name` + `structure`(URL 模板，支持 `@{_类型}`/`${pageIndex}`) + `list`(筛选器列表 `{type,name,list}`，list 为 `[{name,value}]` JSON 串)；`list` 内再用 `bookList/bookName/bookUrl/bookAuthor` 提取书籍。读筛选当前值用 `config.selectList`(数组，推荐) 或 `config.filters`(字典) 或 `config._<type>`(旧习惯)；候选项 list 不通过 selectList 暴露；筛选项 value 逐项实弹，0 结果的剔除。

## 生成决策

1. 采样真实 HTTP 页面（服务端直出，勿信 DevTools 快照/浏览器 DOM）。
2. 稳定 API/JSON → JSONPath；稳定 HTML → XPath/CSS；再考虑前置请求/过盾/webview。
3. 能用静态规则就不写 JS；必须 JS 时用 `<js>`/`@js:`，公共逻辑放 `publicJavascript`。
4. webview 是官方正常能力，先于重型解密/签名复刻评估。
5. 正文清洗固定顺序（防误删）：去 HTML 标签 → 实体转义(&nbsp; &amp; &#\d+;) → 行内空白/空行整理 → 行首独立章节标题行 → 需简繁时 `App.nlp.chs()`（try/catch）。
6. 签名/时间/拼接先固定输入自测：与官方文档示例逐字符一致；时间毫秒 `>1e12` 转秒。

## Convert and verify

依赖：Python 3、Node.js。`scripts/` 相对本技能目录；书源与产物放在用户工作目录（或模型判断的合适位置），不要写进技能目录。

```bash
python3 scripts/source-check.py <书源.json>   # 必填字段 + 旧字段 + 引擎/分页警告；退出码 0 PASS / 1 strict-warn / 2 FAIL
node scripts/heart-verify.js <书源.json> --keyword 关键词   # jsonpath 类源模拟链路（搜索→详情→目录→正文→发现+筛选）；xpath 源走页面样本
```

页面样本验证顺序（不可跳级）：单独列表规则 → 列表节点内子字段 → URL 拼接 → 正文节点 → cleaner → next/page。听书源另验：`playUrl` 解析出的音频地址可访问（HTTP 200 / `audio/*`），需要请求头时 `ruleContent.header` 生效。未验证分页必须标注风险。

App 开启 Web API（设置→开发者选项）后可用本地接口自动化调试：`POST http://localhost:8080/api/site/{search,bookinfo,chapter,content}`，详见 `references/web-api.md`。

## Delivery status

- `need_input`：缺站点 URL、缺样本页面、或搜索策略未确认。
- `fail`：source-check FAIL 或字段合同违反。
- `blocked`：反爬/登录墙、页面不可达、或官方 App 未实测。
- `pass`：source-check PASS **且** 页面样本四链路（搜索/详情或目录/章节/正文 + 分页/清洗）实测通过 **且** 官方 App 实测通过。任一环节未验证必须标注风险，模拟不等于 `pass`。

## References

- `references/protocol.md` — 协议细节表：config 键总表 / toolsUrl·commentUrl 支持形式 / 前置请求字段表 / Native 方法表 / 富文本标签属性表 / openParams / loginUrl `@html:` 参数
- `references/web-api.md` — 本地 Web 写源接口速查（管理 + 调试，ResponsesModel）
- `references/site-template.full.json` — 全量字段模板
- `references/practice/gbk-demo-source.json` — GBK 站点实战样本
- `references/refactor-beautify.md` — 已有书源重构/美化（抽公共 JS、签名等价自测、正文清洗、发现板块合并）
- `references/convert-from-legado.md` — 阅读/Legado 书源 → RWH 字段/选择器/JS 映射

## Examples

- “帮我给这个小说站写用心读书书源”
- “这个书源正文取不到怎么排查？”
- “搜索是 POST 的站点怎么写？”
- “需要先获取 token 的书源怎么设计？”
- “给这个源的正文加段评/批注/图片”
- “Web API 怎么保存书源？”
- “common.js 有哪些函数？”
- “重构这个用心书源：抽公共 JS、简化字段”
- “把这个阅读/Legado 书源转成用心书源”