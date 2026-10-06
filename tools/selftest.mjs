/**
 * keyword-gate 自检 —— 不需要 DSH 进程、不需要重启、不消耗任何 token。
 *
 * 为什么必须离线测：宿主插件是启动时 import 的，改 index.js 不会热重载；
 * 而且这个插件的**判错方向代价不对称**——漏拦只是少挡一次，
 * 误拦会把系统注入/Goal 推进挡下来让会话停住。所以判准要有测试钉住。
 *
 * 这一版钉的是「妈妈的话怎么进对话」，一共三层：
 *   ① 回覆泡泡：`step/start → user/message → assistant/message → step/end`
 *      （坐标取自 pre-step 载荷、`stream` 是数组、`message.content` 是数组）；
 *      并用 §D 的迷你不变量机重放整段序列，确认它满足内核 invariant 的步骤约束。
 *   ② 后备 notice：坐标不可信或泡泡写不进去时改走 `user/message + form='notice'`。
 *   ③ fail-open：连 notice 都写不进去 → 放行，绝不静默吞掉使用者的消息。
 *
 * 用法：node tools/selftest.mjs
 */
import { readFileSync } from 'node:fs'

const INDEX = new URL('../index.js', import.meta.url)
const mod = await import(INDEX.href)

let pass = 0
const fails = []
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label) }
    else { fails.push(label); console.log('  FAIL ' + label + (detail === undefined ? '' : '   [' + detail + ']')) }
}

function makeCtx() {
    const listeners = new Map()
    const routes = []
    const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        webServer: { register(r) { routes.push(r); return () => {} } },
        effect(f) { return f() },
        on(name, fn) {
            if (!listeners.has(name)) { listeners.set(name, []) }
            listeners.get(name).push(fn)
            return () => {}
        },
    }
    return { ctx, listeners, routes }
}

/**
 * 起一个闸门实例；返回「喂 payload → 拿决策」的函数与观测面。
 * @param opts.noSession - 模拟「载荷里没有 agent.session」，验 fail-open。
 * @param opts.failAppend - 模拟 session.append 一律抛错，验 fail-open。
 * @param opts.failAppendOn - 只让某几种事件类型抛错，验分层降级。
 * @param opts.noCoords - 载荷里不带 turn/step（模拟坐标不可信）。
 */
function gate(config, opts = {}) {
    const { ctx, listeners, routes } = makeCtx()
    mod.apply(ctx, config)
    const handler = (listeners.get('agent/pre-step') || [])[0]
    const appended = []
    const agent = opts.noSession ? {} : {
        session: {
            append(type, data, surfaceOpts) {
                if (opts.failAppend) { throw new Error('append refused') }
                if (Array.isArray(opts.failAppendOn) && opts.failAppendOn.indexOf(type) >= 0) {
                    throw new Error('append refused for ' + type)
                }
                appended.push({ type, data, surfaceOpts })
                return { seq: appended.length, type, data }
            },
        },
        options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    }
    const next = async () => ({ kind: 'enter', messages: [{ role: 'user' }] })
    const run = (payload) => {
        if (payload === null || payload === undefined) { return handler(payload, next) }
        const withAgent = payload.agent ? payload : { ...payload, agent }
        if (opts.noCoords || withAgent.turn !== undefined || withAgent.step !== undefined) {
            return handler(withAgent, next)
        }
        // 正常轮次里 loop 一定会带坐标进来（dsh-agent-loop:954）。
        return handler({ ...withAgent, turn: 1, step: 1 }, next)
    }
    return { run, routes, listeners, appended, agent }
}

/** 造一条「真人输入」消息。 */
const human = (text, id) => ({
    id: id || ('u-' + text), role: 'user',
    content: [{ type: 'text', text }], source: { kind: 'model' },
})
/** 造一条「系统注入」消息（带 form）。 */
const injected = (text, form) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'system-prompt', form } })

const CFG = { enabled: true, keywords: ['开工'], bypass: ['!gate'] }
/** 读 state.json。 */
function readState(routes) {
    const state = routes.find(x => x.path === '/keyword-gate/state.json')
    let body = ''
    state.handler({ url: '/keyword-gate/state.json', method: 'GET' }, { writeHead() {}, end(b) { body = String(b) } })
    return JSON.parse(body)
}

/**
 * 迷你不变量机：只实现本插件会碰到的那几条规则，逐条抄自
 * `dsh-session/lib/invariant.js`（turn/start:30-34、turn/end:35-40、
 * step/start:41-46、step/end:50-55、assistant/message:59-61、
 * user/message:87「不受步骤约束」）。回传 null 表示通过，否则是失败原因。
 *
 * 为什么要在这里重放：`assistant/message` **必须在开着的步骤里**（否则历史读不了），
 * 而步骤的编号必须正好是内核预期的下一个——这两条只有按顺序重放才验得出来。
 */
function replayKernelInvariant(events) {
    let openTurn = null, openStep = null, nextTurn = 1, nextStep = 1
    for (const e of events) {
        const d = e.data || {}
        switch (e.type) {
            case 'turn/start':
                if (openTurn !== null) { return `turn/start ${d.turn} while turn ${openTurn} is still open` }
                if (d.turn !== nextTurn) { return `turn/start expected turn ${nextTurn}, got ${d.turn}` }
                openTurn = d.turn; nextStep = 1; break
            case 'turn/end':
                if (openTurn !== d.turn) { return `turn/end ${d.turn} does not match open turn ${openTurn}` }
                if (openStep !== null) { return `turn/end ${d.turn} while step ${openStep} is still open` }
                openTurn = null; nextTurn += 1; break
            case 'step/start':
                if (openTurn !== d.turn) { return `step/start in turn ${d.turn} but open turn is ${openTurn}` }
                if (openStep !== null) { return `step/start ${d.step} while step ${openStep} is still open` }
                if (d.step !== nextStep) { return `step/start expected step ${nextStep}, got ${d.step}` }
                openStep = d.step; break
            case 'step/end':
                if (openStep !== d.step || openTurn !== d.turn) { return `step/end ${d.turn}/${d.step} without matching open step` }
                openStep = null; nextStep += 1; break
            case 'assistant/message':
                if (openStep === null) { return 'assistant/message without an open step' }
                if (d.turn !== openTurn || d.step !== openStep) { return `assistant/message at ${d.turn}/${d.step} but open step is ${openTurn}/${openStep}` }
                break
            case 'user/message': break
            default: break
        }
    }
    return null
}

console.log('A. 核心判定')
{
    const g = gate(CFG)
    const allow = await g.run({ messages: [human('开工 帮我改这个文件')] })
    check('含关键词 → 放行（回到默认 enter）', allow && allow.kind === 'enter', JSON.stringify(allow))
    const deny = await g.run({ messages: [human('帮我改这个文件')] })
    check('不含关键词 → 拒绝', deny && deny.kind === 'reject', JSON.stringify(deny))
    const byp = await g.run({ messages: [human('!gate 帮我改这个文件')] })
    check('bypass 词 → 放行', byp && byp.kind === 'enter', JSON.stringify(byp))
}
{
    const g = gate({ ...CFG, keywords: ['KAIGONG'], caseSensitive: false })
    const r = await g.run({ messages: [human('kaigong now')] })
    check('默认不区分大小写', r.kind === 'enter')
    const g2 = gate({ ...CFG, keywords: ['KAIGONG'], caseSensitive: true })
    const r2 = await g2.run({ messages: [human('kaigong now')] })
    check('caseSensitive=true 时区分大小写', r2.kind === 'reject')
}

console.log('\nB. 不误拦（判错方向的代价不对称）')
{
    const g = gate(CFG)
    for (const form of ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']) {
        const r = await g.run({ messages: [injected('系统注入内容', form)] })
        if (r.kind !== 'enter') { check(`注入 form=${form} → 放行`, false, JSON.stringify(r)) }
    }
    check('六种注入 form 全部放行（Goal 推进/技能目录/运行态快照）', true)
    check('非 user 角色 → 放行', (await g.run({ messages: [{ role: 'assistant', content: [] }] })).kind === 'enter')
    check('未知 source.kind → 放行（保守，宁可漏拦）',
        (await g.run({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'future-thing' } }] })).kind === 'enter')
    check('没有 source → 放行', (await g.run({ messages: [{ role: 'user', content: [] }] })).kind === 'enter')
    check('空 messages → 放行', (await g.run({ messages: [] })).kind === 'enter')
    check('payload 是 null → 放行', (await g.run(null)).kind === 'enter')
    check('messages 不是数组 → 放行', (await g.run({ messages: 'oops' })).kind === 'enter')
    check('纯空白文本 → 放行', (await g.run({ messages: [human('   \n  ')] })).kind === 'enter')
    // fail-open：判定过程中抛错也必须放行，绝不能把会话卡住
    const boom = { role: 'user', source: { kind: 'model' }, get content() { throw new Error('boom') } }
    check('判定抛错 → fail-open 放行', (await g.run({ messages: [boom] })).kind === 'enter')
}

console.log('\nC. 锁死保护与 dryRun')
{
    const g = gate({ enabled: true, keywords: [], bypass: [] })
    check('keywords 为空 → 一律放行（配置错误的最坏结果是闸门没用）',
        (await g.run({ messages: [human('任意内容')] })).kind === 'enter')
    const g2 = gate({ ...CFG, enabled: false })
    check('enabled=false → 一律放行', (await g2.run({ messages: [human('任意内容')] })).kind === 'enter')
    check('enabled=false 时一个会话事件都不写', g2.appended.length === 0, JSON.stringify(g2.appended.length))
}
{
    const g = gate({ ...CFG, dryRun: true })
    const r = await g.run({ messages: [human('没有关键词的内容')] })
    check('dryRun → 不拦截（放行）', r.kind === 'enter')
    check('dryRun 仍然把妈妈的话挂进这一轮的决策（对话里看得到）',
        Array.isArray(r.messages) && r.messages.some(m => m && m.source && m.source.form === 'notice'),
        JSON.stringify(r).slice(0, 160))
    check('dryRun 不自己写会话事件（交给内核写）', g.appended.length === 0, String(g.appended.length))
    const s = readState(g.routes)
    check('dryRun 仍记下「本该拦截」', s.blocked === 1 && s.lastVerdict.indexOf('dryRun') >= 0, JSON.stringify(s))
    check('state.json 报告 dryRun=true', s.dryRun === true)
    check('state.json 报告已显示 1 次', s.shown === 1, JSON.stringify(s))
}
{
    const g = gate({ ...CFG, dryRun: true })
    const r = await g.run({ messages: [human('没有关键词的内容')] })
    const notice = r.messages.find(m => m && m.source && m.source.form === 'notice')
    check('dryRun 的摘要带 [試跑] 标记（免得把「没拦」误读成「拦了」）',
        notice.source.summary.indexOf('[試跑]') === 0, notice.source.summary)
}

console.log('\nD. 真拦时的事件序列（回覆泡泡 = 内核同款步骤生命周期）')
{
    const g = gate(CFG)
    await g.run({ messages: [human('开工')] })          // 放行
    const deny = await g.run({ messages: [human('乱来')] })   // 拦
    const sBlocked = readState(g.routes)                // 拦完立刻读（后面 bypass 会盖掉结论）
    await g.run({ messages: [human('!gate 乱来')] })    // bypass
    const s = readState(g.routes)
    check('checked=3', s.checked === 3, JSON.stringify(s))
    check('passed=2（含 1 次 bypass）', s.passed === 2 && s.bypassed === 1, JSON.stringify(s))
    check('blocked=1', s.blocked === 1, JSON.stringify(s))
    check('记录了被拦内容的摘要', s.lastPreview.length > 0 && s.lastPreview.length <= 100, s.lastPreview)
    check('拦截时回传官方决策 reject', deny.kind === 'reject', JSON.stringify(deny))

    check('一次拦截正好写 4 个事件（不多不少）', g.appended.length === 4, JSON.stringify(g.appended.map(e => e.type)))
    const types = g.appended.map(e => e.type)
    check('顺序是 step/start → user/message → assistant/message → step/end',
        types.join(',') === 'step/start,user/message,assistant/message,step/end', types.join(','))

    const [start, echo, assistant, end] = g.appended
    check('step/start 用载荷给的坐标 {turn:1, step:1}',
        start.data.turn === 1 && start.data.step === 1, JSON.stringify(start.data))
    check('step/start 不带 surfaceOp（内核自己也是这么写的）', start.surfaceOpts === undefined, JSON.stringify(start.surfaceOpts))
    check('step/end 的坐标与 step/start 一致',
        end.data.turn === start.data.turn && end.data.step === start.data.step, JSON.stringify(end.data))

    check('回覆泡泡是 assistant/message', assistant.type === 'assistant/message')
    check('回覆泡泡带 surfaceOp=append',
        assistant.surfaceOpts && assistant.surfaceOpts.surfaceOp === 'append', JSON.stringify(assistant.surfaceOpts))
    check('回覆泡泡的 role=assistant（这是「模型回覆」那一格）', assistant.data.message.role === 'assistant')
    check('回覆泡泡的 source.kind=model（客户端按模型回覆渲染）', assistant.data.message.source.kind === 'model')
    check('回覆泡泡的 provider/model 取自 agent.options',
        assistant.data.message.source.provider === 'deepseek-official' && assistant.data.message.source.model === 'deepseek-flash',
        JSON.stringify(assistant.data.message.source))
    check('回覆泡泡的正文就是妈妈挑中的那句（脚本，不是模型生成）',
        typeof assistant.data.message.content[0].text === 'string' && assistant.data.message.content[0].text.length > 0,
        JSON.stringify(assistant.data.message.content))
    check('回覆泡泡在 state.json 里算 bubbles', sBlocked.bubbles === 1 && sBlocked.notices === 0, JSON.stringify(sBlocked))
    check('state.json 的结论写明写了回覆泡泡', sBlocked.lastVerdict.indexOf('回覆泡泡') >= 0, sBlocked.lastVerdict)

    check('被拦的原话被补写回会话（否则它会永久消失）',
        echo.type === 'user/message' && echo.data.content[0].text === '乱来', JSON.stringify(echo.data).slice(0, 120))
    check('补写的原话带 surfaceOp=append', echo.surfaceOpts && echo.surfaceOpts.surfaceOp === 'append')

    // 最硬的一条：把 loop 自己写的 turn/start、turn/end 一起重放，验证步骤生命周期合法
    const stream = [
        { type: 'turn/start', data: { turn: 1 } },
        ...g.appended,
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } },
    ]
    const bad = replayKernelInvariant(stream)
    check('整段序列通过内核 invariant（步骤开着、编号正确、turn 正确闭合）', bad === null, String(bad))
}
{
    // 坐标不该猜：载荷没带 turn/step → 不走泡泡，改走 notice（notice 不受步骤约束）
    const g = gate(CFG, { noCoords: true })
    const r = await g.run({ messages: [human('乱来')] })
    check('没有坐标 → 仍然拦截', r.kind === 'reject', JSON.stringify(r))
    check('没有坐标 → 只写一条 user/message notice（不开步骤）',
        g.appended.length === 1 && g.appended[0].type === 'user/message', JSON.stringify(g.appended.map(e => e.type)))
    check('没有坐标 → state.json 写明原因',
        readState(g.routes).lastVerdict.indexOf('bad-coords') >= 0, readState(g.routes).lastVerdict)
}
{
    // 形状不对的坐标（非整数 / step=0）同样不该被写进会话
    for (const [turn, step, why] of [[1, 0, 'step=0'], [1.5, 1, 'turn 非整数'], ['1', 1, 'turn 是字串'], [-1, 1, 'turn 负数']]) {
        const g = gate(CFG, { noCoords: true })
        const r = await g.run({ turn, step, messages: [human('乱来')] })
        check(`坐标 ${why} → 不开步骤、只写 notice`, r.kind === 'reject' && g.appended.length === 1
            && g.appended[0].type === 'user/message', JSON.stringify(g.appended.map(e => e.type)))
    }
}

console.log('\nE. 契约字段（三条会让会话历史永久打不开的读取路径）')
{
    const g = gate(CFG)
    await g.run({ messages: [human('乱来一次')] })
    const ev = g.appended.find(e => e.type === 'assistant/message').data
    check('turn/step 是非负安全整数（历史位置解析）',
        Number.isSafeInteger(ev.turn) && ev.turn >= 0 && Number.isSafeInteger(ev.step) && ev.step >= 1, JSON.stringify(ev).slice(0, 80))
    check('stream 是数组（缺了会让 token-meter 的 usageOf 崩 —— AIQuit v1.0.1 的坑）',
        Array.isArray(ev.stream), typeof ev.stream)
    check('没有模型呼叫 → stream 是空数组（语义正确）', ev.stream.length === 0, String(ev.stream.length))
    check('message.content 是数组（缺了会让 dsh-session 读历史崩 —— v1.0.0 的坑）',
        Array.isArray(ev.message.content))
    check('message.id 是非空字串', typeof ev.message.id === 'string' && ev.message.id.length > 0)
    check('content 首块是 text 块', ev.message.content[0].type === 'text')

    await g.run({ messages: [human('乱来两次')] })
    const ev2 = g.appended.filter(e => e.type === 'assistant/message')[1].data
    check('两条回覆泡泡的 id 不相同（不会互相顶掉）', ev.message.id !== ev2.message.id)
    check('正文里没有 HTML 注入面（纯文本进 content）', ev.message.content[0].text.indexOf('<') < 0)
}
{
    const g = gate({ ...CFG, replies: ['自訂的一句'] })
    await g.run({ messages: [human('乱来')] })
    check('配置给了 replies 就整组覆盖默认',
        g.appended.find(e => e.type === 'assistant/message').data.message.content[0].text === '自訂的一句')
}

console.log('\nF. 分层降级：泡泡 → notice → fail-open')
{
    // ① 泡泡写不进去（assistant/message 抛错）→ 同一个步骤里用 notice 顶上，步骤照样关好
    const g = gate(CFG, { failAppendOn: ['assistant/message'] })
    const r = await g.run({ messages: [human('乱来')] })
    check('assistant/message 写失败 → 仍然拦截（不 fail-open）', r.kind === 'reject', JSON.stringify(r))
    const types = g.appended.map(e => e.type)
    check('失败时序列仍然是 step/start → user/message(原话) → user/message(notice) → step/end',
        types.join(',') === 'step/start,user/message,user/message,step/end', types.join(','))
    const lastUser = g.appended.filter(e => e.type === 'user/message').pop()
    check('顶上的 note 是 notice 卡片（form=notice）',
        lastUser.data.source && lastUser.data.source.form === 'notice', JSON.stringify(lastUser.data.source))
    const bad = replayKernelInvariant([{ type: 'turn/start', data: { turn: 1 } }, ...g.appended, { type: 'turn/end', data: { turn: 1 } }])
    check('降级后的序列依然合法（步骤没有开着不收）', bad === null, String(bad))
    check('state.json 记下泡泡不可用', readState(g.routes).lastVerdict.indexOf('assistant-failed') >= 0, readState(g.routes).lastVerdict)
}
{
    // ② step/start 就失败 = 什么都还没写 → 退回独立 notice（不开步骤）
    const g = gate(CFG, { failAppendOn: ['step/start'] })
    const r = await g.run({ messages: [human('乱来')] })
    check('step/start 失败 → 退回 notice 并拦截', r.kind === 'reject', JSON.stringify(r))
    check('退回后只写了一条 notice', g.appended.length === 1 && g.appended[0].type === 'user/message',
        JSON.stringify(g.appended.map(e => e.type)))
}
{
    // ③ 什么都写不进去 → fail-open 放行，绝不静默吞掉消息
    const a = gate(CFG, { noSession: true })
    const r1 = await a.run({ messages: [human('乱来')] })
    check('没有 session 可写 → 放行（fail-open，不让消息无声消失）', r1.kind === 'enter', JSON.stringify(r1))
    check('这种情况会在 state 里写明原因',
        readState(a.routes).lastVerdict.indexOf('fail-open') >= 0, readState(a.routes).lastVerdict)

    const b = gate(CFG, { failAppend: true })
    const r2 = await b.run({ messages: [human('乱来')] })
    check('append 一律抛错 → 同样放行（fail-open）', r2.kind === 'enter', JSON.stringify(r2))
}
{
    // ④ replyStyle='notice' 时直接走后备路径（使用者可以自己选）
    const g = gate({ ...CFG, replyStyle: 'notice' })
    const r = await g.run({ messages: [human('乱来')] })
    check("replyStyle='notice' → 只写 notice、不开步骤",
        r.kind === 'reject' && g.appended.length === 1 && g.appended[0].type === 'user/message',
        JSON.stringify(g.appended.map(e => e.type)))
    check('state.json 报告 replyStyle', readState(g.routes).replyStyle === 'notice')
}
{
    // ⑤ echoBlocked=false：不补写原话（只发泡泡）
    const g = gate({ ...CFG, echoBlocked: false })
    await g.run({ messages: [human('乱来')] })
    check('echoBlocked=false → 只写 step/start、assistant/message、step/end',
        g.appended.map(e => e.type).join(',') === 'step/start,assistant/message,step/end',
        g.appended.map(e => e.type).join(','))
}
{
    // ⑥ 原话本身形状不完整（没有 id）→ 少补一条，也绝不写坏事件
    const g = gate(CFG)
    await g.run({ messages: [{ role: 'user', content: [{ type: 'text', text: '乱来' }], source: { kind: 'model' } }] })
    check('原话没有 id → 跳过补写，但泡泡照发',
        g.appended.map(e => e.type).join(',') === 'step/start,assistant/message,step/end',
        g.appended.map(e => e.type).join(','))
}

console.log('\nG. 只回官方决策、无旁路副作用（静态检查）')
{
    const src = readFileSync(INDEX, 'utf8')
    // 只看代码，不看注释——档头注释里解释「为什么这么写」，那是说明而不是行为。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    check('session.append 的每个事件类型都是内核认识的名字',
        code.indexOf(`append('step/start'`) >= 0 && code.indexOf(`append('step/end'`) >= 0
        && code.indexOf(`append('assistant/message'`) >= 0 && code.indexOf(`append('user/message'`) >= 0)
    check('两条消息事件都带 surfaceOp append',
        code.indexOf("session.append('assistant/message', event, { surfaceOp: 'append' })") >= 0
        && code.indexOf("session.append('user/message', message, { surfaceOp: 'append' })") >= 0)
    check('绝不自己发 session/event', code.indexOf('session/event') < 0)
    check('绝不碰 turn/start（那是 loop 的）', code.indexOf(`append('turn/start'`) < 0)
    check('坐标只从载荷读，不自己算', code.indexOf('payload.turn') >= 0 && code.indexOf('payload.step') >= 0)
    check('写入前先验形状（不会凭记忆拼事件）', code.indexOf('isContractAssistantEvent(event)') >= 0)
    check('只回官方决策：reject', code.indexOf("kind: 'reject'") >= 0 && code.indexOf('startsRequestSeries') < 0)
    check('没有任何写文件调用（无持久化副作用）',
        code.indexOf('writeFileSync') < 0 && code.indexOf('appendFileSync') < 0)
    check('不往页面注入脚本（没有浮动泡泡/SSE 遗留）',
        code.indexOf('index-inject') < 0 && code.indexOf('EventSource') < 0 && code.indexOf('innerHTML') < 0)
}

console.log('\nH. 妈妈的回覆（默认五句）')
{
    const g = gate(CFG)
    for (let i = 0; i < 20; i++) { await g.run({ messages: [human('乱来第' + i + '次')] }) }
    const replies = g.appended.filter(e => e.type === 'assistant/message').map(e => e.data.message.content[0].text)
    check('拦截 20 次写进 20 句回覆', replies.length === 20, String(replies.length))
    check('每句都非空', replies.every(r => typeof r === 'string' && r.trim().length > 0))
    // 这条是设计性质：回覆自己要把关键词说出来，用户看完就知道该补什么
    check('每句都自己说出关键词「媽媽」', replies.every(r => r.indexOf('媽媽') >= 0),
        replies.find(r => r.indexOf('媽媽') < 0) || '')
    let adjacent = true
    for (let i = 1; i < replies.length; i++) { if (replies[i] === replies[i - 1]) { adjacent = false } }
    check('不连续重复（同一条连发两次会像坏掉）', adjacent)
    check('确实在多句之间随机跳', new Set(replies).size >= 4, '用到 ' + new Set(replies).size + ' 句')
    check('state.json 报告回覆库句数 = 5', readState(g.routes).replies === 5)
    check('state.json 记下最后一句', typeof readState(g.routes).lastReply === 'string' && readState(g.routes).lastReply.length > 0)
}

console.log('\nI. 备用通道（行首控制项，不是子字串）')
{
    const g = gate({ ...CFG, backup: ['1'] })
    const cases = [
        ['1', 'enter', '整句就是 1'],
        ['1 帮我改文件', 'enter', '1 + 空白 + 内容'],
        ['  1   帮我改', 'enter', '前面有空白也算'],
        ['1.0 的版号', 'reject', '1 后面接 . → 不算通道'],
        ['2026年1月', 'reject', '1 在中间'],
        ['第1章', 'reject', '1 在中间'],
        ['帮我改 1 次', 'reject', '1 在中间'],
        ['11', 'reject', '11 不等于 1（token 后必须空白或结束）'],
    ]
    for (const [text, want, why] of cases) {
        const r = await g.run({ messages: [human(text)] })
        check(`「${text}」→ ${want === 'enter' ? '放行' : '拦截'}（${why}）`, r.kind === want, r.kind)
    }
    const s = readState(g.routes)
    check('备用通道放行单独计数（backedUp=3）', s.backedUp === 3, JSON.stringify(s))
    check('被拦的仍是 5 笔', s.blocked === 5, JSON.stringify(s))
    check('state.json 报告备用通道数', s.backup === 1, JSON.stringify(s))
    // 最后一笔是「11」（被拦），所以 lastVerdict 现在必然是「已拦截」——
    // 要验通道标记，得在放行之后再读一次。
    check('被拦时 lastVerdict 如实写「已拦截」', s.lastVerdict.indexOf('已拦截') === 0, s.lastVerdict)
    check('5 次拦截 → 5 组步骤事件（每组 4 个）', g.appended.length === 20, String(g.appended.length))
    await g.run({ messages: [human('1')] })
    const s2 = readState(g.routes)
    check('放行后 lastVerdict 指出是哪条通道', s2.lastVerdict.indexOf('备用通道') >= 0, s2.lastVerdict)
    check('计数跟着加 1', s2.backedUp === 4, JSON.stringify(s2))
}
{
    const g = gate({ ...CFG, backup: ['1'] })
    const r1 = await g.run({ messages: [human('1')] })
    check('备用通道放行', r1.kind === 'enter')
    check('备用通道放行不写任何会话事件', g.appended.length === 0, String(g.appended.length))
    check('备用通道用的是 backedUp 而不是 bypassed',
        readState(g.routes).backedUp === 1 && readState(g.routes).bypassed === 0)
}
{
    const g = gate(CFG)     // CFG 里没配 backup
    const r = await g.run({ messages: [human('1')] })
    check('没配 backup 时「1」不会误放行', r.kind === 'reject', r.kind)
}

console.log('\nJ. 备选路径的 notice 形状')
{
    const g = gate({ ...CFG, replyStyle: 'notice' })
    await g.run({ messages: [human('乱来')] })
    const msg = g.appended[0].data
    check('id 是非空字串（客户端渲染会读）', typeof msg.id === 'string' && msg.id.length > 0, typeof msg.id)
    check('role=user（用户侧 notice，不是模型消息）', msg.role === 'user', msg.role)
    check('source.form=notice（客户端按 notice 卡片渲染）', msg.source.form === 'notice', JSON.stringify(msg.source))
    check('source.kind 是 plugin（内核认可的消息来源）', msg.source.kind === 'plugin', msg.source.kind)
    check('摘要就是妈妈那句', msg.source.summary.indexOf('媽媽') >= 0, msg.source.summary)
    check('正文里带着刚才没接住的那句', msg.content[0].text.indexOf('乱来') >= 0, msg.content[0].text)
    check('摘要不超过内核上限 120 字',
        typeof msg.source.summary === 'string' && msg.source.summary.length <= 120, String(msg.source.summary.length))
    check('content 是数组且首块是 text', Array.isArray(msg.content) && msg.content[0].type === 'text')
}

console.log('\n' + (fails.length === 0 ? `PASS — ${pass}/${pass} 项` : `FAIL — ${fails.length} 项未过：${fails.join('; ')}`))
process.exit(fails.length === 0 ? 0 : 1)
