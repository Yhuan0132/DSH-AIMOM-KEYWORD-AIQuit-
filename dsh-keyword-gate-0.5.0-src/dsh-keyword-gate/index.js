/**
 * dsh-keyword-gate —— 关键词闸门
 *
 * 原理：DSH 的 `agent/pre-step` 是**模型执行前的否决权**。挂在这个 waterfall 上，
 * 就能在「步骤开启、模型被呼叫」之前决定放行还是拒绝——拒绝时**主模型零呼叫**，
 * 只有一个数字（0 token）的开销：一次字符串比对。
 *
 * 与 AIQuit 的差别（两者用同一个 hook，但取向不同）：
 *   AIQuit   先花一次迷你 LLM 请求给工作量打分，再决定要不要罢工。
 *   本插件   不做任何 LLM 呼叫——只看消息里有没有关键词。确定、可离线测试、零 token。
 *
 * ── 三条硬设计（都来自源码/实测，不是偏好）───────────────────────────────
 *
 * ① **妈妈的话是一条真正的回覆泡泡，写进对话历史。**
 *    `{kind:'reject'}` 本身是静默的：turn 以 `blocked` 结束、不开启步骤
 *    （dsh-agent-loop/lib/index.js:958-961），界面上什么都看不到，和「卡住」无法区分。
 *
 *    所以拦截时本插件**自己把这一轮的步骤补齐**，顺序与内核 loop 完全相同
 *    （dsh-agent-loop:943 turn/start 已经由 loop 写好；然后 968 step/start、
 *     1061 user/message、1144-1150 assistant/message、992 step/end）：
 *
 *      step/start {turn, step}                     ← 不先开步骤，assistant/message 会被
 *                                                    invariant 判违规（invariant.js:59-61）
 *      user/message ×N   （被拦的使用者讯息原样补回，否则它会消失）
 *      assistant/message { turn, step, message, stream: [] }   ← 妈妈那句話
 *      step/end {turn, step}
 *
 *    `turn`/`step` 直接取自 pre-step 载荷（loop 在 954 行传进来的坐标），
 *    所以写出来的事件与正常轮次逐字同形——客户端把它当作普通回覆渲染成泡泡，
 *    刷新还在、导出还在、翻得回去。
 *
 *    **绝不凭记忆拼事件**：写入前逐条校验形状（turn/step 是非负安全整数、
 *    `stream` 是数组、`message.content` 是数组、`message.role` 是 assistant、
 *    `source.kind` 非空）。任一不满足就退回 ② 的 notice，再不行就 fail-open
 *    放行——AIQuit 正是因为漏了 `turn`/`step`（v1.0.0）与 `stream`（v1.0.1）
 *    而让会话历史永久打不开过两次。
 *
 * ② **有备用显示路径，且顺序固定：回覆泡泡 → notice → 放行。**
 *    如果本版内核的坐标/形状对不上（写作失败），就退回「用户侧 notice」
 *    （`user/message` + `source.form='notice'`，这条不需要开启步骤，
 *    invariant.js:87 对 user/message 直接 break）；连这条都写不进去，
 *    就 fail-open 放行。**宁可少拦一次，也不要静默吞掉使用者的消息。**
 *    配置 `replyStyle: 'notice'` 可以直接指定走 ②。
 *
 * ③ **没有配置关键词 = 闸门不生效。**
 *    闸门会挡掉「请把你自己关掉」这句话——这是它的固有性质。若关键词配错/配空，
 *    使用者就再也无法透过对话让 agent 帮忙关掉它。所以这里刻意做成：
 *    关键词表为空 → 直接放行一切并印出警告。配置错误的最坏结果是「闸门没用」，
 *    而不是「锁死」。另外还有两条逃生门：`backup`（行首控制项）与 `bypass`。
 *
 * ④ **只拦真实使用者输入，而且任何例外一律放行（fail-open）。**
 *    真实输入与系统注入的分辨轴是 `MessageSource` 上的 `form`
 *    （instructions/catalog/snapshot/notice/relay/recall 都是注入）。
 *    判错方向的代价不对称：**漏拦**只是闸门少挡一次；**误拦**会把 Goal 自动推进
 *    或系统注入挡下来，整个会话就停在那里。所以判不准就放行。
 */
import { randomUUID } from 'node:crypto'

export const name = 'keyword-gate'
export const inject = ['webServer']

const ROUTE = '/keyword-gate'

/** 已知的注入形式（`MessageSource.form`）。命中即视为「不是人在说话」。 */
const CONTEXT_FORMS = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']

/**
 * notice 折叠行那行摘要的长度上限。内核自己也是这个数
 * （`dsh-llm/lib/types/message.js` `CONTEXT_SUMMARY_MAX_CHARS = 120`）。
 */
const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * 默认拒绝语库——「母亲慈爱、委婉拒绝」。
 * 每条都必须**自己把关键词说出来**：这是提示，不是嘲讽；用户看完就知道该补什么。
 * 配置里给了 `replies` 就整组覆盖（建议写在 profile 的 cordis.patch.yml 里，
 * 那样重装插件不会把你自己改的句子冲掉）。
 */
const DEFAULT_REPLIES = [
    '哎唷，連一聲「媽媽」都不叫，我怎麼知道是你在跟我說話呢？先叫一聲，媽這就幫你看。',
    '孩子啊，媽不是不幫你——是你連門都沒敲。叫我一聲「媽媽」，我馬上進廚房。',
    '這麼大的事，你倒是先叫我一聲「媽媽」呀。媽的心一直在這兒等著呢。',
    '媽年紀大了，耳朵不好使。你叫一聲「媽媽」，我才聽得清你要什麼。',
    '別急，先叫一聲「媽媽」。媽又不是外人，怎麼會不幫你呢。',
]

/** 从消息里取出纯文本（内容块数组里只挑 text 块）。 */
function textOf(message) {
    const content = message && message.content
    if (typeof content === 'string') { return content }
    if (!Array.isArray(content)) { return '' }
    let out = ''
    for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') { out += block.text + '\n' }
    }
    return out
}

/**
 * 这条消息是不是「真人在说话」。
 * 判准刻意保守：只要带任何注入标记就当作不是人，宁可漏拦也不误拦。
 */
function isHumanInput(message) {
    if (!message || message.role !== 'user') { return false }
    const source = message.source
    if (!source || typeof source !== 'object') { return false }
    if (CONTEXT_FORMS.indexOf(source.form) >= 0) { return false }   // 注入的上下文
    // kind 是可合并扩展的联合：已知的 model/system-prompt 放行其中 model 一类，
    // 其余未知 kind 一律视为「不是人」（保守）。
    if (source.kind !== undefined && source.kind !== 'model' && source.kind !== 'user') { return false }
    return true
}

/** 折叠行摘要按内核的上限截断（`CONTEXT_SUMMARY_MAX_CHARS`）。 */
function boundSummary(text) {
    return text.length <= CONTEXT_SUMMARY_MAX_CHARS
        ? text
        : `${text.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * 一条消息够不够格被补写回会话：`id` 是非空字串、`content` 是数组。
 * 这是客户端渲染时的硬需求（`String(event.data.id)`、`message.content`），
 * 形状不对就宁可少补一条，也不写坏事件。
 */
function isEchoableMessage(message) {
    return !!message && typeof message === 'object'
        && typeof message.id === 'string' && message.id.length > 0
        && message.role === 'user'
        && Array.isArray(message.content)
}

/**
 * `assistant/message` 的载荷是否满足契约。照抄 `dsh-agent-loop/lib/index.js:1144-1150`
 * 的写法，逐条检查**已知会崩读方的字段**：
 *   - `turn`/`step` 必须是安全整数（否则 dsh-session 读历史时位置解析失败）；
 *   - `stream` 必须是数组（否则 dsh-token-meter 的 `usageOf()` 在 `usage` 缺失时
 *     读 `event.data.stream`（`lastAssistantStreamChunk()`）会崩——AIQuit v1.0.1 的坑）；
 *   - `message.content` 必须是数组（否则 `data.message.content.length` 崩——v1.0.0 的坑）。
 */
function isContractAssistantEvent(data) {
    return !!data && typeof data === 'object'
        && Number.isSafeInteger(data.turn) && data.turn >= 0
        && Number.isSafeInteger(data.step) && data.step >= 1
        && Array.isArray(data.stream)
        && !!data.message && typeof data.message === 'object'
        && data.message.role === 'assistant'
        && Array.isArray(data.message.content)
        && !!data.message.source && typeof data.message.source === 'object'
        && typeof data.message.source.kind === 'string' && data.message.source.kind.length > 0
}

export function apply(ctx, config) {
    const cfg = config || {}
    const log = (msg, err) => {
        if (err) { ctx.logger?.warn?.(`keyword-gate: ${msg}`, err) }
        else { ctx.logger?.warn?.(`keyword-gate: ${msg}`) }
    }
    const info = (msg) => ctx.logger?.info?.(`keyword-gate: ${msg}`)

    const list = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim() !== '') : []
    const keywords = list(cfg.keywords)
    const backup = list(cfg.backup)
    const bypass = list(cfg.bypass)
    const replies = list(cfg.replies).length > 0 ? list(cfg.replies) : DEFAULT_REPLIES
    const caseSensitive = cfg.caseSensitive === true
    const dryRun = cfg.dryRun === true
    const gateOff = cfg.enabled === false
    /** 'assistant'（默认，写成回覆泡泡）或 'notice'（用户侧 notice 卡片）。 */
    const replyStyle = cfg.replyStyle === 'notice' ? 'notice' : 'assistant'
    /** 是否把被拦的使用者讯息补写回会话（不补就永久消失：平台语义是丢弃）。 */
    const echoBlocked = cfg.echoBlocked !== false

    const stats = {
        checked: 0, passed: 0, blocked: 0, bypassed: 0, backedUp: 0, shown: 0, bubbles: 0, notices: 0,
        lastAt: 0, lastPreview: '', lastVerdict: '', lastReply: '', lastShown: '',
        keywords: keywords.length, backup: backup.length, bypass: bypass.length, replies: replies.length,
        dryRun, replyStyle, echoBlocked, enabled: !gateOff && keywords.length > 0,
    }
    // 拒绝语轮换：不连续重复（同一条连发两次会显得像坏掉，跟桌宠的变体轮换同一个道理）
    let lastReplyIdx = -1
    function pickReply() {
        const n = replies.length
        if (n === 0) { return '' }
        if (n === 1) { return replies[0] }
        let i = lastReplyIdx
        let guard = 0
        while (i === lastReplyIdx && guard < 20) { i = Math.floor(Math.random() * n); guard++ }
        lastReplyIdx = i
        return replies[i]
    }

    function matches(text, needles) {
        if (needles.length === 0) { return false }
        const hay = caseSensitive ? text : text.toLowerCase()
        for (const needle of needles) {
            const n = caseSensitive ? needle : needle.toLowerCase()
            if (hay.indexOf(n) >= 0) { return true }
        }
        return false
    }

    /**
     * 备用通道：**行首控制项**，不是子字串。
     *
     * 为什么不能用子字串：备用口令是「1」这种极短的字串，子字串比对会让
     * 「1.0 的版号」「2026年1月」「第1章」全部通关——闸门等于废掉。
     * 所以这里要求 token 出现在**开头**，且后面紧跟空白或字串结束：
     *   通过：`1` ／ `1 帮我改文件`
     *   拦下：`1.0` ／ `2026年1月` ／ `第1章` ／ `帮我改 1 次`
     * @returns 命中的那个 token，没命中回 null（用于审计：看得出是哪条通道放行的）
     */
    function matchesLeading(text, tokens) {
        if (tokens.length === 0) { return null }
        for (const token of tokens) {
            const t = caseSensitive ? token : token.toLowerCase()
            const hay = caseSensitive ? text : text.toLowerCase()
            const head = hay.replace(/^\s+/, '')
            if (t === '') { continue }
            if (head === t) { return token }
            if (head.startsWith(t)) {
                const next = head.charAt(t.length)
                if (next === ' ' || next === '\t' || next === '\n' || next === '\r') { return token }
            }
        }
        return null
    }

    /**
     * 造一条「妈妈说的话」——**用户侧的 notice，不是模型消息**：
     *   - `role: 'user'` + `source.kind: 'plugin'` → 客户端按上下文节点渲染（不当成用户自己说的话）；
     *   - `source.form: 'notice'` + `source.summary` → 走 notice 卡片，折叠行就是妈妈那句；
     *   - `id` 是必须的（客户端渲染会读 `String(event.data.id)`）。
     * 形状与内核自己的 `modelSwitchNotice()` / plan-mode 的 `narration()` 一致。
     * @param reply - 妈妈挑中的那一句。
     * @param preview - 被拦内容的摘要（让用户知道刚才哪句没被接住）。
     * @param dryRunMode - 试跑时在摘要前加标记，免得把「没拦」误读成「拦了」。
     * @returns 一条可直接进会话历史的 user 消息。
     */
    function noticeMessage(reply, preview, dryRunMode) {
        const body = preview
            ? `${reply}\n\n（剛才那句我沒接住：${preview}）`
            : reply
        return {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: body }],
            source: {
                kind: 'plugin',
                plugin: 'keyword-gate',
                form: 'notice',
                summary: boundSummary(dryRunMode ? `[試跑] ${reply}` : reply),
            },
        }
    }

    /**
     * 造 `assistant/message` 的完整载荷——**这就是「回覆泡泡」**。
     * 形状逐字对照 `dsh-agent-loop/lib/index.js:1144-1150`：
     * `{ turn, step, message, stream }`，其中 `message` 是 `createAssistantMessage()`
     * 的产物（`{ id, role: 'assistant', content, source: { kind: 'model', provider, model } }`）。
     * 没有模型呼叫，所以 `stream` 是空数组——但它**必须存在**（见 {@link isContractAssistantEvent}）。
     */
    function assistantEvent(reply, turn, step, agent) {
        const options = (agent && agent.options) || {}
        return {
            turn,
            step,
            message: {
                id: randomUUID(),
                role: 'assistant',
                content: [{ type: 'text', text: reply }],
                source: {
                    kind: 'model',
                    provider: typeof options.provider === 'string' ? options.provider : 'deepseek',
                    model: typeof options.model === 'string' ? options.model : 'deepseek-chat',
                },
            },
            stream: [],
        }
    }

    /** 把一条消息写进会话历史（`user/message` 必须带 `surfaceOp: 'append'`）。 */
    function appendMessage(session, message) {
        session.append('user/message', message, { surfaceOp: 'append' })
    }

    /**
     * 补一个完整的步骤，把妈妈那句话当成**正常的模型回覆**写进对话：
     *
     *   step/start → user/message（被拦的原话）→ assistant/message（妈妈那句）→ step/end
     *
     * 顺序与内核 loop 一模一样（见文件头①的引用）；`turn/start` 已由 loop 写好，
     * 所以这里**不碰**它。任何一步失败都不会让日志停在「步骤开着」的状态：
     * 关步骤是尽力而为的，失败就如实记在返回值里交给调用方决定。
     *
     * @returns `{ delivered, usedBubble, reason }`；`delivered: true` 表示妈妈那句话
     *   已经进了对话（不管是 assistant 泡泡还是同一步骤里的 notice 顶替），
     *   调用方就不该再写第二条。
     */
    function writeReplyBubble(agent, turn, step, reply, echo, preview) {
        const miss = (reason) => ({ delivered: false, usedBubble: false, reason })
        const session = agent && agent.session
        if (!session || typeof session.append !== 'function') { return miss('no-session') }
        const event = assistantEvent(reply, turn, step, agent)
        if (!isContractAssistantEvent(event)) { return miss('bad-shape') }

        try {
            session.append('step/start', { turn, step })
        } catch (err) {
            // 步骤没开成 = 什么都还没写，调用方可以安全地继续往后备路径走。
            log('开启步骤失败，改走后备路径', err)
            return miss('step-start-failed')
        }

        // 被拦的原话补回去——不补的话它会永久消失（平台的语义是丢弃，不是排队）。
        for (const message of echo) {
            try { appendMessage(session, message) } catch (err) { log('补写被拦的使用者讯息失败', err) }
        }

        let usedBubble = true
        try {
            session.append('assistant/message', event, { surfaceOp: 'append' })
        } catch (err) {
            usedBubble = false
            log('写回覆泡泡失败，改用 notice 顶上', err)
        }
        let usedNotice = false
        if (!usedBubble) {
            // 同一个步骤里换一种说法：至少让使用者看到一句（notice 是用户侧消息，
            // 不受步骤约束，写在这里同样合法）。
            try {
                appendMessage(session, noticeMessage(reply, preview, false))
                usedNotice = true
            } catch (e2) { log('notice 也写不进去', e2) }
        }

        try {
            session.append('step/end', { turn, step })
        } catch (err) {
            log('关闭步骤失败（这一轮的事件序列可能不完整）', err)
            return { delivered: usedBubble || usedNotice, usedBubble, reason: 'step-end-failed' }
        }
        return { delivered: usedBubble || usedNotice, usedBubble, reason: usedBubble ? 'ok' : 'assistant-failed' }
    }

    /**
     * 后备路径：把 notice 写进会话历史——形状与内核写用户消息的调用完全相同
     * （`dsh-agent-loop/lib/index.js:1061`：`session.append('user/message', message, { surfaceOp: 'append' })`）。
     * 它不需要开启步骤（`invariant.js:87` 对 user/message 直接放行），所以
     * 「坐标不可信」时这条路仍然可用。写不进去就回 false，调用方 fail-open 放行。
     */
    function appendNotice(agent, message) {
        try {
            const session = agent && agent.session
            if (!session || typeof session.append !== 'function') { return false }
            appendMessage(session, message)
            return true
        } catch (err) {
            log('把妈妈的话写进对话失败', err)
            return false
        }
    }

    // ───────────────────────── 闸门本体 ─────────────────────────
    if (gateOff) {
        info('已按配置停用（config.enabled === false），一律放行')
    } else if (keywords.length === 0) {
        // 这是安全设计：配置错误的最坏结果是「闸门没用」，不是「锁死」。
        log('没有配置 keywords → 闸门不生效，一律放行。'
            + '（若这里改成「空关键词就全拦」，用户就再也无法透过对话要求关掉它）')
    } else {
        info(`已启用：关键词 ${keywords.length} 个、bypass ${bypass.length} 个`
            + `${caseSensitive ? '、区分大小写' : ''}${dryRun ? '、**dryRun（只记录不拦截）**' : ''}`
            + `；拒绝时写一条 ${replyStyle === 'assistant' ? 'assistant 回覆泡泡' : 'notice'} 进对话历史`)
    }

    ctx.on('agent/pre-step', async (payload, next) => {
        try {
            if (gateOff || keywords.length === 0) { return next() }
            const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
            const humans = messages.filter(isHumanInput)
            if (humans.length === 0) { return next() }      // 系统注入 / Goal 推进 / 子代理 → 放行
            const text = humans.map(textOf).join('\n')
            if (text.trim() === '') { return next() }

            stats.checked++
            if (matches(text, keywords)) {
                stats.passed++
                stats.lastVerdict = '放行（有关键词）'
                return next()
            }
            const viaBackup = matchesLeading(text, backup)
            if (viaBackup !== null) {
                stats.backedUp++
                stats.passed++
                stats.lastVerdict = `放行（备用通道 ${viaBackup}）`
                return next()
            }
            if (matches(text, bypass)) {
                stats.bypassed++
                stats.passed++
                stats.lastVerdict = '放行（bypass）'
                return next()
            }

            stats.blocked++
            stats.lastAt = Date.now()
            stats.lastPreview = text.slice(0, 100).replace(/\s+/g, ' ')
            const reply = pickReply()
            stats.lastReply = reply
            const notice = noticeMessage(reply, stats.lastPreview, dryRun)

            if (dryRun) {
                // 试跑：照常放行进主模型，只是**多挂一条 notice**——
                // 用的就是内核自己扩展决策的办法（把消息追加进 decision.messages，
                // 见 dsh-agent/lib/index.js:200-203）。
                const decision = await next()
                if (!decision || decision.kind === 'reject') { return decision }
                const kept = Array.isArray(decision.messages) ? decision.messages : []
                stats.shown++
                stats.notices++
                stats.lastShown = reply
                stats.lastVerdict = '本该拦截（dryRun，已在对话显示）'
                return { ...decision, messages: [...kept, notice] }
            }

            // 真拦，第一步（也是默认）：把妈妈那句写成**回覆泡泡**。
            // turn/step 直接取自 pre-step 载荷；缺少或形状不对就不走这条路
            // （绝不猜坐标——写错坐标会让该会话历史打不开）。
            const turn = payload && payload.turn
            const step = payload && payload.step
            const coordsOk = Number.isSafeInteger(turn) && turn >= 0 && Number.isSafeInteger(step) && step >= 1
            let bubbleReason = ''
            if (replyStyle === 'assistant') {
                if (coordsOk) {
                    const echo = echoBlocked ? humans.filter(isEchoableMessage) : []
                    const result = writeReplyBubble(payload.agent, turn, step, reply, echo, stats.lastPreview)
                    if (result.delivered) {
                        stats.shown++
                        if (result.usedBubble) { stats.bubbles++ } else { stats.notices++ }
                        stats.lastShown = reply
                        stats.lastVerdict = result.usedBubble
                            ? '已拦截（回覆泡泡已写进对话）'
                            : `已拦截（回覆泡泡不可用：${result.reason}，已在步骤内改用 notice）`
                        log(`已拦截：${stats.lastPreview} → ${reply}`)
                        return { kind: 'reject' }
                    }
                    bubbleReason = result.reason
                    // 什么都还没写（或只写了一个已关好的空步骤）→ 继续往下走 notice 是安全的。
                } else {
                    bubbleReason = 'bad-coords'
                }
            }

            // 真拦，后备路径：用户侧 notice（不需要 turn/step）。
            // 写不进去就放行（fail-open），不让使用者的消息无声消失。
            if (!appendNotice(payload && payload.agent, notice)) {
                stats.lastVerdict = '本想拦截，但 notice 写不进对话 → 放行（fail-open）'
                log(`${stats.lastVerdict}：${stats.lastPreview}`)
                return next()
            }
            stats.shown++
            stats.notices++
            stats.lastShown = reply
            stats.lastVerdict = bubbleReason === ''
                ? '已拦截（notice 已写进对话）'
                : `已拦截（回覆泡泡不可用：${bubbleReason}，改用 notice）`
            log(`已拦截：${stats.lastPreview} → ${reply}`)
            // turn 以 `blocked` 结束：不呼叫模型、无 token 消耗。
            return { kind: 'reject' }
        } catch (err) {
            // fail-open：闸门自己出错时绝不能把会话卡住
            log('判定出错，放行（fail-open）', err)
            return next()
        }
    })

    // ───────────────────────── 观测端点（不写会话事件，只读计数）─────────────────────────
    const sendJson = (res, code, body) => {
        const text = JSON.stringify(body)
        res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(text),
            'Cache-Control': 'no-store',
        })
        res.end(text)
    }

    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${ROUTE}/state.json`, handler: (req, res) => {
        sendJson(res, 200, stats)
    } }))

    info(`已挂载（状态 ${ROUTE}/state.json；拒绝时把妈妈的话写成回覆泡泡进对话历史）`)
}
