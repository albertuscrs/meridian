// /observe Telegram reports: parse daily agent logs + action JSONL to summarize
// close reasons, OOR exit alerts, and Safety-Lock / Pump-Hold / R8 holds.
import readline from "readline";
import { createReadStream } from "fs";
import { config } from "./config.js";
import { htmlEscape } from "./display.js";

export function categorizeCloseReason(reason) {
  if (!reason) return "Other";
  const r = reason.toLowerCase();
  if (r.includes("trailing tp") && (r.includes("oor") || r.includes("trailing armed"))) return "Trailing TP (OOR)";
  if (r.includes("trailing tp")) return "Trailing TP";
  if (r.includes("low yield")) return "Low yield";
  if (r.includes("stop loss")) return "Stop loss";
  if (r.includes("rule 3") || r.includes("pumped")) return "Pump (R3)";
  if (r.includes("take profit")) return "Take profit";
  if (r.includes("r8 held")) return "R8-held";
  if (r.includes("oor") || r.includes("out of range")) return "OOR";
  if (r.includes("manual")) return "Manual";
  return "Other";
}

async function parseLogDates(dates) {
  const logsDir = new URL("./logs", import.meta.url).pathname;
  const closedPositions = [], exitAlerts = [];
  let errorCount = 0, safetyLockCount = 0, pumpHoldCount = 0, r8HoldCount = 0;
  for (const dateStr of dates) {
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/agent-${dateStr}.log`), crlfDelay: Infinity });
      for await (const line of rl) {
        const m = line.match(/\[PnL poll\] Exit alert: (\S+) — (.+?) — triggering/);
        if (m) { const tsM = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/); exitAlerts.push({ ts: tsM?.[1] ?? dateStr, pair: m[1], reason: m[2] }); }
        if (/\[ERROR\]/.test(line)) errorCount++;
        if (/Safety-Lock:/.test(line)) safetyLockCount++;
        if (/Pump-Hold:/.test(line)) pumpHoldCount++;
        if (/R8 hold:/.test(line)) r8HoldCount++;
      }
    } catch {}
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/actions-${dateStr}.jsonl`), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.tool === "close_position" && entry.success !== false) {
            const result = typeof entry.result === "string"
              ? (() => { try { return JSON.parse(entry.result); } catch { return {}; } })()
              : (entry.result ?? {});
            closedPositions.push({ ts: entry.timestamp, pair: result.pool_name ?? "?", reason: entry.args?.reason ?? "?", pnl_pct: result.pnl_pct ?? null, pnl_usd: result.pnl_usd ?? null });
          }
        } catch {}
      }
    } catch {}
  }
  return { closedPositions, exitAlerts, errorCount, safetyLockCount, pumpHoldCount, r8HoldCount };
}

export async function buildObserveReport({ days = 1, details = false } = {}) {
  const now = new Date();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const { closedPositions, exitAlerts, errorCount, safetyLockCount, pumpHoldCount, r8HoldCount } = await parseLogDates(dates);

  const oorAlerts = exitAlerts.filter(a => /oor|out.of.range/i.test(a.reason));
  const oorAbove  = exitAlerts.filter(a => /OOR above/i.test(a.reason));
  const oorBelow  = exitAlerts.filter(a => /OOR below/i.test(a.reason));
  const trailingArmedClosed = closedPositions.filter(p => /trailing armed|Trailing TP: OOR/i.test(p.reason));

  const cats = {};
  for (const p of closedPositions) { const cat = categorizeCloseReason(p.reason); cats[cat] = (cats[cat] ?? 0) + 1; }

  const profile = config.management.closeProfile ?? "main";
  const label = days === 1 ? "today" : `last ${days}d`;

  const lines = [`<b>📡 Observe — ${label} | profile: ${profile}</b>`, "", `<b>Closes: ${closedPositions.length}</b>`];
  if (Object.keys(cats).length > 0) {
    for (const [cat, n] of Object.entries(cats).sort((a, b) => b[1] - a[1])) lines.push(`  ${cat}: ${n}`);
  } else {
    lines.push("  No closes recorded.");
  }

  lines.push(
    "", `<b>OOR exit alerts: ${oorAlerts.length}</b>`,
    `  Above: ${oorAbove.length}`, `  Below: ${oorBelow.length}`,
    `  Trailing-armed closes: ${trailingArmedClosed.length}`,
    `  Safety-Lock holds: ${safetyLockCount}`, `  Pump-Hold holds: ${pumpHoldCount}`, `  R8 holds: ${r8HoldCount}`,
  );

  if (errorCount > 0) lines.push("", `⚠️ Errors in log: ${errorCount}`);

  if (details) {
    lines.push("");
    if (trailingArmedClosed.length > 0) {
      lines.push("<b>Trailing-armed OOR closes</b>");
      trailingArmedClosed.slice(-10).forEach((p) => {
        const pnl = p.pnl_pct != null ? ` | ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "";
        const usd = p.pnl_usd != null ? ` (${p.pnl_usd >= 0 ? "+" : ""}$${Math.abs(p.pnl_usd).toFixed(3)})` : "";
        lines.push(`  ${htmlEscape(p.pair)}${pnl}${usd}`);
        lines.push(`  <i>${htmlEscape(p.reason.slice(0, 90))}</i>`);
      });
    } else {
      lines.push("No trailing-armed OOR closes found.");
    }
  }

  return lines.join("\n");
}

export async function buildObserveCompare(baselineDays = null, currentDays = null) {
  const logsDir = new URL("./logs", import.meta.url).pathname;
  const now = new Date();

  // Scan up to 14d back for most recent closeProfile change in agent logs
  let boundaryTs = null, fromProfile = null, toProfile = null;
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/agent-${dateStr}.log`), crlfDelay: Infinity });
      for await (const line of rl) {
        const m = line.match(/update_config: config\.management\.closeProfile (\S+) \S+ (\S+) \(/);
        if (m) {
          const tsM = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
          const ts = tsM?.[1];
          if (ts && (!boundaryTs || ts > boundaryTs)) { boundaryTs = ts; fromProfile = m[1]; toProfile = m[2]; }
        }
      }
    } catch {}
  }

  // Compute period sizes
  let curDays, baseDays;
  if (boundaryTs) {
    const msSince = now.getTime() - new Date(boundaryTs).getTime();
    const defaultCur = Math.max(1, Math.min(Math.ceil(msSince / 86400000), 7));
    curDays  = currentDays  ?? defaultCur;
    baseDays = baselineDays ?? Math.max(2, curDays * 2);
  } else {
    curDays  = currentDays  ?? 2;
    baseDays = baselineDays ?? 4;
  }

  function buildDates(skip, count) {
    const d = [];
    for (let i = skip; i < skip + count; i++) { const x = new Date(now); x.setDate(x.getDate() - i); d.push(x.toISOString().slice(0, 10)); }
    return d;
  }

  const [cur, base] = await Promise.all([
    parseLogDates(buildDates(0, curDays)),
    parseLogDates(buildDates(curDays, baseDays)),
  ]);

  function cats(positions) {
    const c = {};
    for (const p of positions) { const cat = categorizeCloseReason(p.reason); c[cat] = (c[cat] ?? 0) + 1; }
    return c;
  }
  const bc = cats(base.closedPositions), cc = cats(cur.closedPositions);
  const allCats = [...new Set([...Object.keys(bc), ...Object.keys(cc)])].sort();

  const COL1 = 18, COL2 = 10, COL3 = 10;
  function row(label, b, c) {
    return label.padEnd(COL1) + (b == null ? "n/a" : String(b)).padStart(COL2) + (c == null ? "n/a" : String(c)).padStart(COL3);
  }
  const SEP = "─".repeat(COL1 + COL2 + COL3);

  const avgBase = (base.closedPositions.length / baseDays).toFixed(1);
  const avgCur  = (cur.closedPositions.length  / curDays).toFixed(1);

  const header = boundaryTs
    ? `<b>📊 Compare</b>\nBoundary: ${boundaryTs.slice(0, 16).replace("T", " ")} UTC (${fromProfile} → ${toProfile})`
    : `<b>📊 Compare</b>\nNo profile change found — ${curDays}d vs prior ${baseDays}d`;

  const tableLines = [
    row("", `Base (${baseDays}d)`, `Cur (${curDays}d)`), SEP,
    row("Closes total", base.closedPositions.length, cur.closedPositions.length),
    ...allCats.map(cat => row("  " + cat, bc[cat] ?? 0, cc[cat] ?? 0)),
    SEP,
    row("Safety-Lock holds", null, cur.safetyLockCount),
    row("Pump-Hold holds", null, cur.pumpHoldCount),
    row("Errors", base.errorCount, cur.errorCount),
    row("Profile", fromProfile ?? "main", toProfile ?? (config.management.closeProfile ?? "main")),
    row("Avg closes/day", avgBase, avgCur),
  ];

  return `${header}\n\n<code>${tableLines.join("\n")}</code>`;
}

export async function buildObserveHeld() {
  const logsDir = new URL("./logs", import.meta.url).pathname;
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const holdsByAddr = new Map();

  const today     = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  for (const dateStr of [yesterday, today]) {
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/agent-${dateStr}.log`), crlfDelay: Infinity });
      for await (const line of rl) {
        const tsM = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
        const ts = tsM?.[1];
        if (!ts || ts < cutoff) continue;

        const sl = line.match(/Safety-Lock: (\S+) OOR (above|below) for (\d+)m but PnL (-?[\d.]+|\?)% .+ holding \(profile: (\S+)\)/);
        if (sl) {
          const [, addr, dir, mins, pnl, prof] = sl;
          const existing = holdsByAddr.get(addr);
          if (!existing || ts > existing.ts)
            holdsByAddr.set(addr, { type: "Safety-Lock", direction: dir, minutesOOR: parseInt(mins), pnl: pnl === "?" ? null : parseFloat(pnl), ts, prof });
        }

        const ph = line.match(/Pump-Hold: (\S+) pumped above range but PnL (-?[\d.]+|\?)% < ([\d.]+)% gate .+ holding \(profile: (\S+)\)/);
        if (ph) {
          const [, addr, pnlRaw, gate, prof] = ph;
          const existing = holdsByAddr.get(addr);
          if (!existing || ts > existing.ts)
            holdsByAddr.set(addr, { type: "Pump-Hold", gate: parseFloat(gate), pnl: pnlRaw === "?" ? null : parseFloat(pnlRaw), ts, prof });
        }

        const r8 = line.match(/R8 hold: (\S+) OOR (above|below) for (\d+)m — indicators not confirmed: (.+)/);
        if (r8) {
          const [, addr, dir, mins, reason] = r8;
          const existing = holdsByAddr.get(addr);
          if (!existing || ts > existing.ts)
            holdsByAddr.set(addr, { type: "R8-held", direction: dir, minutesOOR: parseInt(mins), reason: reason.trim(), ts });
        }
      }
    } catch {}
  }

  if (holdsByAddr.size === 0) return `<b>🔒 Held positions — last 24h</b>\n\nNo held positions in last 24h.`;

  function fmtAddr(a) { return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a; }
  function fmtTime(ts) { return ts.slice(11, 16); }

  const lines = [`<b>🔒 Held positions — last 24h</b>`, ""];
  const slEntries = [...holdsByAddr.entries()].filter(([, v]) => v.type === "Safety-Lock");
  const phEntries = [...holdsByAddr.entries()].filter(([, v]) => v.type === "Pump-Hold");

  if (slEntries.length > 0) {
    lines.push(`<b>Safety-Lock (${slEntries.length}):</b>`);
    for (const [addr, h] of slEntries.slice(0, 20)) {
      const pnlStr = h.pnl != null ? `PnL ${h.pnl.toFixed(2)}%` : "PnL ?%";
      lines.push(`• <code>${fmtAddr(addr)}</code> — OOR ${h.direction} ${h.minutesOOR}m, ${pnlStr}, last hold ${fmtTime(h.ts)}`);
    }
    if (slEntries.length > 20) lines.push(`  … and ${slEntries.length - 20} more`);
  }

  if (phEntries.length > 0) {
    if (slEntries.length > 0) lines.push("");
    lines.push(`<b>Pump-Hold (${phEntries.length}):</b>`);
    for (const [addr, h] of phEntries.slice(0, 20)) {
      const pnlStr = h.pnl != null ? `PnL ${h.pnl.toFixed(2)}%` : "PnL ?%";
      lines.push(`• <code>${fmtAddr(addr)}</code> — pumped above range, ${pnlStr} < ${h.gate}% gate, last hold ${fmtTime(h.ts)}`);
    }
    if (phEntries.length > 20) lines.push(`  … and ${phEntries.length - 20} more`);
  }

  const r8Entries = [...holdsByAddr.entries()].filter(([, v]) => v.type === "R8-held");
  if (r8Entries.length > 0) {
    if (slEntries.length > 0 || phEntries.length > 0) lines.push("");
    lines.push(`<b>R8-held (${r8Entries.length}):</b>`);
    for (const [addr, h] of r8Entries.slice(0, 20)) {
      lines.push(`• <code>${fmtAddr(addr)}</code> — OOR ${h.direction} ${h.minutesOOR}m, ${h.reason}, last hold ${fmtTime(h.ts)}`);
    }
    if (r8Entries.length > 20) lines.push(`  … and ${r8Entries.length - 20} more`);
  }

  lines.push("", `Total: ${holdsByAddr.size} unique position${holdsByAddr.size !== 1 ? "s" : ""} held`);
  return lines.join("\n");
}

export async function buildObserveReasons() {
  const today = new Date().toISOString().slice(0, 10);
  const { closedPositions, safetyLockCount, pumpHoldCount, r8HoldCount } = await parseLogDates([today]);
  const profile = config.management.closeProfile ?? "main";

  if (closedPositions.length === 0)
    return `<b>🚪 Close reasons — today (${today})</b>\nProfile: ${profile}\n\nNo closes today.`;

  const cats = {};
  for (const p of closedPositions) { const cat = categorizeCloseReason(p.reason); cats[cat] = (cats[cat] ?? 0) + 1; }
  const total = closedPositions.length;
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0][1];
  const BAR_MAX = 14;

  function bar(n) {
    const frac = n / maxCount;
    const full = Math.floor(frac * BAR_MAX);
    const half = (frac * BAR_MAX - full) >= 0.4 && full < BAR_MAX ? 1 : 0;
    return "█".repeat(full) + (half ? "▌" : "");
  }

  const lines = [`<b>🚪 Close reasons — today (${today})</b>`, `Profile: ${profile} | Total closes: ${total}`, ""];
  for (const [cat, n] of sorted) {
    const pct = ((n / total) * 100).toFixed(1);
    lines.push(`<code>${cat.padEnd(18)} ${bar(n).padEnd(BAR_MAX + 1)}${n}  (${pct}%)</code>`);
  }

  if (safetyLockCount > 0 || pumpHoldCount > 0 || r8HoldCount > 0) {
    lines.push("", "<b>Holds (no close):</b>");
    if (safetyLockCount > 0)
      lines.push(`<code>${"Safety-Lock".padEnd(18)} ${bar(safetyLockCount).padEnd(BAR_MAX + 1)}${safetyLockCount}</code>`);
    if (pumpHoldCount > 0)
      lines.push(`<code>${"Pump-Hold".padEnd(18)} ${bar(pumpHoldCount).padEnd(BAR_MAX + 1)}${pumpHoldCount}</code>`);
    if (r8HoldCount > 0)
      lines.push(`<code>${"R8-held".padEnd(18)} ${bar(r8HoldCount).padEnd(BAR_MAX + 1)}${r8HoldCount}</code>`);
  }

  return lines.join("\n");
}
