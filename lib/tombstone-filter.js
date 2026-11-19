/**
 * `llm/stream` 请求过滤器：在请求进入任何 provider 适配器之前剔除「墓碑消息」。
 *
 * 【来源】上游 dsh-session-kit 6.4.0 的 tombstone-filter.js（2026-11-19 摘樱桃移植，
 * 见 Desktop\交接文档\任务清单-fork重打-2026-11-19.md T1）。
 *
 * 背景（上游注释照录）：轮次删除与记忆剔除都以 user/message 替换事件（墓碑）遮蔽
 * 被删内容。墓碑本身不该进入模型上下文——历史上这个「不进上下文」的行为依赖
 * 各适配器/协议库各自丢弃空 content，而 openai-responses 是唯一漏口
 * （"" / [] → {type:'input_text',text:''} 仍发送），严格网关二次校验直接 400。
 * 因此在插件层主动剔除，不依赖下游实现细节、对所有渠道生效。
 *
 * 【与上游的口径差异（fork 适配，务必保守）】fork 里 dsh-session-kit- 前缀下住着
 * 五种来源，其中四种是**绝不能剔**的活消息：
 *   - dsh-session-kit-memory-context  记忆召回注入（剔了模型就瞎）
 *   - dsh-session-kit-memory-request  用户要求记住的提示行
 *   - dsh-session-kit-memory-distill  蒸馏提示
 *   - dsh-session-kit-memory-manual   手动注入
 * 因此本文件**精确枚举**墓碑 kind，绝不用前缀宽口径（isKitAuthoredSource 的
 * startsWith 豁免口径是给 repairMessageIdentity 用的，不能搬到这里）。
 *
 * fork 墓碑生产者（实锤于 lib/index.js / lib/memory.js）：
 *   - 轮次删除墓碑：kind = 'dsh-session-kit-turns-del'（TURNS_DEL_PROVIDER）
 *     + 三个历史变体（'dsh-turns-del' / 'plugin:dsh-turns-del' /
 *       'plugin:dsh-session-kit-turns-del'，旧版写入形态）；
 *   - 记忆剔除墓碑：kind = 'dsh-session-kit-memory-eject'（MEMORY_EJECT_PROVIDER，
 *     content 为空数组；fork 无 ejectReason 语义，全部剔除）。
 *
 * 【明确不剔】（不在枚举里即放行）：
 *   - 记忆注入四源（上列）；
 *   - user + rpcId='dsh-turns-del-regenerate:*' 重新生成的重放提问（真实用户消息）；
 *   - dsh-delete-turn 的 'plugin:dsh-delete-turn' 墓碑（正文 '[deleted]' 非空，
 *     不撞 400；DT 重打 T3 时再统一处理）。
 */

/** 轮次删除墓碑的生产者 kind（现役 + 历史变体）。 */
const TOMBSTONE_KINDS = new Set([
  'dsh-session-kit-turns-del',
  'dsh-turns-del',
  'plugin:dsh-turns-del',
  'plugin:dsh-session-kit-turns-del',
  'dsh-session-kit-memory-eject',
]);

/**
 * 判定一条已链式的模型消息是否应从模型上下文中剔除。
 * 只认 source.kind（精确枚举），不看 content 形态。
 * @param {object} message - 一条已链式的模型消息（role/content/source）。
 * @returns {boolean}
 */
export function isTombstoneMessage(message) {
  const source = message?.source;
  if (source === null || typeof source !== 'object') return false;
  return TOMBSTONE_KINDS.has(source.kind);
}

/**
 * 从请求消息数组中剔除墓碑，返回新的请求选项。
 *
 * `options` 已被 agent-loop 的 markAgentLoopRequest(Object.freeze({...})) 冻结，
 * 因此有变化时必须构造新对象，不能原地修改；
 * 无变化时返回原对象（保持对象身份稳定，零额外分配）。
 *
 * @param {object} options - `llm/stream` 收到的完整请求。
 * @returns {object} 剔除墓碑后的请求（必要时为新对象）。
 */
export function filterTombstonesFromRequest(options) {
  const messages = options?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return options;
  const kept = messages.filter((message) => !isTombstoneMessage(message));
  if (kept.length === messages.length) return options;
  return { ...options, messages: kept };
}
