/**
 * dsh-session-kit — safeExcise：真删除（物理切除事件 + 重编号 + 引用修复 + 三层门禁）。
 *
 * 算法原型在 3ddace3a 真实数据上验证通过：切除整轮 → seq 与轮号双重重编号 →
 * 修复 title/surfaceOp/sourceEventSeqs/shadowed 等引用 → 密度+关系状态机+seed
 * 三层门禁 0 错误才允许产出。任何一层不过直接 throw，调用方不得落盘。
 *
 * 纯函数模块：只依赖 node:zlib，可独立测试。
 */
import { zstdDecompressSync, zstdCompressSync, constants } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** 解码多帧日志 → { headerFrame(原始字节), header(JSON), rows[] } */
export function decodeSessionBuffer(buf) {
  const idx = [];
  let i = -1;
  while ((i = buf.indexOf(MAGIC, i + 1)) !== -1) idx.push(i);
  idx.push(buf.length);
  if (idx.length < 2) throw new Error("session log has no complete zstd frame");
  const headerFrame = buf.subarray(0, idx[1]);
  const header = JSON.parse(zstdDecompressSync(headerFrame).toString("utf8"));
  const rows = [];
  for (let k = 1; k < idx.length - 1; k++) {
    const text = zstdDecompressSync(buf.subarray(idx[k], idx[k + 1])).toString("utf8");
    for (const line of text.split("\n")) if (line) rows.push(JSON.parse(line));
  }
  return { headerFrame, header, rows };
}

/** 头帧(原字节) + 单体事件帧 → 新日志字节 */
export function encodeSessionBuffer(headerFrame, rows) {
  const body = rows.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return Buffer.concat([headerFrame, zstdCompressSync(Buffer.from(body, "utf8"), CHECKSUM)]);
}

/**
 * 三层门禁（与 dsh-session 读取路径同规则）：
 * ① seq 密度/信封/seed 结算与消息形状 ② 关系状态机（轮/步/工具） ③ surface 折叠（系统头/替换范围）+ title 引用。
 * 返回错误数组；空 = 通过。
 */
export function exciseGate(rows) {
  const errs = [];
  const SURFACE = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);
  const STEP_TYPES = new Set(["system/message", "developer/message", "assistant/attempt"]);
  const MSG_ROLE = { "system/message": "system", "developer/message": "developer", "user/message": "user", "assistant/message": "assistant", "tool/result": "tool" };
  const isInt = (v) => typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0;
  let turn = null, nextTurn = 1, step = null, nextStep = 1;
  const surface = [];
  let protectedHead;
  const tools = new Map();
  rows.forEach((e, k) => {
    if (e.seq !== k) errs.push(`density@${k}`);
    for (const key of Object.keys(e)) if (!["type", "seq", "time", "data", "surfaceOp", "sourceEventSeqs", "ignorable"].includes(key)) errs.push(`envelope:${key}@${k}`);
    if (e.ignorable !== undefined && e.ignorable !== true) errs.push(`envelope:ignorable@${k}`);
    /* 宿主 delivery 规则（dsh-session-format-v3-to-v4）：v4 水位线必须严格早于 marker，
       否则整份日志拒载。此前门禁缺这条 → “门禁 0 错但宿主拒载”（2026-10-08 3ddace3a 事故）。 */
    if (e.type === "session-log-deepseek/delivery-accepted" && e.data?.sessionFormatVersion === 4 && typeof e.data.throughSeq === "number" && e.data.throughSeq >= e.seq) errs.push(`delivery-watermark@${e.seq}`);
    if (STEP_TYPES.has(e.type) && (turn === null || step === null || e.data.turn !== turn || e.data.step !== step)) errs.push(`requireStep@${e.type}#${e.seq}`);
    if ((e.type === "assistant/attempt" || e.type === "assistant/message") && (!isInt(e.data?.turn) || !isInt(e.data?.step) || !Array.isArray(e.data?.stream))) errs.push(`settlement@${e.seq}`);
    /* 宿主规则（dsh-session-format-v3-to-v4）：developer/message.headerSeq 必须指向
       **更早**的 request/header，否则整份日志拒载（"headerSeq must name an earlier event"）。
       2026-10-11 缺陷：excise 重编号后该字段没跟着改 → 4 条会话被判 corrupt。
       门禁补上这条，与宿主同宽，杜绝"门禁 0 错但宿主拒载"。 */
    if (typeof e.data?.headerSeq === "number") {
      if (!(e.data.headerSeq < e.seq)) errs.push(`headerSeq-order@${e.seq}`);
      else if (rows[e.data.headerSeq]?.type !== "request/header") errs.push(`headerSeq-target@${e.seq}`);
    }
    if (MSG_ROLE[e.type]) {
      const rec = e.type === "user/message" ? e.data : e.data?.message;
      if (typeof rec?.id !== "string" || !rec.id) errs.push(`msg-id@${e.seq}`);
      if (rec?.role !== MSG_ROLE[e.type]) errs.push(`msg-role@${e.seq}`);
      if (typeof rec?.source?.kind !== "string" || !rec.source.kind) errs.push(`msg-source@${e.seq}`);
      if (!Array.isArray(rec?.content)) errs.push(`msg-content@${e.seq}`);
    }
    if (e.type === "request/header") {
      const cfg = e.data?.header?.config;
      if (!cfg || typeof cfg.provider !== "string" || typeof cfg.model !== "string") errs.push(`hdr@${e.seq}`);
      const r = e.data?.reason;
      if (r !== undefined && !["initial", "resume", "change", "series"].includes(r)) errs.push(`hdr-reason@${e.seq}`);
    }
    /* 宿主规则（dsh-session-format-v3-to-v4）：compaction/summary 的 shadowedSeqs 必须
       恰好构成**当前** surface 上的连续 span，否则整份日志拒载
       （"compaction/summary shadowedSeqs do not name an exact current surface span"）。
       2026-10-11 缺陷：excise 重编号后该列表 stale → c9b9a3d7 被判 corrupt。门禁与宿主同宽。 */
    if (e.type === "compaction/summary" && Array.isArray(e.data?.shadowedSeqs) && e.data.shadowedSeqs.length > 0) {
      const sh = e.data.shadowedSeqs;
      const lo = sh[0], hi = sh[sh.length - 1];
      const fi = surface.indexOf(lo), la = surface.indexOf(hi);
      if (fi < 0 || la < fi) errs.push(`compaction-span@${e.seq}(端点不在surface)`);
      else if (la - fi + 1 !== sh.length || surface.slice(fi, la + 1).some((x, i) => x !== sh[i])) {
        errs.push(`compaction-span@${e.seq}(与surface不精确对应)`);
      }
    }
    if (SURFACE.has(e.type)) {
      if (e.type === "system/message" && surface.length > 0 && protectedHead === undefined) errs.push(`syshead@${e.seq}`);
      if (e.surfaceOp === "append") {
        if (e.type === "system/message" && surface.length === 0) protectedHead = e.seq;
        surface.push(e.seq);
      } else if (!e.surfaceOp || typeof e.surfaceOp !== "object") {
        errs.push(`noSurfaceOp@${e.seq}`);
      } else {
        const first = surface.indexOf(e.surfaceOp.startSeq);
        const last = surface.indexOf(e.surfaceOp.endSeq);
        if (first < 0 || last < first) errs.push(`replaceRange@${e.seq}`);
        else {
          const shadowed = surface.slice(first, last + 1);
          /* 宿主 surface 规则：替换必须列出它遮蔽的全部在场节点
             （"replacement sourceEventSeqs omit a shadowed surface node"）。
             sourceEventSeqs 允许嵌套区间 [start,end]（renumberEvent 按此维护），
             比对前必须展开，否则区间内节点被误判缺失 → 假阳性（2026-10-11）。 */
          const srcFlat = [];
          if (Array.isArray(e.sourceEventSeqs)) {
            for (const item of e.sourceEventSeqs) {
              if (Array.isArray(item)) { for (let x = Number(item[0]); x <= Number(item[1]); x += 1) srcFlat.push(x); }
              else srcFlat.push(item);
            }
          }
          if (!Array.isArray(e.sourceEventSeqs) || shadowed.some((s) => !srcFlat.includes(s))) errs.push(`replace-sources@${e.seq}`);
          if (protectedHead !== undefined && shadowed.includes(protectedHead)) {
            if (e.type !== "system/message" || shadowed.length !== 1) errs.push(`shadowHead@${e.seq}`);
            else protectedHead = e.seq;
          }
          surface.splice(first, shadowed.length, e.seq);
        }
      }
    }
    switch (e.type) {
      case "turn/start":
        if (turn !== null || e.data.turn !== nextTurn) errs.push(`turn/start@${e.seq}(${e.data.turn}≠${nextTurn})`);
        turn = e.data.turn;
        nextStep = 1;
        break;
      case "turn/end":
        if (turn === null || e.data.turn !== turn || step !== null) errs.push(`turn/end@${e.seq}`);
        if (tools.size) errs.push(`turn/end:openTools@${e.seq}`);
        tools.clear();
        turn = null;
        nextTurn += 1;
        break;
      case "step/start":
        if (turn === null || e.data.turn !== turn || step !== null || e.data.step !== nextStep) errs.push(`step/start@${e.seq}`);
        step = e.data.step;
        break;
      case "step/end":
        if (turn === null || step === null || e.data.turn !== turn || e.data.step !== step) errs.push(`step/end@${e.seq}`);
        if (tools.size) errs.push(`step/end:openTools@${e.seq}`);
        tools.clear();
        step = null;
        nextStep += 1;
        break;
      case "session/title":
        if (Array.isArray(e.data?.messageSeqs)) {
          const isUser = e.data.source?.kind === "user";
          if ((e.data.messageSeqs.length === 0) !== !!isUser) errs.push(`title-bi@${e.seq}`);
          for (const r of e.data.messageSeqs) {
            const src = rows[r];
            if (r >= e.seq || !src || src.type !== "user/message" || src.data?.source?.kind !== "user") errs.push(`title-ref@${e.seq}→${r}`);
          }
        }
        break;
      case "assistant/message":
        for (const b of e.data?.message?.content ?? []) {
          if (b.type === "tool-call") {
            if (tools.has(b.id)) errs.push(`tool-dup@${e.seq}`);
            tools.set(b.id, { name: b.name, arguments: b.arguments, started: false });
          }
        }
        break;
      case "tool/call": {
        const p = tools.get(e.data.callId);
        if (!p) errs.push(`call-noadv@${e.seq}`);
        else {
          if (p.started || p.name !== e.data.name || p.arguments !== e.data.arguments) errs.push(`call-mismatch@${e.seq}`);
          p.started = true;
        }
        break;
      }
      case "tool/result": {
        const id = e.data.message?.toolCallId ?? e.data.callId;
        if (!tools.has(id)) errs.push(`result-noadv@${e.seq}`);
        else tools.delete(id);
        break;
      }
    }
  });
  if (turn !== null) errs.push(`turn-not-closed:${turn}`);
  if (protectedHead === undefined) errs.push("no-system-head");
  return errs;
}

/**
 * 切除指定轮次的全部事件 → 重编号（seq + 轮号）→ 修引用 → 门禁。
 * @returns { buf, stats:{removedRows, removedTurns, rowsBefore, rowsAfter} }
 * @throws 门禁不过 / compaction 阴影集相交 / 输入已破损（先修再切）
 */
export function exciseSessionBuffer(buf, turnsToRemove, options = {}) {
  const { headerFrame, rows } = decodeSessionBuffer(buf);
  // 基线破损不单独拒绝：若切除范围恰好覆盖断口，切除+重编号本身可能修复它（原型已验证）；
  // 修复不了也没关系——最终门禁必然挂掉，安全契约由 output 门禁统一承担。
  const baseline = exciseGate(rows);
  if (!turnsToRemove || !turnsToRemove.length) throw new Error("turnsToRemove 为空");
  const removeTurns = new Set(turnsToRemove.map(Number));
  // 1) 定位轮窗口（turn/start .. turn/end 含）
  const removeSeqs = new Set();
  let open = null;
  for (const e of rows) {
    if (e.type === "turn/start") open = { turn: e.data.turn, start: e.seq };
    if (e.type === "turn/end" && open) {
      if (removeTurns.has(open.turn)) for (let s = open.start; s <= e.seq; s++) removeSeqs.add(s);
      open = null;
    }
  }
  if (open !== null) throw new Error("会话存在未闭合轮，拒绝切除");
  const foundTurns = new Set();
  for (const e of rows) if (e.type === "turn/start" && removeTurns.has(e.data.turn)) foundTurns.add(e.data.turn);
  const missing = [...removeTurns].filter((t) => !foundTurns.has(t));
  if (missing.length) throw new Error(`目标轮不存在: ${missing.join(",")}`);

  /* 1.5) 喂给被删轮的 inbox INSERT 落在轮窗口**外**（insert 先于 turn/start、consume 在窗口内）。
     只切窗口会留下「有插入无消费」的孤儿队列 —— 幽灵提示词会重新灌进模型上下文，
     等于真删除没删干净。按 FIFO 配对 insert→consume，凡消费点落在切除集内的插入一并切除。 */
  const inboxQueue = [];
  const orphanInsertSeqs = new Set();
  for (const e of rows) {
    if (e.type !== "agent/inbox/spliced") continue;
    const data = e.data;
    if (Array.isArray(data.inserted)) for (let k = 0; k < data.inserted.length; k += 1) inboxQueue.push(e.seq);
    const consumed = Number.isSafeInteger(data.removedCount) ? data.removedCount : 0;
    for (let k = 0; k < consumed && inboxQueue.length > 0; k += 1) {
      const insertSeq = inboxQueue.shift();
      if (removeSeqs.has(e.seq) && !removeSeqs.has(insertSeq)) orphanInsertSeqs.add(insertSeq);
    }
  }
  for (const s of orphanInsertSeqs) removeSeqs.add(s);

  const kept = rows.filter((e) => !removeSeqs.has(e.seq));

  /* 1.6) 队列守恒：输出里任何一次消费都不得超出此前的插入（否则引用空队列），
     且终态不得残留被切轮次遗留的孤儿插入。违约直接 throw，交由调用方不落盘。 */
  {
    const q = [];
    for (const e of kept) {
      if (e.type !== "agent/inbox/spliced") continue;
      const data = e.data;
      if (Array.isArray(data.inserted)) for (let k = 0; k < data.inserted.length; k += 1) q.push(e.seq);
      const consumed = Number.isSafeInteger(data.removedCount) ? data.removedCount : 0;
      if (consumed > q.length) throw new Error(`inbox 队列被掏空：seq${e.seq} 消费 ${consumed} 但仅存 ${q.length}`);
      for (let k = 0; k < consumed; k += 1) q.shift();
    }
    if (q.length > 0) throw new Error(`inbox 输出残留 ${q.length} 条孤儿插入 (seq ${q.join(",")})，拒绝产出`);
  }
  /* 1.7) 载体丢弃必须先于 seqMap 构建，否则编号与实际输出错位。
     surfaceOp 两端都消失的载体行（无可复活内容）会在下方 `continue` 被丢弃；
     若先按 kept 建 seqMap，输出比 seqMap 假定的少 N 行 → 之后所有引用右偏 N 位
     （2026-10-11 实测 c9b9a3d7 偏 2 位：巨型墓碑 endSeq 1844 而实际 1842）。
     还要处理级联：载体 A 的端点若是另一个被丢载体 B 的 seq，A 也须跟着丢。 */
  const isCarrier = (e) => e.surfaceOp !== null && typeof e.surfaceOp === "object" && Number.isSafeInteger(e.surfaceOp.startSeq) && Number.isSafeInteger(e.surfaceOp.endSeq);
  const valid = new Set(kept.map((e) => e.seq));
  const dropCarrier = new Set();
  let cascade = true;
  while (cascade) {
    cascade = false;
    for (const e of kept) {
      if (dropCarrier.has(e.seq) || !isCarrier(e)) continue;
      if (!valid.has(e.surfaceOp.startSeq) && !valid.has(e.surfaceOp.endSeq)) {
        dropCarrier.add(e.seq);
        valid.delete(e.seq);
        cascade = true;
      }
    }
  }
  const finalKept = dropCarrier.size ? kept.filter((e) => !dropCarrier.has(e.seq)) : kept;

  const seqMap = new Map();
  finalKept.forEach((e, n) => seqMap.set(e.seq, n));
  const typeBySeq = new Map(rows.map((e) => [e.seq, e.type]));
  /* 单值 seq 引用的落点：命中直接映射；目标被切则吸附到最近的存活 seq（**绝不能保留旧号** ——
     旧号在新空间指向幽灵位置）。向低吸附优先（语义上"更早"更安全）。 */
  const snapSeq = (v) => {
    if (!Number.isSafeInteger(v)) return v;
    if (seqMap.has(v)) return seqMap.get(v);
    let lo;
    for (const s of seqMap.keys()) if (s < v && (lo === undefined || s > lo)) lo = s;
    return lo === undefined ? v : seqMap.get(lo);
  };
  const removedBefore = (t) => [...removeTurns].filter((x) => x < t).length;
  const renumTurn = (t) => t - removedBefore(t);

  // 2) 逐事件修引用
  const out = [];
  for (const e of finalKept) {
    const ev = JSON.parse(JSON.stringify(e));
    if (typeof ev.data?.turn === "number") ev.data.turn = renumTurn(ev.data.turn);
    /* 墓碑的轮号存在 source.summary 这个 JSON 字符串里（turn/endTurn），不在 data.turn，
       上一行改不到它 —— 这正是 2026-10-11「墓碑漂移吞消息」的根因：真删除切走前面几轮后
       轮号全体下移，墓碑仍停在旧号，隐藏层按旧号匹配就把新消息当删除目标吞掉。
       这里同步重排，让墓碑永远指向它当初遮蔽的那批事件。 */
    if (ev.type === "user/message" && ev.surfaceOp && typeof ev.surfaceOp === "object"
      && Array.isArray(ev.data?.content) && ev.data.content.length === 0
      && typeof ev.data?.source?.summary === "string" && ev.data.source.summary.length > 0) {
      try {
        const meta = JSON.parse(ev.data.source.summary);
        if (meta && typeof meta === "object" && Number.isSafeInteger(meta.turn)) {
          meta.turn = renumTurn(meta.turn);
          if (Number.isSafeInteger(meta.endTurn)) meta.endTurn = renumTurn(meta.endTurn);
          ev.data.source = { ...ev.data.source, summary: JSON.stringify(meta) };
        }
      } catch { /* summary 非 JSON：保持原样，门禁与 tombstone 解析会各按其规则处理 */ }
    }
    if (ev.type === "session/title" && Array.isArray(ev.data?.messageSeqs)) {
      const mapped = [];
      for (const s of ev.data.messageSeqs) if (seqMap.has(s)) mapped.push(seqMap.get(s));
      ev.data.messageSeqs = mapped;
      if (mapped.length === 0 && ev.data.source?.kind !== "user") ev.data.source = { kind: "user" };
    }
    if (ev.surfaceOp && typeof ev.surfaceOp === "object") {
      const st = seqMap.get(ev.surfaceOp.startSeq);
      const en = seqMap.get(ev.surfaceOp.endSeq);
      if (st === undefined && en === undefined) continue; // 阴影集全被切 → 载体丢弃（无可复活内容）
      let s = st, t2 = en;
      if (s === undefined) {
        for (let x = ev.surfaceOp.startSeq + 1; x <= ev.surfaceOp.endSeq; x++) if (seqMap.has(x)) { s = seqMap.get(x); break }
      }
      if (t2 === undefined) {
        for (let x = ev.surfaceOp.endSeq - 1; x >= ev.surfaceOp.startSeq; x--) if (seqMap.has(x)) { t2 = seqMap.get(x); break }
      }
      if (s === undefined || t2 === undefined || s > t2) continue;
      ev.surfaceOp = { op: "replace", startSeq: s, endSeq: t2 };
    }
    /* sourceEventSeqs 允许嵌套区间 [start,end]（renumberEvent 也按此维护）。
       区间元素是数组，`seqMap.has([a,b])` 恒为 false → 整段被吃掉，
       输出缺节点 → replace-sources 假错（2026-10-11 缺陷C）。 */
    const mapSrcItem = (item) => {
      /* 展开旧表示（标量或 [start,end] 区间）→ 逐点过 seqMap → 丢弃被切点。
         注意不能把区间映射成两个端点：那会丢掉区间内部未被切的节点。 */
      const expanded = [];
      if (Array.isArray(item)) {
        const lo = Number(item[0]), hi = Number(item[1]);
        if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) return [];
        for (let x = lo; x <= hi; x += 1) expanded.push(x);
      } else expanded.push(item);
      const mapped = [];
      for (const s of expanded) if (seqMap.has(s)) mapped.push(seqMap.get(s));
      return mapped;
    };
    if (Array.isArray(ev.data?.sourceEventSeqs)) {
      ev.data.sourceEventSeqs = ev.data.sourceEventSeqs.flatMap(mapSrcItem);
    }
    if (Array.isArray(ev.sourceEventSeqs)) {
      ev.sourceEventSeqs = ev.sourceEventSeqs.flatMap(mapSrcItem);
    }
    /* shadowedSeqs **必须无条件** remap。旧实现只在"有元素被删"时才映射 —— 但只要切除段在
       这批 seq 之前，整个 seq 空间就左移了，即使一个元素都没被删也已 stale
       （2026-10-11 缺陷 D：c9b9a3d7 切 [17,26] 后 shadowedSeqs 仍指旧号 42..1859，
        宿主报 "compaction/summary shadowedSeqs do not name an exact current surface span"）。
       映射不到的一律**丢弃**（该 seq 连同其载体已从 surface 消失），不能保留旧号 ——
       保留会让 shadowedSeqs 比实际 span 多出幽灵项 → 仍是 stale span（2026-10-11 实测 921/1197）。 */
    if (Array.isArray(ev.data?.shadowedSeqs)) {
      ev.data.shadowedSeqs = ev.data.shadowedSeqs.filter((s) => seqMap.has(s)).map((s) => seqMap.get(s));
    }
    /* 以下三个 seq 引用字段此前被 excise 漏掉（SEQ_REF_RULES 里 adapter-compat 早有）：
       漏 remap → 重编号后指向错位 → 宿主拒载（2026-10-11 缺陷 D，4 条会话被判 corrupt）。 */
    // data.headerSeq：developer/message 指向其 request/header。目标被切则退到最近的存活更早 header；
    // 实在没有就删字段（无 tool-addition 时宿主本就要求省略），门禁会兜底。
    if (typeof ev.data?.headerSeq === "number") {
      const oldH = ev.data.headerSeq;
      if (seqMap.has(oldH)) ev.data.headerSeq = seqMap.get(oldH);
      else {
        let best;
        for (const s of seqMap.keys()) if (s < oldH && (best === undefined || s > best) && typeBySeq.get(s) === "request/header") best = s;
        if (best !== undefined) ev.data.headerSeq = seqMap.get(best);
        else delete ev.data.headerSeq;
      }
    }
    // compaction 阴影区间：端点被切时吸附到最近的存活 seq（保留旧号会指向幽灵位置）
    if (ev.data?.shadowedRange && typeof ev.data.shadowedRange === "object") {
      const sr = { ...ev.data.shadowedRange };
      if (Number.isSafeInteger(sr.start)) sr.start = snapSeq(sr.start);
      if (Number.isSafeInteger(sr.end)) sr.end = snapSeq(sr.end);
      if (sr.start > sr.end) { const t = sr.start; sr.start = sr.end; sr.end = t; }
      ev.data.shadowedRange = sr;
    }
    // 单值溯源（command/done 等）
    if (Number.isSafeInteger(ev.data?.sourceEventSeq)) {
      ev.data.sourceEventSeq = snapSeq(ev.data.sourceEventSeq);
    }
    /* delivery 水位线随重编号映射：目标幸存 → 新 seq；目标被切 → 退到最近的幸存前驱。
       保序双射 ⇒ 映射值必然早于 marker 自身（重编号后仍成立，见下方终态兜底）。 */
    if (typeof ev.data?.throughSeq === "number" && ev.data?.sessionFormatVersion === 4) {
      const oldW = ev.data.throughSeq;
      let mapped = seqMap.get(oldW);
      if (mapped === undefined) {
        let best;
        for (const s of seqMap.keys()) if (s < oldW && (best === undefined || s > best)) best = s;
        mapped = best === undefined ? 0 : seqMap.get(best);
      }
      ev.data.throughSeq = mapped;
    }
    /* 守卫必须比**原始**事件 e（remap 前的旧 seq 空间），因为 removeSeqs 也是旧空间。
       若比 remap 后的 ev，映射值会与旧号空间混淆 → 假相交（2026-10-11 自己踩的坑）。 */
    if (e.type === "compaction/prune" || e.type === "compaction/summary") {
      const shadow = Array.isArray(e.data?.shadowedSeqs) ? e.data.shadowedSeqs : [];
      if (shadow.some((s) => removeSeqs.has(s))) throw new Error(`compaction 事件 seq${e.seq} 阴影集与切除段相交，拒绝自动处理`);
    }
    out.push(ev);
  }
  // 3) seq 重编号
  out.forEach((e, n) => { e.seq = n });
  // 终态兜底：delivery 水位线必须严格早于 marker 自身（宿主 delivery 规则）
  for (const e of out) if (typeof e.data?.throughSeq === "number" && e.data.throughSeq >= e.seq) e.data.throughSeq = Math.max(0, e.seq - 1);

  // 4) 门禁（安全契约：0 错才产出）
  // options.diagnostic：诊断用 —— 门禁不过时不抛，返回错误清单供调用方比对基线，
  // 判断"新增错"还是"基线遗留错"。默认（不传）行为完全不变：0 错才产出。
  const errs = exciseGate(out);
  if (errs.length && options?.diagnostic === true) {
    return {
      ok: false,
      errors: errs,
      baseline,
      rows: out,
      stats: { removedRows: rows.length - out.length, removedTurns: [...removeTurns].sort((a, b) => a - b), rowsBefore: rows.length, rowsAfter: out.length },
    };
  }
  if (errs.length) throw new Error(`门禁不过（输出 ${errs.length} 错${baseline.length ? `，输入基线 ${baseline.length} 错` : ""}），未产出: ${errs.slice(0, 6).join(" | ")}`);

  return {
    buf: encodeSessionBuffer(headerFrame, out),
    stats: { removedRows: rows.length - out.length, removedTurns: [...removeTurns].sort((a, b) => a - b), rowsBefore: rows.length, rowsAfter: out.length },
  };
}
