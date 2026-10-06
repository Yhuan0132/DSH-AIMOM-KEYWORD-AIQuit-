/**
 * keyword-gate 内核契约测试 —— 用**真的** DSH 内核 Session 重放本插件写出的事件。
 *
 * 为什么值得单独测：`tools/selftest.mjs` 用的是自己写的迷你 session 桩，
 * 只能证明「照我理解的契约写」；这个测试把同样的事件喂进
 * `@deepseek-ai/dsh-session` 的 `Session.append()`——也就是宿主真正调用的那支——
 * 于是能回答两个只有真内核才能回答的问题：
 *
 *   1. 事件序列会不会被内核**当场拒绝**（invariant / surfaceOp / JSON 可序列化）；
 *   2. 重新载入历史时，派生出来的消息历史里**有没有那两条**（你说的那句 + 妈妈的回覆）。
 *
 * 第三条同样重要：整个过程中**没有任何模型呼叫**，回覆是脚本挑的。
 *
 * 用法：
 *   node tools/kernel-contract.mjs                       # 自动找解包出来的内核
 *   node tools/kernel-contract.mjs --kernel <dir>        # 指定 <dir>/@deepseek-ai/dsh-session
 *   DSH_KERNEL=<dir> node tools/kernel-contract.mjs
 *
 * <dir> 要含 `@deepseek-ai/dsh-session/lib/index.js`（把 app.asar 里的
 * `dsh/node_modules` 解包出来即可；找不到就 SKIP，不算失败）。
 */
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let pass = 0
const fails = []
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label) }
    else { fails.push(label); console.log('  FAIL ' + label + (detail === undefined ? '' : '   [' + detail + ']')) }
}
function skip(why) { console.log('SKIP — ' + why); process.exit(0) }

// ── 找内核 ────────────────────────────────────────────────────────────────
const argIdx = process.argv.indexOf('--kernel')
const candidates = [
    argIdx > 0 ? process.argv[argIdx + 1] : undefined,
    process.env.DSH_KERNEL,
    join(HERE, '_kernel', 'dsh', 'node_modules'),
    join(HERE, '..', '_kernel', 'dsh', 'node_modules'),
].filter(Boolean).map(p => resolve(p))

const kernelDir = candidates.find(dir => existsSync(join(dir, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')))
if (!kernelDir) skip('找不到解包出来的内核（给 --kernel <dir> 或设 DSH_KERNEL）')
console.log(`内核：${kernelDir}\n`)

const sessionPkg = await import(pathToFileURL(join(kernelDir, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href)
const { Session, SessionId } = sessionPkg
const plugin = await import(new URL('../index.js', import.meta.url).href)

// ── 用真内核造一条空会话 ──────────────────────────────────────────────────
const CWD = resolve(HERE)
function makeSession(id) {
    return Session.create(SessionId(id), undefined, {
        version: 4, id, createdAt: Date.now(), isSeeded: false, cwd: CWD,
    }, 0, [])
}

/** 挂上插件，拿「喂 payload → 拿决策」的函数。会话就是真内核的那一条。 */
function gateOn(session, config) {
    const listeners = new Map()
    const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        webServer: { register() { return () => {} } },
        effect(f) { return f() },
        on(name, fn) { if (!listeners.has(name)) { listeners.set(name, []) } listeners.get(name).push(fn); return () => {} },
    }
    plugin.apply(ctx, config)
    const handler = listeners.get('agent/pre-step')[0]
    const agent = { session, options: { provider: 'deepseek-official', model: 'deepseek-flash' } }
    const next = async () => ({ kind: 'enter', messages: [] })
    return {
        agent,
        run: (payload) => handler({ turn: 1, step: 1, ...payload, agent }, next),
    }
}

const human = (text, id) => ({
    id: id || 'u-1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'model' },
})
const CFG = { enabled: true, keywords: ['媽媽'], bypass: ['!gate'] }
/** 派生出来的消息历史（内核自己算的，客户端读历史走的就是这条路）。 */
const transcript = (session) => session.deriveMessages().map(m => ({
    role: m.role,
    text: (m.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
    source: m.source && m.source.kind,
}))

console.log('A. 回覆泡泡真的能被内核写进会话')
{
    const session = makeSession('kwgate-test')
    session.append('turn/start', { turn: 1 })          // loop 一定会先写这个（dsh-agent-loop:943）
    const g = gateOn(session, CFG)
    let decision
    let thrown
    try {
        // 这条会写 step/start → user/message → assistant/message → step/end
        decision = await g.run({ messages: [human('你好')] })
    } catch (err) { thrown = err }
    check('内核没有拒绝这串事件（append 全部通过 invariant/surfaceOp 校验）', thrown === undefined, thrown && thrown.message)
    check('闸门回的是官方决策 reject', decision && decision.kind === 'reject', JSON.stringify(decision))
    session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })   // loop 的 finally（1027）

    const events = session.log.map(e => e.type)
    check('事件序列与内核同款：turn/start → step/start → user/message → assistant/message → step/end → turn/end',
        events.join(',') === 'turn/start,step/start,user/message,assistant/message,step/end,turn/end', events.join(','))

    const history = transcript(session)
    check('派生历史里正好两条消息', history.length === 2, JSON.stringify(history))
    check('第一条是被拦的原话（role=user）', history[0] && history[0].role === 'user' && history[0].text === '你好', JSON.stringify(history[0]))
    check('第二条是妈妈的回覆（role=assistant）', history[1] && history[1].role === 'assistant', JSON.stringify(history[1]))
    check('回覆的 source.kind=model（客户端按模型回覆渲染成泡泡）', history[1] && history[1].source === 'model', JSON.stringify(history[1]))
    check('回覆内容来自脚本（含关键词「媽媽」），不是模型生成的',
        history[1] && history[1].text.indexOf('媽媽') >= 0, JSON.stringify(history[1]))
}

console.log('\nB. 历史重新载入（客户端开这份会话时走的路）')
{
    const session = makeSession('kwgate-source')
    session.append('turn/start', { turn: 1 })
    await gateOn(session, CFG).run({ messages: [human('你好')] })
    session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })

    // 用同一批事件当种子重建一次 —— 这正是「刷新页面 / 重开会话」时的校验路径
    let reloaded
    let thrown
    try {
        reloaded = Session.create(SessionId('kwgate-reloaded'), session.log, {
            version: 4, id: 'kwgate-reloaded', createdAt: Date.now(), isSeeded: false, cwd: CWD,
        }, 0, [])
    } catch (err) { thrown = err }
    check('重建会话时没有抛错（坏事件会让整个会话历史打不开）', thrown === undefined, thrown && thrown.message)
    const history = reloaded ? transcript(reloaded) : []
    check('重建后那两条消息都还在', history.length === 2 && history[1].role === 'assistant', JSON.stringify(history))
    check('重建后回覆文本一字不差', history[1] && history[1].text.indexOf('媽媽') >= 0, JSON.stringify(history[1]))
}

console.log('\nC. 降级路径（没有坐标 → 用户侧 notice）也过内核')
{
    const session = makeSession('kwgate-notice')
    session.append('turn/start', { turn: 1 })
    const g = gateOn(session, { ...CFG, replyStyle: 'notice' })
    let thrown
    let decision
    try { decision = await g.run({ messages: [human('你好')] }) } catch (err) { thrown = err }
    check('notice 路径没有抛错', thrown === undefined, thrown && thrown.message)
    check('notice 路径一样回 reject', decision && decision.kind === 'reject', JSON.stringify(decision))
    session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    const history = transcript(session)
    check('notice 也进了派生历史', history.some(m => m.text.indexOf('媽媽') >= 0), JSON.stringify(history))
    check('notice 不冒充模型回覆', history.every(m => m.role !== 'assistant'), JSON.stringify(history))
}

console.log('\nD. 放行的一轮完全没有副作用')
{
    const session = makeSession('kwgate-pass')
    session.append('turn/start', { turn: 1 })
    const g = gateOn(session, CFG)
    const decision = await g.run({ messages: [human('媽媽 帮我改文件')] })
    check('带关键词 → 决策是 enter（交回内核）', decision && decision.kind === 'enter', JSON.stringify(decision))
    check('一个事件都没写（零 token、零副作用）', session.log.length === 1, String(session.log.length))
}

console.log('\n' + (fails.length === 0 ? `PASS — ${pass}/${pass} 项（真内核）` : `FAIL — ${fails.length} 项未过：${fails.join('; ')}`))
process.exit(fails.length === 0 ? 0 : 1)
