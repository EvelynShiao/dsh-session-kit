/* exciseSessionBuffer 合成 fixture 验收（2026-11-26 物理无痕删除 · 交接 §8 第 2 步）
 *
 * 覆盖：
 *  - 单轮切除 / 连续多轮切除（excise 按轮号切片，语义与 SK 删除路由的「截断」无关）
 *  - 含工具调用的轮（tool-call/tool-call-advance/tool/result 完整配对）
 *  - inbox insert/consume 配对（喂给被删轮的插入行也须一并切除）
 *  - title.messageSeqs、surfaceOp/sourceEventSeqs 重编号
 *  - 墓碑 source.summary 里的 turn/endTurn 重编号（切前序轮时旧墓碑指向漂移）
 *  - 负路径：未闭合轮 / 不存在的轮号 / compaction 阴影集相交 / 非法墓碑 JSON
 *  - 产出双验收：exciseGate 0 错 + 宿主 Session.fromRestore 装载（模型真正会读的形状）
 *  - 往返：输出 buffer 可 decode，且 JSONL 文本里搜不到被删正文字样
 *
 * 纯 node:test，无网络、不写 DSH_HOME；宿主 dsh-session 用绝对路径动态 import。 */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let exciseMod
async function loadExcise() {
  if (!exciseMod) exciseMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'excise.js')).href)
  return exciseMod
}

/* 宿主安装目录会变（2026-11-28 从 DeepSeekHarness 迁到带空格的 [DSH] 目录），
   所以按候选列表找，别写死。 */
const HOST_SESSION = (() => {
  const fs = require('node:fs')
  const bases = [
    'C:/Users/Evelyn/AppData/Local/Programs/DeepSeekHarness/dsh',
    'C:/Users/Evelyn/AppData/Local/Programs/[DSH]/resources/app.asar/dsh',
    'C:/Users/Evelyn/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'
  ]
  for (const base of bases) {
    const p = base + '/node_modules/@deepseek-ai/dsh-session/lib/index.js'
    if (fs.existsSync(p)) return p
  }
  return bases[0] + '/node_modules/@deepseek-ai/dsh-session/lib/index.js'
})()
let hostSessionMod
async function loadHostSession() {
  if (!hostSessionMod) hostSessionMod = await import(pathToFileURL(HOST_SESSION).href)
  return hostSessionMod
}

function makeHeader() {
  return {
    version: 4,
    id: 'session-fixture',
    createdAt: 1764000000000,
    cwd: 'C:/fixture',
    isSeeded: false,
    delegationDepth: 0
  }
}

async function bufFromRows(rows) {
  const { zstdCompressSync, constants } = await import('node:zlib')
  const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const head = zstdCompressSync(Buffer.from(JSON.stringify(makeHeader()) + '\n', 'utf8'), checksum)
  const body = zstdCompressSync(Buffer.from(rows.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'), checksum)
  return Buffer.concat([head, body])
}

const msg = (role, id, content, kind = 'user') => ({ id, role, content, source: { kind } })
/* 宿主规则（dsh-session/lib/index.js:1257）：assistant 消息 source 必须
   {kind:'model', provider, model}（"message must have model source"）。 */
const MODEL_SOURCE = { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }
/* 真实会话形状（2026-11-26 解码备份子代理会话核对）：
   - system/developer/assistant/tool 的 id 在 data.message.id；user 的在 data.id
   - 系统头与 user prompt 都在 step 内（turn/step 字段带在 data 上）
   - title 的 source.kind 是 fallback/user 等，非 user 时必须 messageSeqs 非空
   - request/header 在 step 内（headerSeq 指向它） */
const USER = (turn, id, text) => ({
  type: 'user/message',
  data: { turn, step: 1, ...msg('user', id, [{ type: 'text', text }]) },
  surfaceOp: 'append'
})
const ASSISTANT = (turn, id, text) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { ...msg('assistant', id, [{ type: 'text', text }]), source: { ...MODEL_SOURCE } }, stream: [] },
  surfaceOp: 'append'
})
const ATTEMPT = (turn) => ({ type: 'assistant/attempt', data: { turn, step: 1, stream: [] } })
const CALL = (turn, id) => ({ type: 'assistant/message', data: { turn, step: 1, message: { ...msg('assistant', id, [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }]), source: { ...MODEL_SOURCE } }, stream: [] }, surfaceOp: 'append' })
const CALL_ADVANCE = (turn) => ({ type: 'tool/call', data: { turn, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' } })
const RESULT = (turn, text) => ({ type: 'tool/result', data: { turn, step: 1, message: { id: 'm-res', role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1' } }, surfaceOp: 'append' })

/* 带工具调用的完整轮（consume 在 step/start 前把此前的 inbox 插入消费掉）。
   每轮结构：insert（在 turn/start 前，由调用方加）→ turn/start → consume →
   step/start → [首步 system/user/header] → 工具链 → step/end → turn/end。 */
function toolTurn(turn, id, assistantText, resultText) {
  const rows = [
    { type: 'turn/start', data: { turn } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'step/start', data: { turn, step: 1 } },
    ATTEMPT(turn),
    CALL(turn, `m-${id}-call`),
    CALL_ADVANCE(turn),
    RESULT(turn, resultText),
    ASSISTANT(turn, `m-${id}-text`, assistantText),
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn } }
  ]
  return rows
}

function plainTurn(turn, id, text) {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'step/start', data: { turn, step: 1 } },
    ASSISTANT(turn, `m-${id}`, text),
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn } }
  ]
}

/* 基线：系统头 + 三轮（1=带工具，2=带工具，3=纯文本）。
   真实事件 seq 从 0 起逐一递增——fixture 也按此生成。 */
function baseFixture() {
  const rows = [
    { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [msg('user', 'm-u1', [{ type: 'text', text: '问题一' }])] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', data: { turn: 1, step: 1, message: msg('system', 'm-sys', [{ type: 'text', text: 'sys' }], 'system-prompt') }, surfaceOp: 'append' },
    { type: 'request/header', data: { turn: 1, step: 1, header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    /* 宿主规则：headerSeq 仅在 request/header 带工具增量时才必须携带
       （"requires headerSeq exactly when tool additions are present"），无工具时不带。 */
    { type: 'developer/message', data: { turn: 1, step: 1, message: msg('developer', 'm-dev', [{ type: 'text', text: 'dev' }], 'system') }, surfaceOp: 'append' },
    { type: 'user/message', data: { turn: 1, step: 1, ...msg('user', 'm-u1', [{ type: 'text', text: '问题一' }]) }, surfaceOp: 'append' },
    /* 与宿主真实标题链一致：自动标题 kind:'fallback' + messageSeqs 非空
       （手动改名才是 kind:'user' + 空引用，见 dsh-session-title rename/appendFallback）。
       exciseGate 的 title-bi 口径对 fallback 会误报（真实会话同样触发），
       属「严格于宿主」的既有偏差，本测试在 gateAndHostCheck 里显式容忍并留档。 */
    { type: 'session/title', data: { title: 'fixture 标题', messageSeqs: [8], source: { kind: 'fallback' } } },
    { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } },
    CALL(1, 'm-t1-call'),
    CALL_ADVANCE(1),
    RESULT(1, '文件甲内容'),
    ASSISTANT(1, 'm-t1-text', '答案一'),
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [msg('user', 'm-u2', [{ type: 'text', text: '问题二' }])] } },
    ...toolTurn(2, 't2', '答案二', '文件乙内容'),
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [msg('user', 'm-u3', [{ type: 'text', text: '问题三' }])] } },
    ...plainTurn(3, 't3', '答案三')
  ]
  rows.forEach((e, k) => { e.seq = k; e.time = 1764000000000 + k * 10 })
  return rows
}

/* 已知「严格于宿主」的门禁口径（真实会话同样触发，与本切除无关）：
   title-bi——自动标题 kind:'fallback' 带非空 messageSeqs 是宿主正常形状。 */
const GATE_KNOWN_HOST_DEVIATIONS = [/^title-bi@/]
async function gateAndHostCheck(buf, expectedRows) {
  const { decodeSessionBuffer, exciseGate } = await loadExcise()
  const decoded = decodeSessionBuffer(buf)
  assert.equal(decoded.rows.length, expectedRows, '输出 decode 后行数')
  const gateErrors = exciseGate(decoded.rows)
  const unexpected = gateErrors.filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err)))
  assert.deepEqual(unexpected, [], `exciseGate 除已知 title-bi 口径外应为 0 错：${unexpected.join(' | ')}`)
  decoded.rows.forEach((e, k) => assert.equal(e.seq, k, `seq 密度@${k}`))
  const { Session } = await loadHostSession()
  const header = { ...makeHeader() }
  const session = Session.fromRestore('session-fixture', decoded.rows, header, 0, 'detached', [])
  assert.equal(session.id, 'session-fixture')
  /* 宿主恢复语义（dsh-session/lib/index.js:1499-1505）：fromRestore 在 seed 末尾
     必补 session/end-seed 边界标记；interrupted turn 另补闭合事件。所以不断言
     seq===行数，而验证「宿主补的事件合法 + 重导出 seed 逐行一致」。 */
  const roundTrip = session.snapshotEvents()
  assert.ok(roundTrip.length >= decoded.rows.length, '宿主快照不得比 seed 短')
  const appended = roundTrip.slice(decoded.rows.length)
  for (const e of appended) {
    assert.ok(['turn/end', 'turn/start', 'session/end-seed'].includes(e.type), `宿主补的事件类型合法：${e.type}`)
  }
  const original = decoded.rows.map((e) => JSON.stringify(e))
  const restored = roundTrip.slice(0, decoded.rows.length).map((e) => JSON.stringify(e))
  assert.deepEqual(restored, original, '宿主重导出 seed 必须逐行一致（零漂移）')
  return decoded
}

test('fixture 基线自洽：除已知 title-bi 口径外门禁 0 错 + 宿主可装载', async () => {
  const buf = await bufFromRows(baseFixture())
  const { exciseGate, decodeSessionBuffer } = await loadExcise()
  const baseline = exciseGate(decodeSessionBuffer(buf).rows)
  assert.deepEqual(baseline.filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err))), [], '基线除已知 title-bi 口径外必须过门禁')
  await gateAndHostCheck(buf, 35)
})

test('单轮切除（中间轮2）：孤儿插入移除 + 轮号重排 + title 引用吸附', async () => {
  const { exciseSessionBuffer, encodeSessionBuffer, decodeSessionBuffer } = await loadExcise()
  const buf = await bufFromRows(baseFixture())
  // 真实标题链（fallback + 非空引用）会触发既有 title-bi 口径偏差。
  // diagnostic 模式在「除已知 title-bi 外 0 错」时仍走成功路径（ok 字段缺省）。
  // 先验证「错误集=已知偏差」，再用产出做宿主双验收。
  const result = exciseSessionBuffer(buf, [2], { diagnostic: true })
  assert.deepEqual((result.errors ?? []).filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err))), [], '除 title-bi 外应 0 错')
  const out = result.buf ?? encodeSessionBuffer(decodeSessionBuffer(buf).headerFrame, result.rows)
  const stats = result.stats
  assert.equal(stats.removedTurns[0], 2)
  // 基线 35 行；切轮2（10 行含 consume）+ 它的孤儿插入（1 行）
  assert.equal(stats.removedRows, 11)
  const decoded = await gateAndHostCheck(out, 24)
  const text = decoded.rows.map((e) => JSON.stringify(e)).join('\n')
  for (const gone of ['问题二', '答案二', '文件乙内容', 'm-t2-call', 'm-t2-text']) {
    assert.ok(!text.includes(gone), `残留被删字样：${gone}`)
  }
  const turns = decoded.rows.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)
  assert.deepEqual(turns, [1, 2], '轮号应重排为连续')
  // 原轮3 的 assistant 现在 turn=2
  const t3 = decoded.rows.find((e) => e.type === 'assistant/message' && e.data?.message?.id === 'm-t3')
  assert.equal(t3.data.turn, 2)
  const inbox = decoded.rows.filter((e) => e.type === 'agent/inbox/spliced')
  const inserts = inbox.filter((e) => Array.isArray(e.data?.inserted) && e.data.inserted.length > 0)
  assert.equal(inserts.length, 2, '只剩轮1/轮3 的插入')
  assert.equal(inbox.length, 4, '轮1/轮3 的插入+consume 各两行')
})

test('连续多轮切除（2+3）：系统头幸存、title 引用吸附', async () => {
  const { exciseSessionBuffer, encodeSessionBuffer, decodeSessionBuffer } = await loadExcise()
  const buf = await bufFromRows(baseFixture())
  const tail = exciseSessionBuffer(buf, [2, 3], { diagnostic: true })
  assert.deepEqual((tail.errors ?? []).filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err))), [], '除 title-bi 外应 0 错')
  assert.equal(tail.stats.removedRows, 18) // 轮2 11 行 + 轮3 7 行（均含插入）
  const dTail = await gateAndHostCheck(tail.buf ?? encodeSessionBuffer(decodeSessionBuffer(buf).headerFrame, tail.rows), 17)
  assert.deepEqual(dTail.rows.filter((e) => e.type === 'turn/start').map((e) => e.data.turn), [1])
  assert.ok(dTail.rows.some((e) => e.type === 'system/message'), '系统头幸存')
})

test('全轮切除（1+2+3）：系统头随之消失 → 门禁 no-system-head 拒载（安全兜底）', async () => {
  const { exciseSessionBuffer } = await loadExcise()
  const buf = await bufFromRows(baseFixture())
  const all = exciseSessionBuffer(buf, [1, 2, 3], { diagnostic: true })
  assert.equal(all.ok, false, '全切后无系统头，门禁应判不通过')
  assert.ok(all.errors.includes('no-system-head'), `应报 no-system-head，实际：${all.errors.join(' | ')}`)
  assert.equal(all.rows.length, 1, '切除后只剩 sandbox/mode 一行')
})

test('墓碑与 surfaceOp/sourceEventSeqs 重编号：切前序轮时旧墓碑指向跟随', async () => {
  const { exciseSessionBuffer } = await loadExcise()
  const rows = baseFixture()
  const n = rows.length
  // 追加轮4/5（纯文本），再追加「删除轮4」的墓碑（SK 真墓碑形状：content 空 + replace 区间）
  rows.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [msg('user', 'm-u4', [{ type: 'text', text: '问题四' }])] } })
  rows.push(...plainTurn(4, 't4', '答案四'))
  const turn4AssistantSeq = n + 4 // insert n / start n+1 / consume n+2 / step n+3 / assistant n+4
  rows.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [msg('user', 'm-u5', [{ type: 'text', text: '问题五' }])] } })
  rows.push(...plainTurn(5, 't5', '答案五'))
  const tombstone = {
    type: 'user/message',
    data: { ...msg('user', 'm-tomb', [], 'dsh-session-kit-turns-del'), source: { kind: 'dsh-session-kit-turns-del', form: 'notice', summary: JSON.stringify({ turn: 4, endTurn: 4 }) } },
    surfaceOp: { op: 'replace', startSeq: turn4AssistantSeq, endSeq: turn4AssistantSeq },
    sourceEventSeqs: [turn4AssistantSeq]
  }
  rows.push(tombstone)
  rows.forEach((e, k) => { e.seq = k; e.time = 1764000000000 + k * 10 })
  const buf = await bufFromRows(rows)
  const { exciseGate, decodeSessionBuffer, encodeSessionBuffer } = await loadExcise()
  const baseline = exciseGate(decodeSessionBuffer(buf).rows)
  assert.deepEqual(baseline.filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err))), [], '带墓碑基线除 title-bi 外必须过门禁')
  // 切前序轮2（11 行含插入）：轮4→3、轮5→4，墓碑 summary 里的 turn/endTurn 也应重排
  const result = exciseSessionBuffer(buf, [2], { diagnostic: true })
  assert.deepEqual((result.errors ?? []).filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err))), [], '除 title-bi 外应 0 错')
  const out = result.buf ?? encodeSessionBuffer(decodeSessionBuffer(buf).headerFrame, result.rows)
  const decoded = await gateAndHostCheck(out, rows.length - 11)
  const tomb = decoded.rows.find((e) => e.type === 'user/message' && e.data?.source?.kind === 'dsh-session-kit-turns-del')
  assert.ok(tomb, '墓碑载体存活（它遮蔽的是幸存轮）')
  const meta = JSON.parse(tomb.data.source.summary)
  assert.deepEqual([meta.turn, meta.endTurn], [3, 3], '墓碑轮号应随前序切除重排')
  assert.deepEqual(tomb.sourceEventSeqs, [tomb.surfaceOp.startSeq], 'sourceEventSeqs 与 surfaceOp 同步')
  const hiddenTarget = decoded.rows[tomb.surfaceOp.startSeq]
  assert.equal(hiddenTarget.data?.message?.id, 'm-t4', '墓碑应仍遮蔽原轮4 的 assistant（现轮3）')
})

test('载体级联丢弃：墓碑遮蔽的轮被整体切除 → 墓碑行一并消失', async () => {
  const { exciseSessionBuffer } = await loadExcise()
  const rows = baseFixture()
  // 墓碑遮蔽轮3 的 assistant（replace 不进 surface，模拟「已删除的轮」）
  const targetSeq = rows.findIndex((e) => e.type === 'assistant/message' && e.data?.message?.id === 'm-t3')
  rows.push({
    type: 'user/message',
    data: { ...msg('user', 'm-tomb', [], 'dsh-session-kit-turns-del'), source: { kind: 'dsh-session-kit-turns-del', form: 'notice', summary: JSON.stringify({ turn: 3, endTurn: 3 }) } },
    surfaceOp: { op: 'replace', startSeq: targetSeq, endSeq: targetSeq },
    sourceEventSeqs: [targetSeq]
  })
  rows.forEach((e, k) => { e.seq = k; e.time = 1764000000000 + k * 10 })
  const buf = await bufFromRows(rows)
  const result = exciseSessionBuffer(buf, [3], { diagnostic: true })
  assert.deepEqual((result.errors ?? []).filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err))), [], '除 title-bi 外应 0 错')
  const { encodeSessionBuffer, decodeSessionBuffer } = await loadExcise()
  const out = result.buf ?? encodeSessionBuffer(decodeSessionBuffer(buf).headerFrame, result.rows)
  const decoded = await gateAndHostCheck(out, rows.length - 8) // 轮3 七行（插入+consume+五行）+ 墓碑
  assert.ok(!decoded.rows.some((e) => e.data?.source?.kind === 'dsh-session-kit-turns-del'), '无残留墓碑')
})

test('负路径：未闭合轮 / 不存在的轮号 / compaction 相交 / 非法墓碑 JSON', async () => {
  const { exciseSessionBuffer, decodeSessionBuffer } = await loadExcise()
  const buf = await bufFromRows(baseFixture())
  const openRows = [...baseFixture(), { type: 'turn/start', data: { turn: 4 } }]
  const openBuf = await bufFromRows(openRows)
  assert.throws(() => exciseSessionBuffer(openBuf, [1]), /未闭合轮/, '未闭合轮必须拒绝')
  assert.throws(() => exciseSessionBuffer(buf, [9]), /目标轮不存在/, '不存在的轮号必须拒绝')
  // compaction/summary 阴影集与切除段相交 → 抛错（不自动处理）。
  // 阴影集必须覆盖被切轮的 surface 事件（turn/start/step/start 不是 surface，
  // 不参与相交判定），取系统头到轮1 最后一条 assistant 的连续区间。
  const compRows = baseFixture()
  const shadowStart = compRows.findIndex((e) => e.type === 'system/message')
  const shadowEnd = compRows.findIndex((e) => e.type === 'assistant/message' && e.data?.message?.id === 'm-t1-text')
  const shadowedSeqs = []
  for (let s = shadowStart; s <= shadowEnd; s += 1) shadowedSeqs.push(s)
  compRows.push({ type: 'compaction/summary', data: { turn: 3, step: 1, summary: '摘要', shadowedSeqs } })
  compRows.forEach((e, k) => { e.seq = k; e.time = 1764000000000 + k * 10 })
  const compBuf = await bufFromRows(compRows)
  assert.throws(() => exciseSessionBuffer(compBuf, [1]), /阴影集与切除段相交/, 'compaction 相交必须拒绝')
  // 墓碑 summary 非 JSON：保持原样，门禁自行判定
  const badTombRows = [...baseFixture(), {
    type: 'user/message',
    data: { ...msg('user', 'm-badtomb', [], 'dsh-session-kit-turns-del'), source: { kind: 'dsh-session-kit-turns-del', form: 'notice', summary: 'not-json' } },
    surfaceOp: 'append'
  }]
  badTombRows.forEach((e, k) => { e.seq = k; e.time = 1764000000000 + k * 10 })
  const badBuf = await bufFromRows(badTombRows)
  const badResult = exciseSessionBuffer(badBuf, [2], { diagnostic: true })
  assert.deepEqual((badResult.errors ?? []).filter((err) => !GATE_KNOWN_HOST_DEVIATIONS.some((re) => re.test(err))), [], '除 title-bi 外应 0 错')
  // 成功路径产出 buf、无 rows；诊断失败才有 rows。两种形态统一取行。
  const badRows = badResult.rows ?? decodeSessionBuffer(badResult.buf).rows
  const badTomb = badRows.find((e) => e.data?.source?.summary === 'not-json')
  assert.ok(badTomb, '非 JSON summary 原样保留，不崩')
})
