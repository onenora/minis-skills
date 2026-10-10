---
name: legado-sources
description: 当用户提到「阅读书源」「Legado」「Legado 书源」「写阅读源」时触发。注意区分：阅读/Legado ≠ 用心读书/Read With Heart ≠ 香色/Xiangse，三者书源格式互不兼容。只做 Legado/阅读 3.0 **文本书源（小说）**，兼容 iOS 阅读与安卓阅读，段评可选，视频/漫画/聚合/音视频不做。
---

# Legado Book Source

Only Legado（阅读 3.0）text novel sources (`bookSourceType: 0`)。跨 iOS 阅读 + 安卓阅读。Fail closed: 没有 legado-sim 全链路 + 官方 App 实测不报 `pass`。视频/漫画/音视频/聚合源一概不做。

## 书源骨架（数组交付）

交付物是 JSON **数组**，即使只有一个书源也必须数组包装（单对象无法导入）：

```json
[
  {
    "bookSourceUrl": "https://example.com",
    "bookSourceName": "Example",
    "bookSourceGroup": "小说::CSS",
    "bookSourceType": 0,
    "searchUrl": "https://example.com/search?q={{key}}",
    "ruleSearch":   { "bookList": "$.items[*]", "name": "$.title", "bookUrl": "$.url" },
    "ruleBookInfo": { "name": "$.title", "tocUrl": "$.tocUrl" },
    "ruleToc":      { "chapterList": "$.chapters[*]", "chapterName": "$.title", "chapterUrl": "$.url" },
    "ruleContent":  { "content": "$.content" }
  }
]
```

## 跨端硬约束（iOS + 安卓通用）

- `bookSourceType` 固定 `0`（文本）。不做音频(1)/图片(2)/文件(3)/视频(4)。
- **优先通用函数**：能用 CSS/JSONPath/`{{}}` 静态规则就不写 JS；必须写 JS 时用 `var` + 普通函数、ES5 语法，禁可选链/空值合并/`new Map()`（各端 Rhino 报错）。
- 避免 Android 专属桥（`java.put`/`java.get`/`Packages`）跨端不通用；iOS 阅读桥差异大，段评/JS 尽量收敛到通用函数并做能力检测。
- URL 后 JSON 选项（`{"charset":"gbk",...}`）里的 value 必须是 JS `String` 类型，计算值用 `String()` 强转（类型不对则“语法没错但实效”）。
- `bookInfoInit` 只能 AllInOne 正则（`: ` 开头）或 JS，返回 JSON 对象，详情字段按 key 取。

## 写源约束（小说）

- 顶层必填七字段：`bookSourceUrl`/`bookSourceName`/`searchUrl`/`ruleSearch`/`ruleBookInfo`/`ruleToc`/`ruleContent`。
- 子规则最低要求：`ruleSearch.bookList/name/bookUrl`；`ruleBookInfo.name/tocUrl`；`ruleToc.chapterList/chapterName/chapterUrl`；`ruleContent.content`。
- 可选按需：`bookSourceGroup`/`bookUrlPattern`/`header`/`loginUrl`/`loginCheckJs`/`enabledCookieJar`/`exploreUrl`/`ruleExplore`。发现页可加：`exploreUrl` 支持 `名称::URL` 多行/`&&`/JSON 数组带样式；`ruleExplore` 结构同 `ruleSearch`，但封面/书名字段常与搜索页不同，须逐页实测反推容器，禁止复用搜索规则。
- 字段命名与 Legado 源码一致，不新增私有顶层字段；`bookSourceComment` 默认不写调试说明（回修时才写）。
- 正文图片链接可附请求头：`src + "," + JSON.stringify(options)`。

## 规则语法要点

- 五种引擎：JSOUP Default / `@css:` / `@xpath:`/`//` / `@json:`/`$.` / 正则（`:`AllInOne、`##`净化）。连接：`&&`并集、`||`短路、`%%`交叉。
- `chapterList` 首字符 `-` 反序；`nextTocUrl` 支持单个 URL 或数组，JS 返回 `[]`/`null`/`""` 停止翻页——必须有明确停止条件防死循环。
- `{{}}`/JS 中可用 `book.name/author/bookUrl/tocUrl`、`chapter.url/title/baseUrl/index` 做相对链接补全与修正。
- `@put`/`@get` 仅用于非 JS 规则；`java.put`/`java.get` 仅用于 JS；混用不生效。
- `webView` 是官方正常能力（`{"webView":true}`），先于重型解密/签名复刻评估。

## 段评（可选）

分段注入 SVG/气泡徽标显示评论数，点击进 WebView 评论页。通用实现（跨 iOS/安卓）：

```jsonc
{
  "customButton": true, "eventListener": true,
  "jsLib": "function getComments(content,bookId,itemId){ var java=this.java; var sep=/<p>/.test(content)?'<p>':'\\n'; var arr=content.split(sep).map(function(s){return s.replace(/[\\r\\n]/g,'').trim();}); var c=JSON.parse(java.ajax('.../summary?book='+bookId+'&item='+itemId)).data; Object.keys(c).forEach(function(i){ if(arr[i]){ arr[i]+=svgBubble(c[i].count,bookId,itemId,i); } }); return arr.join(sep); }"
}
```

- 正文规则调用：`"content": "@js: getComments.call(this, 原正文, book.id, chapter.id)"`。
- `paragraphId` = 正文按 `<p>`/`\n` 切分后的 index，挂错段即对不上。
- 气泡用通用 `data:image/svg+xml;base64`；点击经 `eventListener` 调 `showCmt` → `java.showBrowser` 半屏评论页，URL 带 `bookId/itemId/para_index/count`，不把评论 JSON 塞进图片 URL。
- `ruleReview` 是 Legado 3.0 字段，但部分二改/iOS fork 已禁（丢弃），跨端可靠优先用 jsLib 通用路线。
- 本地评论页数据归一化：`id/name/avatar/text/images/emojiAssets/quote/meta/sub` 统一映射，明暗色自适应。

## 生成决策顺序

1. 先定登录分析 or 不登录分析
2. 稳定 API / JSON 直接完成
3. 稳定 HTML 直接完成
4. 切 `webView`（官方支持，先于重型方案）
5. 重型 JS / 解密 / 签名复刻

只要第 4 步未被排除，不轻易「不建议生成」。

## Convert and verify

依赖：Node.js（legado-sim.js）、Python 3（analyze_and_clean.py）。`scripts/` 相对本技能目录；书源与产物放在用户工作目录（或模型判断的合适位置），不要写进技能目录。

```bash
node scripts/legado-sim.js <书源.json>                          # 端到端: 搜索→详情→目录→正文
node scripts/legado-sim.js <书源.json> --search 关键词 --book 2  # 指定关键词/书序
node scripts/legado-sim.js <书源.json> --only search             # 只跑 search|detail|toc|content
node scripts/legado-sim.js <书源.json> --page 2 --chapter 5      # 翻页/章节
python3 scripts/analyze_and_clean.py <书源合集.json> [-o 输出目录]  # 批量去重/分组/风格标准化
```

Flow: 生成数组 JSON → legado-sim 端到端跑通 → 交付 `book-source.json` → 用户分别 iOS/安卓 App 实测。

legado-sim 覆盖 `<js>`/`@js:`/JSONPath/`{{}}`/`@get:`/`@post:`/`data:;base64,`/相对路径；HTML/CSS/XPath 部分支持（`@css:` 需 cheerio），复杂 HTML 源以 curl/python 为主。

## Delivery status

- `need_input`：缺 URL、缺书源文件、或未确认登录策略。
- `fail`：字段契约或 legado-sim 链路校验失败。
- `blocked`：反爬、登录墙、官方 App 不可用、或模拟过但未实测。
- `pass`：legado-sim 端到端通过 **且** 官方原版 App 实测（导入/搜索/详情/目录/正文，含目标 iOS 或安卓平台）。模拟不等于 `pass`。

## 调试协作

围绕阅读内置调试（调试搜索/详情/目录/正文）设计：让用户提供阶段性源码 `search_src`/`book_src`/`toc_src`/`content_src` + 截图 + 规则字段截图；App 崩溃补崩溃日志或 `logs.zip`。涉及用心读书/Web API 写源联 `heart-sources`。

## References

- `references/reference-source-patterns.md` — 小说站规则模式矩阵（P01–P26）与决策树
- `references/legado-official-rule-notes.md` — 官方规则摘录（URL 选项/类型/分页）
- `references/段评-integration.md` — 段评通用实现与本地评论页归一化
- `references/validation-checklist.md` — App 手工验收清单（iOS/安卓）
- `references/debugging-collaboration.md` — 调试证据收集
- `references/reference-sources/` — 本地小说参考样本

## Output

- 单站写源：`assessment.md` + `analysis.md` + `book-source.json` + `validation-checklist.md`。

## Examples

- “分析这个站并生成 Legado 小说书源”
- “给这个书源加段评”
- “这个书源导入失败，带我调试”
- “这个书源要能在 iOS 和安卓都用”
