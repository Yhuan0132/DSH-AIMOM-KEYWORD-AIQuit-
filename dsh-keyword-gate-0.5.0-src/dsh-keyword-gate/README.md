# dsh-keyword-gate

**DSH 关键词闸门**：真实使用者输入必须含指定关键词，才放行主模型；否则该轮不呼叫模型。

```
你发出指令
  ├─ 插件停用 / keywords 为空？ ──── 放行（安全设计，见下）
  ├─ 这条不是「人在说话」？ ──────── 放行（系统注入 / Goal 推进 / 子代理）
  ├─ 含关键词 或 bypass 词？ ─────── 放行 → 主模型正常工作
  └─ 都不满足 → 妈妈那句写成一条 **assistant 回覆泡泡**（补一个完整步骤），
                 再返回 {kind:'reject'}
                 turn 以 `blocked` 结束 · 主模型零呼叫 · 零 token
                 ├─ 坐标不可信 / 泡泡写不进？ → 退回用户侧 notice（不开步骤）
                 └─ notice 也写不进？        → 放行（fail-open，绝不吞掉消息）
                 （dryRun: true → 照常放行，同一条 notice 挂在这一轮前面）
```

## 原理：为什么可以这样做

DSH 的 `agent/pre-step` 是**模型执行前的否决权**（waterfall，`dsh-agent/lib/types/dispatch.d.ts`）。
它只接受两种决策（`runtime-types.d.ts:92-99`）：

```ts
export type PreStepDecision =
  | { kind: 'reject' }                                   // 拒绝拟进入的步骤
  | { kind: 'enter'; messages: UserMessage[];            // 替换进入步骤的消息
      startsRequestSeries?: true }
```

`reject` 在 loop 里的处理是明确的（`dsh-agent-loop/lib/index.js:958-961`）：

```js
if (decision.kind === "reject") { turnEnds = { kind: "blocked" }; return false; }
```

**turn 以 `blocked` 结束、不开启步骤、不呼叫模型**；被拒的输入是**丢弃**的
（`dsh-agent/lib/types/consumed-work.d.ts`），不会残留到下一轮被夹带进来。

所以「必须加特定词汇才放行」不但可行，而且是这个 hook **最便宜**的用法：
一次字符串比对，**不消耗任何 token**。

> 对比 [AIQuit](https://github.com/Jia-HuaWu/AIQuit)：同样挂 `agent/pre-step`，
> 但它为了判断工作量每轮要先花一次迷你 LLM 请求；本插件不做任何 LLM 呼叫，
> 确定性的、可离线测试。取向不同：它是「让 AI 自己决定要不要罢工」，
> 本插件是「按规则放行」。

## 三条硬设计（都有理由，不是偏好）

### ① 妈妈的话是一条**回覆泡泡**，写在对话里

`reject` 是**静默**的：界面上你只会看到自己的消息下面什么都没有，和「卡住」无法区分。
要让你看到一句话，就得往会话里写东西。

写什么有两种，本插件**按固定顺序尝试**，谁行谁上：

| 顺序 | 写法 | 长什么样 | 什么时候用 |
|---|---|---|---|
| 1 | `step/start → user/message → assistant/message → step/end` | **一条正常的 AI 回覆泡泡**（和模型回覆一模一样） | 默认 |
| 2 | `user/message` + `source.form='notice'` | 上下文节点 / notice 卡片（折叠行是摘要，展开是正文） | 拿不到可信的 `turn`/`step`，或 1 写失败 |
| 3 | 什么都不写，`next()` 放行 | — | 连 2 都写不进去（fail-open） |

第 1 条是本版的重点（0.5.0 起）。它补的就是内核 loop 自己那套步骤生命周期
（`dsh-agent-loop/lib/index.js`：`turn/start` 在 943 已由 loop 写好 → 968 `step/start`
→ 1061 `user/message` → 1144-1150 `assistant/message` → 992 `step/end`）：

```js
session.append('step/start', { turn, step })                       // 不先开步骤，
session.append('user/message', msg, { surfaceOp: 'append' })       // assistant/message 会被
session.append('assistant/message', {                              // invariant 判违规
  turn, step,
  message: { id, role: 'assistant', content: [{ type: 'text', text }],
             source: { kind: 'model', provider, model } },
  stream: [],                                                      // 必填：见下
}, { surfaceOp: 'append' })
session.append('step/end', { turn, step })
```

`turn`/`step` **直接取自 pre-step 载荷**（loop 在 954 行把坐标传进来），不猜、不自增。
于是这段话与正常轮次逐字同形：客户端按普通回覆渲染成泡泡，**刷新还在、导出还在、翻得回去**。
（`tools/kernel-contract.mjs` 会把这一串事件喂进**真的** `dsh-session` 再重载一次历史，
确认内核收得下、历史里那两条消息都在。）

为什么不会弄坏会话——写入前逐条校验**已知会崩读方的字段**，任一不满足就降级：

| 字段 | 缺了会怎样 | 出处 |
|---|---|---|
| `turn` / `step` 安全整数 | 读历史时位置解析失败 | AIQuit v1.0.0 的坑 |
| `message.content` 是数组 | `data.message.content.length` 崩 | AIQuit v1.0.0 的坑 |
| `stream` 是数组 | `dsh-token-meter` 的 `usageOf()` 读 `event.data.stream` 崩 | AIQuit v1.0.1 的坑 |
| 步骤必须先开 | `assistant/message` 要求「有开着的步骤」 | `dsh-session/lib/invariant.js:59-61` |

另外**被拦的那句话会被原样补回会话**（`echoBlocked`，默认开）。平台的语义是
「丢弃」（`inbox.claim()` 之后被拒的输入不会写进日志），不补的话那句话**永久消失**
——你刷新后就看不到自己刚才说过什么了。补回来的代价是：**下一轮模型会看到那句话**。

第 2 条（notice）的形状照抄内核自己的生产者（`dsh-agent/lib/index.js:133-147`
`modelSwitchNotice`、`dsh-plan-mode` 的 `narration`）：

```js
{ id, role: 'user', content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'keyword-gate', form: 'notice', summary } }
```

它是 **用户侧**消息，不冒充模型；好处是**不需要开启步骤**（`invariant.js:87` 对
`user/message` 直接 break），所以在坐标不可信时仍然可用。写入方式与
`dsh-agent-loop/lib/index.js:1061` 写「进入本步骤的用户消息」完全同一个调用。

> 更早的版本（≤0.3.x）用的是「SSE + 输入框上方浮动泡泡」，代价是刷新就没、也不进历史，
> 已整体移除。

### ② 没有配置关键词 = 闸门不生效

闸门会挡掉「请把你自己关掉」这句话——这是它的固有性质。若关键词配错或配空，
你就再也无法透过对话让 agent 帮忙关掉它。所以本插件刻意做成：
**`keywords` 为空 → 一律放行并印出警告**。配置错误的最坏结果是「闸门没用」，
而不是「锁死」。

### ③ 只拦真实使用者输入，且任何例外一律放行（fail-open）

真实输入与系统注入的分辨轴是 `MessageSource` 上的 `form`
（`dsh-llm/lib/types/message.d.ts:30-58`：`instructions` / `catalog` / `snapshot` /
`notice` / `relay` / `recall` 都是注入）。判错方向的代价**不对称**：

- 漏拦 → 闸门少挡一次，无所谓；
- 误拦 → Goal 自动推进或系统注入被挡下来，**整个会话停在那里**。

所以判不准就放行；判定抛错也放行。

## 上线顺序（照着做）

**第一步：`dryRun: true` 装上**（默认就是这个值），`keywords` 填你要的词。

```yaml
- insert:
    - id: keyword-gate
      name: dsh-keyword-gate
      config:
        enabled: true
        keywords: ['开工']
        bypass: ['!gate']
        dryRun: true
```

然后正常用一阵子：发几条消息、让 Goal 推进一次、让我调用技能。
观察 `http://127.0.0.1:<port>/keyword-gate/state.json` 的 `checked`：

- `checked` **只在你真的打字时才增加** → 判准正确，可以进第二步；
- 如果系统推进也让它增加 → 说明这个 DSH 版本的注入消息没带 `form`，
  此时**不要**关掉 dryRun（会卡死会话），先回来改判准。

dryRun 期间妈妈的话已经会以 notice 形式出现在对话里（摘要前面带 `[試跑]` 标记），
只是这一轮照常送进主模型——正好可以确认「写得进去、显示得对」。

**第二步：改 `dryRun: false`** 开始真拦。没带关键词的消息不再送进主模型
（turn 记为 `blocked`、零 token），但你会**在对话里看到妈妈那句回覆泡泡**
（`replyStyle: 'assistant'`，默认），它还会把刚才没被接住的那句话原样补在泡泡前面。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 完全不拦 |
| `keywords` | `[]` | **空 = 闸门不生效**（安全设计）。**子字串**命中即放行 |
| `backup` | `['1']` | 备用通道：**行首控制项**命中即放行 |
| `bypass` | `['!gate']` | 逃生门：**子字串**命中即放行 |
| `replies` | 内置五句 | 拒绝语库（见下节） |
| `caseSensitive` | `false` | 是否区分大小写 |
| `dryRun` | `true` | 只记录不拦截：这一轮照常进主模型，但妈妈的话仍会以 notice 挂进对话（摘要带 `[試跑]`）。**第一次上线保持 true** |
| `replyStyle` | `'assistant'` | 拦截时怎么说话：`assistant` = 回覆泡泡（默认）；`notice` = 只写用户侧 notice 卡片 |
| `echoBlocked` | `true` | 被拦的那句话要不要原样补回会话。`false` = 不补（它会永久消失，因为平台的语义是丢弃） |

### 三条通道的比对方式刻意不同

| 通道 | 比对 | 例子 | 为什么 |
|---|---|---|---|
| `keywords` | 子字串 | `媽媽` 出现在任何位置都算 | 关键词是自明的词，混在句子里很正常（「媽媽，帮我改文件」） |
| `backup` | **行首控制项** | `1` ／ `1 帮我改文件` 通过；`1.0`、`2026年1月`、`第1章` **不通过** | 备用口令短到只有一两个字元，若用子字串，凡是带数字 1 的句子都会通关——**闸门等于废掉** |
| `bypass` | 子字串 | `!gate` | 带 `!` 前缀，撞词机率极低，当逃生门用 |

放行时会在 `state.json` 的 `lastVerdict` 写明是**哪条通道**放行的
（`放行（有关键词）` / `放行（备用通道 1）` / `放行（bypass）`），便于事后审计。

## 妈妈的回覆（默认五句）

拦截时从拒绝语库里**随机**挑一句（不连续重复），**写成一条 assistant 回覆泡泡进对话历史**：

> **你（被拦的原话，`echoBlocked` 补回来的）**
> 帮我改一下这个文件
>
> **AI（妈妈那句，脚本挑的，不是模型生成）**
> 哎唷，連一聲「媽媽」都不叫，我怎麼知道是你在跟我說話呢？先叫一聲，媽這就幫你看。

它是 `role: 'assistant'` + `source.kind: 'model'` 的消息（和真回覆同形），所以客户端
按普通回覆渲染；刷新、翻历史、导出都还在。`replyStyle: 'notice'` 时改走用户侧 notice
卡片（折叠行是摘要，展开是正文＋刚才没接住的那句）。

内置五句（母亲慈爱、委婉拒绝）：

| # | 回覆 |
|---|---|
| 1 | 哎唷，連一聲「媽媽」都不叫，我怎麼知道是你在跟我說話呢？先叫一聲，媽這就幫你看。 |
| 2 | 孩子啊，媽不是不幫你——是你連門都沒敲。叫我一聲「媽媽」，我馬上進廚房。 |
| 3 | 這麼大的事，你倒是先叫我一聲「媽媽」呀。媽的心一直在這兒等著呢。 |
| 4 | 媽年紀大了，耳朵不好使。你叫一聲「媽媽」，我才聽得清你要什麼。 |
| 5 | 別急，先叫一聲「媽媽」。媽又不是外人，怎麼會不幫你呢。 |

有一条**设计性质**写在自检里钉住：**每一句都必须自己把关键词说出来**。
这是提示，不是嘲讽——用户看完就知道该补什么，不必去翻 README。

改法：在 **profile 的 `cordis.patch.yml`** 里覆盖（profile 层应用在 bundle 层之后，
所以重装/升级插件不会把你改的句子冲掉）：

```yaml
- id: keyword-gate
  config:
    replies: ['你自己的第一句', '你自己的第二句']
```

> 对比 [AIQuit](https://github.com/Jia-HuaWu/AIQuit)：它把拒绝语放在
> `talking/baozao.txt`、`talking/luoli.txt`，首次启动自动复制到 `$DSH_HOME/talking/`。
> 这里改成配置项，理由是：**本插件不写任何文件**（见设计①）、不必碰 `node_modules`、
> 而且 profile 层覆盖天然能在重装后存活。

### 手写 `assistant/message` 的风险，以及这里怎么控制它

真回覆如果走「自己造一条模型消息」，需要在 `agent/pre-step` 里手写完整的
`assistant/message`。权威形状是 `dsh-agent-loop/lib/index.js:1136-1150`：

```js
session.append("assistant/message", {
  turn, step,
  message: createAssistantMessage({ content, source: { provider, model } }),
  stream: live.stream,          // 没有模型呼叫时是 []
}, { surfaceOp: "append" })
```

绕过 loop 自己拼这些字段，少任何一个都可能让该会话历史**永久**打不开
（AIQuit 就是这样坏过两次的，见其 README「已知问题与修复」）。

0.5.0 起本插件**走了这条路**（使用者要求「像 AIQuit 那样有回覆泡泡」），代价用三层控制：

1. **坐标只从载荷读**（`payload.turn`/`payload.step`）并检查是非负安全整数——
   缺了、形状不对就**不写**，退回 notice；
2. **写入前逐条验形状**（`message.content` 数组、`stream` 数组、`role`、`source.kind`），
   不合格就不写；
3. **失败降级顺序写死**：泡泡 → 同一步骤内的 notice → 独立 notice → fail-open 放行；
   步骤一旦开了，无论后面成功失败都会尽力 `step/end`（日志绝不停在「步骤开着」）。

再加上 `tools/kernel-contract.mjs`：把这一串事件喂进**解包出来的真内核**
`dsh-session`，并且**重新载入一次历史**，确认内核收得下、派生历史里那两条消息都在。

`dryRun: true`（不拦截）时 notice 是**用户侧**消息，会被一起送进主模型——
那是试跑模式的本意（让模型也知道你漏了关键词），真拦模式下它根本不产生请求。

## 怎么关掉（四层，从易到难）

1. 消息里带 `bypass` 词（默认 `!gate`）——单次放行；
2. 改 profile 的 `dryRun: true`——**照常放行，只在对话里留一句妈妈的提醒**；
3. 改本插件 `cordis.patch.yml` 的 `enabled: false`——连提醒都不再有；
4. 把 `keywords` 改成 `[]`——闸门立即不生效。

## 已知限制

- **被拦的那句话会回到会话里**（`echoBlocked: true`，默认），所以它**不会被遗忘**：
  下一轮模型看得到它。若你不希望模型看到，把它设成 `false`——代价是那句话
  在日志里永久消失（平台的语义是丢弃，不是排队）。
- **回答我的提问也会被拦**（`ask_user_question` 的回答同样是使用者输入）——
  回答时也要带关键词，或用 bypass 词。这是刻意的严格，但你得知道。
- 授权弹窗（approval）走 UI 动作，推测不受影响（**未验证**）。
- 只拦**根 agent**；子代理与 Goal 自动推进不受影响（判准 + fail-open 双保险）。
- **写不进对话就放行**：`payload.agent.session.append` 不存在或抛错（版本差异）时，
  插件会 fail-open 放行并在 `state.json` 的 `lastVerdict` 写明原因——
  宁可少拦一次，也不要静默吞掉你的消息（自检 F 节钉住这条）。
- **回覆泡泡依赖本版内核的坐标契约**：`payload.turn`/`payload.step` 不存在或不是
  安全整数时，插件不会硬写（那会写坏历史），而是自动退回 notice。所以升级 DSH 后
  若泡泡忽然变成 notice 卡片，先看 `state.json` 的 `lastVerdict`（会写明 `bad-coords`）。
- `replyStyle: 'notice'` 时的排版由 `dsh-client-ui-chat` 决定：折叠行 = 摘要，
  展开 = 正文。换了客户端皮肤/视图后观感可能不同。

## 自检

```powershell
node tools/selftest.mjs          # 118 项，纯离线，不碰内核
node tools/kernel-contract.mjs   # 17 项，把事件喂进真的 dsh-session（找不到内核就 SKIP）
```

`selftest.mjs` 不需要 DSH 进程、不需要重启、不消耗 token。118 项覆盖：核心判定
（含关键词/bypass/大小写）、六种注入 form 不误拦、fail-open（含「什么都写不进」）、
锁死保护、dryRun、统计、备用通道的行首语义，以及**写入路径的每一层**：

- 事件序列逐项（`step/start` → `user/message` → `assistant/message` → `step/end`，
  坐标、`surfaceOp`、`role`、`source.kind`、回覆文本来自脚本）；
- 用**迷你不变量机**重放整段序列（把 loop 的 `turn/start`/`turn/end` 一起放进去），
  验证「步骤开着、编号正确、turn 正确闭合」；
- 契约字段三条（`turn`/`step` 安全整数、`stream` 数组、`message.content` 数组）；
- 降级链：坐标不可信 → notice；`assistant/message` 写失败 → 步骤内 notice 顶上；
  `step/start` 失败 → 独立 notice；全失败 → 放行；
- 静态约束：不发 `session/event`、不写 `turn/start`（那是 loop 的）、坐标只从载荷读、
  写入前先验形状、不写文件、不往页面注入脚本。

`kernel-contract.mjs` 是「真内核收不收」这一层的证明：它用解包出来的
`@deepseek-ai/dsh-session` 建会话、让插件照着写、再**重新载入一次历史**，
断言派生历史里正好是「你说的那句 + 妈妈的回覆」。内核目录用
`--kernel <dir>` 或环境变量 `DSH_KERNEL` 指定（`<dir>` 里要有
`@deepseek-ai/dsh-session/lib/index.js`）。

## 来源与致谢

| 部分 | 出处 |
|---|---|
| **原理与踩坑参考** | [Jia-HuaWu/AIQuit](https://github.com/Jia-HuaWu/AIQuit)（「爷不干了」）—— 同样挂 `agent/pre-step` 做「模型执行前否决」的 DSH 外挂；「把拒绝语写成一条回覆」这条路的示范 |
| **平台契约** | DeepSeek Harness 内核源码：`dsh-agent/lib/types/dispatch.d.ts`（hook 声明）、`dsh-agent/lib/types/runtime-types.d.ts:92-99`（`PreStepDecision` 两种决策）、`dsh-agent-loop/lib/index.js:911-924`（pre-step 载荷带 `turn`/`step`）、`:943`（loop 先写 `turn/start`）、`:954-961`（`reject` → turn 记 `blocked`）、`:968/:992/:1027`（step/start、step/end、turn/end）、`:1061`（`user/message` + `surfaceOp:'append'`）、`:1136-1150`（`assistant/message` 的形状）、`dsh-agent/lib/types/consumed-work.d.ts`（被拒输入为丢弃）、`dsh-llm/lib/types/message.d.ts:30-58`（`MessageSource.form` 与六种注入形式） |
| **「写进对话」这条路** | 内核自己的生产者与校验：`dsh-agent/lib/index.js:133-147`（`modelSwitchNotice`）、`dsh-plan-mode/lib/index.js:395-411`（`narration`）、`dsh-agent/lib/index.js:193-204`（把消息追加进 pre-step 决策的官方写法）、`dsh-session/lib/invariant.js:30-61,87`（步骤/turn 约束、`assistant/message` 必须有开着的步骤、`user/message` 不受约束）、`dsh-session/lib/index.js:1441-1475`（`append` 与 `surfaceOp`） |

**本插件没有复制 AIQuit 的任何代码。** 只引用了它 README 里公开记载的**原理与两个踩坑教训**
（缺 `turn`/`step`、缺 `stream` 都会让该会话历史**永久**打不开，且升级救不回）——
这两点各自变成一条硬约束：**写入前验形状**、**失败就降级而不硬写**。

特此写明，是因为 AIQuit 仓库**未声明任何授权**（`license: null`）——所以「只借鉴思路、
不复制代码」在这里不只是礼貌，也是必要的。

另外这里**刻意不用** AIQuit 早期版本那个 `{kind:'enter', messages:[]}` 技巧：它自己的 README
记载了，在缺少对应分支的 DSH 版本上那招会**真的发起模型请求**（正是闸门要避免的事）。
本插件只用官方明确处理的 `{kind:'reject'}`——本版 loop 第 958 行专门为它留了分支。

## 许可

MIT（见 `package.json`）。本插件不含任何素材，所以没有素材授权问题；拒绝文案只是配置里
几个字（现在是写进对话的一条 notice），随你改。
