// Telegram /settings inline-keyboard menu: renders pages of buttons and applies
// cfg:* callbacks through executeTool("update_config") so every change goes
// through the same validation/persistence path as the LLM tool.
import { config } from "./config.js";
import { executeTool } from "./tools/executor.js";
import {
  sendMessage,
  sendMessageWithButtons,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
} from "./telegram.js";
import { isHiveMindEnabled } from "./hivemind.js";

// Set by the cfg:input callback; consumed by the next plain-text Telegram message.
let _pendingInput = null; // { key, page, menuMsgId }

export function hasPendingInput() {
  return _pendingInput != null;
}

export function takePendingInput() {
  const pending = _pendingInput;
  _pendingInput = null;
  return pending;
}

export function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Screening source: ${config.screening.source}`,
    `Strategy: ${config.strategy.strategy} | bins: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] (volatility-scaled)`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: above=${config.management.outOfRangeWaitMinutes}m / below=${config.management.outOfRangeBelowWaitMinutes}m | fast-close >${config.management.outOfRangeBinsToClose} bins | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h | pump gate ${config.management.minProfitPctToCloseOOR}%`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m | close profile: ${config.management.closeProfile}`,
    `R8: ${config.management.r8IndicatorCheck ? "on" : "off"} | preset ${config.management.r8ExitPreset} | cooldown ${config.management.r8OorCooldownHours}h`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl} | vol ${config.screening.minVolatility ?? 0}-${config.screening.maxVolatility ?? "∞"} | fee/tvl ${config.screening.minFeeActiveTvlRatio}-${config.screening.maxFeeActiveTvlRatio ?? "∞"}%`,
    `GMGN interval: ${config.gmgn.interval} | OrderBy: ${config.gmgn.orderBy} | Dir: ${config.gmgn.direction}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

export function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

export function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    closeProfile: config.management.closeProfile,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    lockMaxVolatility: config.screening.lockMaxVolatility,
    screeningSource: config.screening.source,
    gmgnRequireKol: config.gmgn.requireKol,
    gmgnInterval: config.gmgn.interval,
    gmgnIndicatorFilter: config.gmgn.indicatorFilter,
    gmgnMinVolume: config.gmgn.minVolume,
    gmgnMinTokenAgeHours: config.gmgn.minTokenAgeHours,
    gmgnMaxTokenAgeHours: config.gmgn.maxTokenAgeHours,
    gmgnMaxBundlerRate: config.gmgn.maxBundlerRate,
    gmgnPreferredKolNames: config.gmgn.preferredKolNames,
    gmgnPreferredKolMinHoldPct: config.gmgn.preferredKolMinHoldPct,
    gmgnDumpKolNames: config.gmgn.dumpKolNames,
    gmgnDumpKolMinHoldPct: config.gmgn.dumpKolMinHoldPct,
    gmgnIndicatorInterval: config.gmgn.indicatorInterval,
    gmgnRequireBullishSt: config.gmgn.indicatorRules?.requireBullishSupertrend,
    gmgnRejectAtBottom: config.gmgn.indicatorRules?.rejectAlreadyAtBottom,
    gmgnRequireAboveSt: config.gmgn.indicatorRules?.requireAboveSupertrend,
    gmgnMinRsi: config.gmgn.indicatorRules?.minRsi,
    gmgnMaxRsi: config.gmgn.indicatorRules?.maxRsi,
    gmgnMinKolCount: config.gmgn.minKolCount,
    gmgnMinTotalFeeSol: config.gmgn.minTotalFeeSol,
    gmgnMinHolders: config.gmgn.minHolders,
    gmgnMinMcap: config.gmgn.minMcap,
    gmgnMaxMcap: config.gmgn.maxMcap,
    gmgnAthFilterPct: config.gmgn.athFilterPct,
    gmgnHoldersLimit: config.gmgn.holdersLimit,
    gmgnMaxTop10HolderRate: config.gmgn.maxTop10HolderRate,
    gmgnMaxRatTraderRate: config.gmgn.maxRatTraderRate,
    gmgnMaxFreshWalletRate: config.gmgn.maxFreshWalletRate,
    gmgnMaxDevTeamHoldRate: config.gmgn.maxDevTeamHoldRate,
    gmgnMaxBotDegenRate: config.gmgn.maxBotDegenRate,
    gmgnMaxRugRatio: config.gmgn.maxRugRatio,
    gmgnMaxSniperCount: config.gmgn.maxSniperCount,
    gmgnMaxSniperHoldRate: config.gmgn.maxSniperHoldRate,
    gmgnMinSmartDegenCount: config.gmgn.minSmartDegenCount,
    gmgnRequireBbPosition: config.gmgn.indicatorRules?.requireBbPosition,
    volumeTrendFilter: config.screening.volumeTrendFilter,
    volumeTrendAccelThreshold: config.screening.volumeTrendAccelThreshold,
    volumeTrendDecelThreshold: config.screening.volumeTrendDecelThreshold,
    volumeTrendBlockDecel: config.screening.volumeTrendBlockDecel,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    minVolatility: config.screening.minVolatility,
    maxVolatility: config.screening.maxVolatility,
    minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
    maxFeeActiveTvlRatio: config.screening.maxFeeActiveTvlRatio,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    emergencyClosePct: config.management.emergencyClosePct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
    r8IndicatorCheck: config.management.r8IndicatorCheck,
    r8ExitPreset: config.management.r8ExitPreset,
    r8OorCooldownHours: config.management.r8OorCooldownHours,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function inputButton(key, label, { digits = 0 } = {}) {
  const value = settingValue(key);
  const shown = value == null ? "off" : Number.isFinite(Number(value)) ? String(parseFloat(Number(value).toFixed(digits))) : String(value);
  return [settingButton(`${label}: ${shown} ✏`, `cfg:input:${key}`)];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Screening: ${config.screening.source} | GMGN KOL ${config.gmgn.requireKol ? "required" : "preferred"}`,
    `Strategy: ${config.strategy.strategy} | deploy ${config.management.deployAmountSol} SOL | max pos ${config.risk.maxPositions}`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"} | profile: ${config.management.closeProfile} | pump gate ${config.management.minProfitPctToCloseOOR}%`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Strategy", "cfg:page:strategy"),
    ],
    [
      settingButton("Screen", "cfg:page:screen"),
      settingButton("GMGN", "cfg:page:gmgn"),
      settingButton("Safety", "cfg:page:safety"),
      settingButton("Indicators", "cfg:page:indicators"),
      settingButton("KOL", "cfg:page:kol"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      inputButton("deployAmountSol", "Deploy SOL", { digits: 2 }),
      inputButton("gasReserve", "Gas reserve", { digits: 2 }),
      inputButton("maxPositions", "Max positions"),
      inputButton("maxDeployAmount", "Max SOL"),
      inputButton("takeProfitPct", "TP %"),
      inputButton("stopLossPct", "SL %"),
      inputButton("emergencyClosePct", "Emergency close %", { digits: 0 }),
      inputButton("minProfitPctToCloseOOR", "Min profit % to close on pump", { digits: 2 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      inputButton("trailingTriggerPct", "Trail trigger", { digits: 1 }),
      inputButton("trailingDropPct", "Trail drop", { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      inputButton("repeatDeployCooldownTriggerCount", "Repeat count"),
      inputButton("repeatDeployCooldownHours", "Repeat hrs"),
      inputButton("repeatDeployCooldownMinFeeEarnedPct", "Min fee earned %", { digits: 1 }),
      inputButton("minVolatility", "Min vol", { digits: 1 }),
      inputButton("maxVolatility", "Max vol", { digits: 1 }),
      inputButton("minFeeActiveTvlRatio", "Min fee/TVL %", { digits: 2 }),
      inputButton("maxFeeActiveTvlRatio", "Max fee/TVL %", { digits: 2 }),
      [
        settingButton(`Close: main${config.management.closeProfile === "main" ? " ✓" : ""}`, "cfg:set:closeProfile:main"),
        settingButton(`pecut${config.management.closeProfile === "pecut" ? " ✓" : ""}`, "cfg:set:closeProfile:pecut"),
        settingButton(`experimental${config.management.closeProfile === "experimental" ? " ✓" : ""}`, "cfg:set:closeProfile:experimental"),
      ],
      [toggleButton("r8IndicatorCheck", "R8 indicator check")],
      [
        settingButton(`R8: ST${config.management.r8ExitPreset === "supertrend_break" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:supertrend_break"),
        settingButton(`RSI${config.management.r8ExitPreset === "rsi_reversal" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:rsi_reversal"),
        settingButton(`BB+RSI${config.management.r8ExitPreset === "bb_plus_rsi" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:bb_plus_rsi"),
        settingButton(`ST/RSI${config.management.r8ExitPreset === "supertrend_or_rsi" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:supertrend_or_rsi"),
      ],
      inputButton("r8OorCooldownHours", "R8 cooldown hrs"),
    ];
  } else if (page === "screen") {
    rows = [
      [
        settingButton(`Source: Meteora${config.screening.source === "meteora" ? " ✓" : ""}`, "cfg:set:screeningSource:meteora"),
        settingButton(`Source: GMGN${config.screening.source === "gmgn" ? " ✓" : ""}`, "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("gmgnRequireKol", "GMGN require KOL")],
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton("5m", "cfg:set:gmgnInterval:5m"),
        settingButton("1h", "cfg:set:gmgnInterval:1h"),
        settingButton("6h", "cfg:set:gmgnInterval:6h"),
        settingButton("24h", "cfg:set:gmgnInterval:24h"),
      ],
      [
        inputButton("gmgnMinVolume", "Min volume")[0],
        inputButton("gmgnMinTokenAgeHours", "Min token age (h)")[0],
      ],
      [
        inputButton("gmgnMaxTokenAgeHours", "Max token age (h)")[0],
        inputButton("gmgnMaxBundlerRate", "Max bundler %")[0],
      ],
      [toggleButton("volumeTrendFilter", "Volume trend filter")],
      [toggleButton("volumeTrendBlockDecel", "Block decelerating")],
      [toggleButton("lockMaxVolatility", "Lock maxVolatility (no auto-evolve)")],
      [
        inputButton("volumeTrendAccelThreshold", "Accel threshold")[0],
        inputButton("volumeTrendDecelThreshold", "Decel threshold")[0],
      ],
      [settingButton("KOL settings", "cfg:page:kol")],
      inputButton("managementIntervalMin", "Manage interval (min)"),
      inputButton("screeningIntervalMin", "Screen interval (min)"),
    ];
  } else if (page === "strategy") {
    rows = [
      [
        settingButton("spot", "cfg:set:strategy:spot"),
        settingButton("bid_ask", "cfg:set:strategy:bid_ask"),
      ],
      inputButton("minBinsBelow", "Min bins"),
      inputButton("maxBinsBelow", "Max bins"),
    ];
  } else if (page === "gmgn") {
    rows = [
      [
        inputButton("gmgnMinMcap", "Min mcap")[0],
        inputButton("gmgnMaxMcap", "Max mcap")[0],
      ],
      [
        inputButton("gmgnMinVolume", "Min volume")[0],
        inputButton("gmgnMinHolders", "Min holders")[0],
      ],
      [
        inputButton("gmgnAthFilterPct", "ATH filter %", { digits: 0 })[0],
        inputButton("gmgnHoldersLimit", "Holders limit")[0],
      ],
      [
        inputButton("gmgnMinTokenAgeHours", "Min token age (h)")[0],
        inputButton("gmgnMaxTokenAgeHours", "Max token age (h)")[0],
      ],
      [settingButton("Safety filters", "cfg:page:safety")],
      [settingButton("KOL settings", "cfg:page:kol")],
    ];
  } else if (page === "kol") {
    rows = [
      inputButton("gmgnPreferredKolNames", "Preferred KOL (comma-sep)"),
      inputButton("gmgnPreferredKolMinHoldPct", "Preferred KOL min hold %"),
      inputButton("gmgnDumpKolNames", "Dump KOL (comma-sep)"),
      inputButton("gmgnDumpKolMinHoldPct", "Dump KOL min hold %"),
    ];
  } else if (page === "safety") {
    rows = [
      [
        inputButton("gmgnMaxTop10HolderRate", "Max top10 %", { digits: 2 })[0],
        inputButton("gmgnMaxBundlerRate", "Max bundler %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxRatTraderRate", "Max rat trader %", { digits: 2 })[0],
        inputButton("gmgnMaxFreshWalletRate", "Max fresh wallet %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxDevTeamHoldRate", "Max dev hold %", { digits: 2 })[0],
        inputButton("gmgnMaxBotDegenRate", "Max bot degen %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxRugRatio", "Max rug ratio", { digits: 2 })[0],
        inputButton("gmgnMaxSniperHoldRate", "Max sniper hold %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxSniperCount", "Max sniper count")[0],
        inputButton("gmgnMinSmartDegenCount", "Min smart degen")[0],
      ],
      [toggleButton("gmgnRequireKol", "Require KOL")],
      [inputButton("gmgnMinKolCount", "Min KOL")[0], inputButton("gmgnMinTotalFeeSol", "Min fee SOL")[0]],
      [settingButton("Indicators", "cfg:page:indicators")],
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [toggleButton("gmgnIndicatorFilter", "GMGN indicator filter"), toggleButton("gmgnRequireBbPosition", "Require BB position")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      [
        settingButton("GMGN ST", "cfg:set:gmgnIndicatorInterval:5_MINUTE"),
        settingButton("GMGN 15m", "cfg:set:gmgnIndicatorInterval:15_MINUTE"),
        settingButton("GMGN 1h", "cfg:set:gmgnIndicatorInterval:1h"),
      ],
      [toggleButton("gmgnRequireBullishSt", "Bullish ST"), toggleButton("gmgnRejectAtBottom", "Reject at bottom"), toggleButton("gmgnRequireAboveSt", "Above ST")],
      inputButton("gmgnMinRsi", "Min RSI"),
      inputButton("gmgnMaxRsi", "Max RSI"),
      inputButton("rsiLength", "RSI length"),
    ];
  } else {
    rows = [
      [
        settingButton(`Source: Meteora${config.screening.source === "meteora" ? " ✓" : ""}`, "cfg:set:screeningSource:meteora"),
        settingButton(`Source: GMGN${config.screening.source === "gmgn" ? " ✓" : ""}`, "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

export async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  if (key === "gmgnPreferredKolNames" || key === "gmgnDumpKolNames") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return parseConfigValue(raw);
}

export async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "input") {
    const inputKey = parts[2];
    const currentVal = settingValue(inputKey);
    const inputPage = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(inputKey) ? "kol"
      : ["gmgnMaxTop10HolderRate", "gmgnMaxBundlerRate", "gmgnMaxRatTraderRate", "gmgnMaxFreshWalletRate", "gmgnMaxDevTeamHoldRate", "gmgnMaxBotDegenRate", "gmgnMaxRugRatio", "gmgnMaxSniperCount", "gmgnMaxSniperHoldRate", "gmgnMinSmartDegenCount", "gmgnRequireKol", "gmgnMinKolCount", "gmgnMinTotalFeeSol"].includes(inputKey) ? "safety"
      : ["gmgnMinMcap", "gmgnMaxMcap", "gmgnMinVolume", "gmgnAthFilterPct", "gmgnMinHolders", "gmgnHoldersLimit", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(inputKey) ? "gmgn"
      : inputKey.startsWith("indicator") || inputKey === "chartIndicatorsEnabled" || inputKey === "rsiLength" || inputKey === "requireAllIntervals" || inputKey === "gmgnIndicatorFilter" || inputKey === "gmgnRequireBbPosition" || inputKey === "gmgnIndicatorInterval" || inputKey === "gmgnRequireBullishSt" || inputKey === "gmgnRejectAtBottom" || inputKey === "gmgnRequireAboveSt" || inputKey === "gmgnMinRsi" || inputKey === "gmgnMaxRsi" ? "indicators"
      : ["minBinsBelow", "maxBinsBelow"].includes(inputKey) ? "strategy"
      : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource"].includes(inputKey) ? "screen"
      : "risk";
    _pendingInput = { key: inputKey, page: inputPage, menuMsgId: msg.messageId };
    await answerCallbackQuery(msg.callbackQueryId);
    await sendMessage(`Enter new value for ${inputKey} (current: ${currentVal ?? "off"}):\nSend a number, or "off" to clear.`);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
    if (key === "minVolatility") value = Math.max(0, Math.min(10, Number((current + delta).toFixed(1))));
    if (key === "maxVolatility") value = Math.max(1, Math.min(20, Number((current + delta).toFixed(1))));
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(key) ? "kol"
    : ["gmgnMaxTop10HolderRate", "gmgnMaxBundlerRate", "gmgnMaxRatTraderRate", "gmgnMaxFreshWalletRate", "gmgnMaxDevTeamHoldRate", "gmgnMaxBotDegenRate", "gmgnMaxRugRatio", "gmgnMaxSniperCount", "gmgnMaxSniperHoldRate", "gmgnMinSmartDegenCount", "gmgnRequireKol", "gmgnMinKolCount", "gmgnMinTotalFeeSol"].includes(key) ? "safety"
    : ["gmgnMinMcap", "gmgnMaxMcap", "gmgnMinVolume", "gmgnAthFilterPct", "gmgnMinHolders", "gmgnHoldersLimit", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(key) ? "gmgn"
    : key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals" || key === "gmgnIndicatorFilter" || key === "gmgnRequireBbPosition" || key === "gmgnIndicatorInterval" || key === "gmgnRequireBullishSt" || key === "gmgnRejectAtBottom" || key === "gmgnRequireAboveSt" || key === "gmgnMinRsi" || key === "gmgnMaxRsi" ? "indicators"
    : ["minBinsBelow", "maxBinsBelow"].includes(key) ? "strategy"
    : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "volumeTrendFilter", "volumeTrendAccelThreshold", "volumeTrendDecelThreshold", "volumeTrendBlockDecel", "lockMaxVolatility"].includes(key) ? "screen"
    : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}
