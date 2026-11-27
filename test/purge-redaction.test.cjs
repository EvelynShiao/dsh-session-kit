/* purgeDeletedOnDisk 回归测试（2026-11-26 物理真删除）
 *
 * 覆盖「删掉的那一段 seq 区间，盘上不得留下任何正文」这条硬约束，具体包括：
 *  - 普通 user/message、assistant/message、assistant/attempt.stream
 *  - 注入型 user/message：正文在 data.source.sections[].text（memory-context / tasks / 时间…）
 *  - agent/inbox/spliced 的 inserted[] 双写副本（按 message id 命中）
 *  - session/title、session/title-llm-request（引用被删 seq 时标题与 LLM 请求一并清）
 *  - 区间外的轮次一个字都不许动
 *  - 幂等：第二次 purge 返回 erased=0
 *
 * 背景（真机实证）：旧实现在活体会话上只清 surface 选择集 + REDACT_TYPES，
 * 漏了 source.sections 和 inbox 副本 —— 用户删掉的正文仍能从文件里读出来。
 *
 * 说明：index.js 依赖 @deepseek-ai/*，仓库副本没有 node_modules，导入失败时
 * 退到本机装机副本（与本仓保持 md5 一致，是本项目测试的既有惯例）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { zstdCompressSync, constants } = require('node:zlib')

const INSTALLED = 'C:/Users/Evelyn/Documents/deepseek-harness/default-workspace/restored-plugins-ready/dsh-session-kit/lib/index.js'
const EXCISE = path.join(__dirname, '..', 'lib', 'excise.js')

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

let mod
async function loadPlugin() {
  if (mod) return mod
  const candidates = [path.join(__dirname, '..', 'lib', 'index.js'), INSTALLED]
  let lastError
  for (const candidate of candidates) {
    try {
      mod = await import(pathToFileURL(candidate).href)
      return mod
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const msg = (role, id, text, kind = 'user') => ({ id, role, content: [{ type: 'text', text }], source: { kind } })

function buildRows() {
  const rows = [
    /* ── 第 1 轮（必须原样保留）──────────────────────────────── */
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [msg('user', 'u1', 'KEEP1 第一轮提问原文')] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: { turn: 1, step: 1, ...msg('user', 'u1', 'KEEP1 第一轮提问原文') }, surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { ...msg('assistant', 'a1', 'KEEP1 第一轮回答原文'), source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [{ type: 'text', text: 'KEEP1 第一轮流式原文' }] }, surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 } },

    /* ── 第 2 轮（本次删除目标：这一整段都必须清空）──────────── */
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [msg('user', 'u2', 'DROP2 双写副本原文')] } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'step/start', data: { turn: 2, step: 1 } },
    { type: 'system/message', data: { turn: 2, step: 1, message: { id: 'sys2', role: 'system', content: [{ type: 'text', text: 'DROP2 系统头原文' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' },
    { type: 'user/message', data: { turn: 2, step: 1, ...msg('user', 'u2', 'DROP2 第二轮提问原文') }, surfaceOp: 'append' },
    /* 注入型：正文挂在 source.sections[].text 上，data 里没有 turn 字段 */
    { type: 'user/message', data: { id: 'ctx2', role: 'user', content: [], source: { kind: 'dsh-session-kit-memory-context', form: 'snapshot', sections: [{ name: 'memories', text: 'DROP2 记忆召回原文' }] } }, surfaceOp: 'append' },
    { type: 'session/title-llm-request', data: { titleProvider: 'first-prompt', messageSeqs: [16], system: 'DROP2 标题系统提示', messages: [{ role: 'user', content: [{ type: 'text', text: 'DROP2 标题请求正文' }] }] } },
    { type: 'session/title', data: { title: 'DROP2 自动标题', messageSeqs: [16], source: { kind: 'fallback' } } },
    { type: 'assistant/attempt', data: { turn: 2, step: 1, stream: [{ type: 'text', text: 'DROP2 思考原文' }] } },
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { ...msg('assistant', 'a2', 'DROP2 第二轮回答原文'), source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [{ type: 'text', text: 'DROP2 回答流式原文' }] }, surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 2, step: 1 } },
    { type: 'turn/end', data: { turn: 2 } }
  ]
  rows.forEach((row, index) => { row.seq = index; row.time = 1764000000000 + index * 10 })
  return rows
}

function header() {
  return { type: 'session', version: 4, id: 'session-purge-fixture', createdAt: 1764000000000, cwd: 'C:\\fixture', isSeeded: false, delegationDepth: 0 }
}

function encode(rows) {
  const head = zstdCompressSync(Buffer.from(JSON.stringify(header()) + '\n', 'utf8'), CHECKSUM)
  const body = zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8'), CHECKSUM)
  return Buffer.concat([head, body])
}

function writeFixture(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-purge-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, encode(rows))
  return file
}

test('purge：被删轮次的全部正文载体都清空，区间外的字一个不动', async () => {
  const plugin = await loadPlugin()
  const excise = await import(pathToFileURL(EXCISE).href)

  const rows = buildRows()
  const file = writeFixture(rows)
  const startTurn2 = rows.find((row) => row.type === 'turn/start' && row.data.turn === 2).seq
  const removeSeqs = new Set(rows.filter((row) => row.seq >= startTurn2).map((row) => row.seq))

  const stats = plugin.purgeDeletedOnDisk(file, removeSeqs)
  assert.ok(stats.erased > 0, 'purge 必须真的动过行')

  const { rows: after } = excise.decodeSessionBuffer(fs.readFileSync(file))
  assert.equal(after.length, rows.length, '行数必须不变（只清正文不删行）')

  const text = JSON.stringify(after)
  for (const marker of ['DROP2 双写副本原文', 'DROP2 系统头原文', 'DROP2 第二轮提问原文', 'DROP2 记忆召回原文', 'DROP2 标题请求正文', 'DROP2 标题系统提示', 'DROP2 自动标题', 'DROP2 思考原文', 'DROP2 第二轮回答原文', 'DROP2 回答流式原文']) {
    assert.equal(text.includes(marker), false, `残留正文：${marker}`)
  }
  for (const marker of ['KEEP1 第一轮提问原文', 'KEEP1 第一轮回答原文', 'KEEP1 第一轮流式原文']) {
    assert.equal(text.includes(marker), true, `区间外内容被误删：${marker}`)
  }
  /* 结构必须保住：user/assistant 行还在，tombstone/占位不参与本用例 */
  assert.equal(after.filter((row) => row.type === 'user/message').length, 3)
  assert.equal(after.filter((row) => row.type === 'assistant/message').length, 2)

  /* 幂等：第二次没东西可擦 */
  assert.equal(plugin.purgeDeletedOnDisk(file, removeSeqs).erased, 0)

  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

