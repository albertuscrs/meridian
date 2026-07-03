// Pure formatting helpers shared by index.js (REPL + Telegram output).
// Keep this module free of project imports so anything can use it.

export function htmlEscape(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

export function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/status apis — check all API status (relay, hivemind, gmgn, jupiter, meteora, rpc)",
    "/status relay — check Agent Meridian relay status",
    "/status hivemind — check HiveMind server status",
    "/status gmgn — check GMGN chart indicators status",
    "/status jupiter — check Jupiter swap API status",
    "/status meteora — check Meteora DLMM API status",
    "/status rpc — check Solana RPC status",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/history — last 10 closed positions",
    "/learn — performance summary + recent lessons",
    "/performance — detailed performance: 24h/7d/30d breakdown",
    "/performance 7d — last 7 days performance",
    "/performance 30d — last 30 days performance",
    "/performance all — all-time performance",
    "/observe — exit rule snapshot: reasons, OOR counts, active profile",
    "/observe <N> — same aggregated over last N days (max 7)",
    "/observe details — trailing-armed OOR closes with pair + PnL",
    "/observe compare — close distribution: baseline vs current period",
    "/observe compare <B> <C> — baseline B days vs current C days",
    "/observe held — positions held by Safety-Lock, Pump-Hold, or R8 (last 24h)",
    "/observe reasons — bar chart of close reasons today",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/cooldown <symbol> <hours> — manually block a token (e.g. /cooldown BELKA 4)",
    "/uncooldown <symbol> — clear manual cooldown for a token",
    "/blockdeploy <pool|mint|wallet> [reason] — block a deployer wallet (no arg = list)",
    "/unblockdeploy <wallet> — remove deployer from blocklist",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — run full screening cycle (enrich + LLM pick + deploy)",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
    "",
    "/myid — show your Telegram user ID",
    "/lockuser — lock bot to your account only",
  ].join("\n");
}

export function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

export function fmtAge(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function fmtFeeTvl(value, timeframe) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value).toFixed(2);
  return timeframe ? `${n}%/${timeframe}` : `${n}%`;
}

export function positionStatusEmoji(p) {
  if (p.pnl_pct == null) return "⚪";
  if (!p.in_range) return "🔴"; // OOR
  if (p.pnl_pct >= 2) return "🟢"; // Good profit
  if (p.pnl_pct >= 0) return "🟡"; // In range, neutral
  if (p.pnl_pct >= -3) return "🟠"; // In range, small loss
  return "🔴"; // In range, big loss
}

export function feeTvlBar(value) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  const n = Number(value);
  if (n < 1) return "▁";
  if (n < 3) return "▂▁";
  if (n < 6) return "▃▂▁";
  if (n < 10) return "▄▃▂▁";
  if (n < 20) return "▅▄▃▂▁";
  return "▆▅▄▃▂▁";
}
