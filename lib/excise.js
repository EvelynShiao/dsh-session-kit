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
             （"replacement sourceEventSeqs omit a shadowed surface node"）。 */
          if (!Array.isArray(e.sourceEventSeqs) || shadowed.some((s) => !e.sourceEventSeqs.includes(s))) errs.push(`replace-sources@${e.seq}`);
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
export function exciseSessionBuffer(buf, turnsToRemove) {
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

  const kept = rows.filter((e) => !removeSeqs.has(e.seq));
  const seqMap = new Map();
  kept.forEach((e, n) => seqMap.set(e.seq, n));
  const removedBefore = (t) => [...removeTurns].filter((x) => x < t).length;
  const renumTurn = (t) => t - removedBefore(t);

  // 2) 逐事件修引用
  const out = [];
  for (const e of kept) {
    const ev = JSON.parse(JSON.stringify(e));
    if (typeof ev.data?.turn === "number") ev.data.turn = renumTurn(ev.data.turn);
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
    if (Array.isArray(ev.data?.sourceEventSeqs)) {
      const m = [];
      for (const s of ev.data.sourceEventSeqs) if (seqMap.has(s)) m.push(seqMap.get(s));
      ev.data.sourceEventSeqs = m;
    }
    if (Array.isArray(ev.sourceEventSeqs)) {
      const m = [];
      for (const s of ev.sourceEventSeqs) if (seqMap.has(s)) m.push(seqMap.get(s));
      ev.sourceEventSeqs = m;
    }
    if (Array.isArray(ev.data?.shadowedSeqs)) {
      if (ev.data.shadowedSeqs.some((s) => removeSeqs.has(s))) {
        const m = [];
        for (const s of ev.data.shadowedSeqs) if (seqMap.has(s)) m.push(seqMap.get(s));
        ev.data.shadowedSeqs = m;
      }
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
    if (ev.type === "compaction/prune" || ev.type === "compaction/summary") {
      const shadow = Array.isArray(ev.data?.shadowedSeqs) ? ev.data.shadowedSeqs : [];
      if (shadow.some((s) => removeSeqs.has(s))) throw new Error(`compaction 事件 seq${ev.seq} 阴影集与切除段相交，拒绝自动处理`);
    }
    out.push(ev);
  }
  // 3) seq 重编号
  out.forEach((e, n) => { e.seq = n });
  // 终态兜底：delivery 水位线必须严格早于 marker 自身（宿主 delivery 规则）
  for (const e of out) if (typeof e.data?.throughSeq === "number" && e.data.throughSeq >= e.seq) e.data.throughSeq = Math.max(0, e.seq - 1);

  // 4) 门禁（安全契约：0 错才产出）
  const errs = exciseGate(out);
  if (errs.length) throw new Error(`门禁不过（输出 ${errs.length} 错${baseline.length ? `，输入基线 ${baseline.length} 错` : ""}），未产出: ${errs.slice(0, 6).join(" | ")}`);

  return {
    buf: encodeSessionBuffer(headerFrame, out),
    stats: { removedRows: removeSeqs.size, removedTurns: [...removeTurns].sort((a, b) => a - b), rowsBefore: rows.length, rowsAfter: out.length },
  };
}
