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
  const agentId = config.hiveMind?.agentId || "agent-local";
  const start = Date.now();
  const res = await fetchWithTimeout(`${url}/positions/open?owner=healthcheck&agentId=${agentId}`, {
    headers: { "x-api-key": config.api?.publicApiKey || "" },
  });
  const latency = Date.now() - start;
  // 200 = up, 400 = up (bad request), 500 = up (backend error on invalid owner)
  // Only consider down if connection fails or returns non-API error
  const isUp = res.ok || res.status === 400 || res.status === 500;
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
  const baseUrl = config.gmgn?.baseUrl || "https://openapi.gmgn.ai";
  const apiKey = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  const url = `${baseUrl}/v1/market/rank?chain=sol&interval=5m&order_by=volume&direction=desc&limit=1&timestamp=${Math.floor(Date.now() / 1000)}&client_id=test`;
  const start = Date.now();
  const res = await fetchWithTimeout(url, {
    headers: {
      "X-APIKEY": apiKey || "",
      "Content-Type": "application/json",
    },
  });
  const latency = Date.now() - start;
  return {
    name: "GMGN API",
    url: baseUrl.replace(/https?:\/\//, ""),
    status: res.status,
    ok: res.ok,
    latency,
    error: res.ok ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
  };
}

export async function checkJupiter() {
  const apiKey = config.jupiter?.apiKey || "";
  const url = "https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112";
  const start = Date.now();
  const res = await fetchWithTimeout(url, {
    headers: apiKey ? { "x-api-key": apiKey } : {},
  });
  const latency = Date.now() - start;
  const isOk = res.ok && !res.data?.includes?.("error");
  return {
    name: "Jupiter API",
    url: "api.jup.ag",
    status: res.status,
    ok: isOk,
    latency,
    error: isOk ? null : (res.data?.slice(0, 100) || `HTTP ${res.status}`),
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
