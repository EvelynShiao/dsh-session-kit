/**
 * 步边界写盘门 —— 插件侧**唯一**允许「往会话表面 append 消息」的入口。
 *
 * ============ 为什么需要它 ============
 * 插件在自己的时机调 `session.append('user/message', message, { surfaceOp: 'append' })`，
 * 而"自己的时机"完全可能是**工具执行中**（工具里注入档案）或**用户点一下的瞬间**
 * （UI 手动注入记忆）。那一刻日志里的顺序是：
 *
 *     assistant/message（宣告 tool-call）
 *     tool/call
 *     插件插进来的 user/message        ← 插队
 *     tool/result
 *
 * 模型侧请求就变成「assistant 的 tool_use 后面紧跟一条普通 user 消息」，严格 provider
 * （deepseek 官方走 Anthropic 风格校验）直接拒收整轮：
 *
 *     messages.N.M: `tool_use` ids were found without `tool_result` blocks
 *     immediately after: call_xxx
 *
 * 实证：session-3a8e374a seq 580-583（turn 10 step 13 的 task_inject）。
 *
 * ============ 修法 ============
 * 不是"别注入"，而是"换个时机注入"：跟踪本会话还没等到结果的 tool/call；
 * 工具执行期只把消息排进队列，由下一次 `agent/pre-step` 并进 `decision.messages`——
 * 宿主会在系统提示词提交之后、请求组装之前把它们作为 user 消息落盘，
 * 天然处在所有工具结果之后的**步边界**上。
 *
 * 没有未结算调用时（例如用户点了「注入」但此刻没有工具在跑）依旧直写：行为不变、延迟为零。
 */

/** 幂等安装标记。 */
const GATE_INSTALLED = Symbol.for('dsh-session-kit.step-gate.installed')

/**
 * 造一个门。默认导出的单例 `stepGate` 就是插件本体用的那个；
 * 导出工厂是为了让测试能各造一个互不干扰的实例。
 * @param {object} [options] - { maxPending } 每会话最多排队几条（默认 8，超出丢最旧）
 */
export function createStepGate(options = {}) {
  const maxPending = Number.isFinite(options.maxPending) ? options.maxPending : 8
  /** sessionId -> Set<callId>：还没等到 tool/result 的调用。 */
  const openToolCalls = new Map()
  /** sessionId -> [{ message, meta }]：因工具执行中而延后落盘的注入消息。 */
  const pending = new Map()
  const sidOf = (session) => String(session?.id ?? '')

  /**
   * 跟踪会话里的 tool/call 与 tool/result（唯一的状态来源）。
   * @param {object} session
   * @param {object} event - session/event 事件
   */
  function noteToolEvent(session, event) {
    const type = event?.type
    if (type !== 'tool/call' && type !== 'tool/result') return
    const sessionId = sidOf(session)
    if (!sessionId) return
    const callId = type === 'tool/call' ? event?.data?.callId : event?.data?.message?.toolCallId
    if (typeof callId !== 'string' || callId === '') return
    const open = openToolCalls.get(sessionId) ?? new Set()
    if (type === 'tool/call') open.add(callId)
    else open.delete(callId)
    openToolCalls.set(sessionId, open)
  }

  /** 本会话此刻是否有工具没结算（有 = 写盘会插队）。 */
  function isToolBusy(session) {
    const open = openToolCalls.get(sidOf(session))
    return open !== undefined && open.size > 0
  }

  /**
   * 安全写盘：没工具在跑就直写，否则排队等下一次步边界。
   * @returns {{appended:boolean, deferred:boolean, seq:number|null}}
   */
  function appendOrDefer(session, message, meta = {}) {
    if (typeof session?.append !== 'function') return { appended: false, deferred: false, seq: null }
    if (!isToolBusy(session)) {
      const result = session.append('user/message', message, { surfaceOp: 'append' })
      const seq = Number(result?.seq ?? NaN)
      return { appended: true, deferred: false, seq: Number.isSafeInteger(seq) && seq >= 0 ? seq : null }
    }
    const sessionId = sidOf(session)
    const queue = pending.get(sessionId) ?? []
    queue.push({ message, meta })
    while (queue.length > maxPending) queue.shift()
    pending.set(sessionId, queue)
    return { appended: false, deferred: true, seq: null }
  }

  /**
   * 把这些延后的消息并进 pre-step 决策的 messages（宿主会紧跟系统提示词之后落盘）。
   * 幂等：队列取走即清，多挂几个 flush 点也不会重复注入。
   * @param {object} session
   * @param {object} decision - agent/pre-step 的决策对象
   */
  function flush(session, decision) {
    const sessionId = sidOf(session)
    if (!sessionId) return decision
    const queue = pending.get(sessionId)
    if (queue === undefined || queue.length === 0) return decision
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    pending.delete(sessionId)
    return { ...decision, messages: [...decision.messages, ...queue.map((item) => item.message)] }
  }

  /** 还有几条排着队（诊断用）。 */
  function pendingCount(session) {
    return pending.get(sidOf(session))?.length ?? 0
  }

  /**
   * 装到 ctx 上：一个 session/event 跟踪器 + 一个 pre-step 落盘钩子。幂等。
   * 想让落盘发生在所有提示注入之后，就在其它 feature 安装完再调它（pre-step 钩子后注册者后执行）。
   * @returns {boolean} 本次是否真的装了
   */
  function install(ctx) {
    if (ctx === undefined || ctx === null) return false
    try {
      if (ctx[GATE_INSTALLED] === true) return false
      Object.defineProperty(ctx, GATE_INSTALLED, { value: true, configurable: true })
    } catch {
      return false
    }
    ctx.effect?.(function* () {
      yield ctx.on('session/event', (session, event) => noteToolEvent(session, event))
      yield ctx.on('agent/pre-step', async ({ agent }, next) => {
        const decision = await next()
        return flush(agent?.session, decision)
      }, { prepend: false })
    }, 'dsh-session-kit: step gate')
    return true
  }

  return { noteToolEvent, isToolBusy, appendOrDefer, flush, pendingCount, install, openToolCalls, pending }
}

/** 插件本体共用的那个门。 */
export const stepGate = createStepGate()
