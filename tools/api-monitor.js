import { config } from "../config.js";
import { log } from "../logger.js";

const TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, data: await res.text().catch(() => "") };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: e.message };
  }
}

export async function checkRelay() {
  const url = config.api?.agentMeridianApiUrl || "https://api.agentmeridian.xyz/api";
  const wallet = process.env.WALLET_PRIVATE_KEY ? "test" : "";
  const start = Date.now();
  const res = await fetchWithTimeout(`${url}/positions/open?owner=${wallet}`, {
    headers: { "x-api-key": config.api?.publicApiKey || "" },
  });
  const latency = Date.now() - start;
  // 400 with "owner is required" means API is up (just needs valid owner)
  const isUp = res.ok || (res.status === 400 && res.data?.includes("owner"));
  return {
    name: "Agent Meridian Relay",
    url,
    status: res.status,
    ok: isUp,
    latency,
    error: isUp ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
  };
}

export async function checkHiveMind() {
  const url = config.hiveMind?.url || "https://api.agentmeridian.xyz";
  const start = Date.now();
  const res = await fetchWithTimeout(`${url}/api/health`);
  const latency = Date.now() - start;
  return {
    name: "HiveMind",
    url,
    status: res.status,
    ok: res.ok,
    latency,
    error: res.ok ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
  };
}

export async function checkGmgnIndicators() {
  const mint = "So11111111111111111111111111111111111111112"; // SOL as test
  const url = `https://gmgn.ai/api/v1/market/indicators?chain=sol&address=${mint}&interval=5m`;
  const start = Date.now();
  const res = await fetchWithTimeout(url);
  const latency = Date.now() - start;
  return {
    name: "GMGN Chart Indicators",
    url: "gmgn.ai",
    status: res.status,
    ok: res.ok,
    latency,
    error: res.ok ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
  };
}

export async function checkJupiter() {
  const url = "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50";
  const start = Date.now();
  const res = await fetchWithTimeout(url);
  const latency = Date.now() - start;
  return {
    name: "Jupiter Swap",
    url: "jup.ag",
    status: res.status,
    ok: res.ok,
    latency,
    error: res.ok ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
  };
}

export async function checkMeteora() {
  const url = "https://dlmm.datapi.meteora.ag/pair/all_by_groups?page=0&limit=1";
  const start = Date.now();
  const res = await fetchWithTimeout(url);
  const latency = Date.now() - start;
  return {
    name: "Meteora DLMM",
    url: "meteora.ag",
    status: res.status,
    ok: res.ok,
    latency,
    error: res.ok ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
  };
}

export async function checkSolanaRpc() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const start = Date.now();
  const res = await fetchWithTimeout(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  });
  const latency = Date.now() - start;
  return {
    name: "Solana RPC",
    url: rpcUrl.replace(/\/[^\/]*$/, "/***"),
    status: res.status,
    ok: res.ok && !res.data.includes("error"),
    latency,
    error: res.ok ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
  };
}

export async function checkAllApis() {
  const results = await Promise.allSettled([
    checkRelay(),
    checkHiveMind(),
    checkGmgnIndicators(),
    checkJupiter(),
    checkMeteora(),
    checkSolanaRpc(),
  ]);
  return results.map((r) => r.status === "fulfilled" ? r.value : { name: "Unknown", ok: false, status: 0, latency: 0, error: r.reason?.message });
}

export function formatApiStatus(results) {
  const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = results.map((r) => {
    const icon = r.ok ? "✅" : "❌";
    const latency = r.latency ? `${r.latency}ms` : "?";
    const status = r.status ? `${r.status}` : "timeout";
    const error = r.error ? `\n    ⚠️ ${escapeHtml(r.error.slice(0, 80))}` : "";
    return `${icon} ${r.name} — ${status} (${latency})${error}`;
  });
  return lines.join("\n");
}
