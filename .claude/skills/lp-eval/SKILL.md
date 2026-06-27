---
name: lp-eval
description: Evaluate Meridian LP deployment performance over a time window — pull closed-position stats from lessons.json, run an on-chain wallet-level reconciliation (the trustworthy number), measure capital utilization, and produce a data-grounded sizing recommendation. Use when asked to analyze deployment performance, reconcile PnL, check if the strategy is net-positive after costs, or decide whether to add capital / increase position size.
---

# LP Deployment Evaluation

End-to-end workflow for evaluating how Meridian's autonomous LP deployment has performed and whether to scale capital/size. Built from the 2026-06-21 evaluation. Run steps in order — Step 3 (on-chain reconciliation) is the ground truth; the bot's reported PnL is close but not exact.

Wallet: `Ckn5Q43mNiEmUvfxiszfLiJ67F4q6hkW4zLbVTXPVCru` (LIVE deployment). RPC from `process.env.RPC_URL`.

## Critical gotchas (read first)

- **Scripts that import `@solana/web3.js` MUST run from the project dir** (`/home/ubuntu/projects/meridian`), not `/tmp` — otherwise `node_modules` won't resolve. Write temp `.mjs` files into the project root, then `rm` them after (they show as untracked in `git status`).
- **`await import("./envcrypt.js")` first** in every script — decrypts `.env`.
- **RPC rate limits (HTTP 413/429)**: throttle `getParsedTransaction` to ~120ms apart and wrap calls in retry-with-backoff. Batched `getParsedTransactions` of 10 triggers 413 on Helius — fetch one at a time.
- **`getWallet()` is not exported** from dlmm.js — hardcode the pubkey above for read-only RPC.
- **Position value field is unreliable** (`total_value_sol` sometimes returns 0). The reconciliation sidesteps this by anchoring at **zero-position moments** where equity = free SOL exactly.
- **`lessons.json` shape**: `{ lessons:[], performance:[] }`. Each `performance` record: `pnl_sol`, `fees_earned_sol`, `amount_sol`, `recorded_at` (ISO), `close_reason`, `minutes_held`, `range_efficiency`, `pool_name`.
- **Config changes are NOT live from a file edit** — config loads at startup. Apply via Telegram `/setcfg`/`/settings` (calls `update_config` in-process, live + persisted) OR edit `user-config.json` + restart the bot while it's idle. The REPL has no `/setcfg`.

## Step 1 — Establish the window

Find the anchor: usually the last sizing/strategy config change. Check today's date (`date -u`) and grep the config-change log:

```bash
grep -hiE "update_config.*(maxPositions|maxDeployAmount|deployAmountSol|positionSizePct|stopLossPct|emergencyClosePct)" logs/agent-2026-06-*.log | tail -12
ls -1 logs/agent-2026-06-*.log
```

Set `WIN_START` to the change timestamp. Note: the *strategy as it runs now* is only valid from the LATEST relevant change (risk thresholds count too).

## Step 2 — Position-level performance (lessons.json)

Aggregate post-change vs an equal-length pre-change baseline. Adjust `CUT` / `PRE_START`:

```bash
node --input-type=module -e '
import fs from "fs";
const L=JSON.parse(fs.readFileSync("lessons.json","utf8"));
const all=L.performance.filter(r=>typeof r.pnl_sol==="number"&&r.recorded_at);
const CUT=Date.parse("2026-06-13T06:25:00Z");
const post=all.filter(r=>Date.parse(r.recorded_at)>=CUT);
const pre=all.filter(r=>{const t=Date.parse(r.recorded_at);return t>=CUT-7*864e5&&t<CUT;});
function agg(a,label){const n=a.length;if(!n)return console.log(label,"(empty)");
 const net=a.reduce((s,r)=>s+r.pnl_sol,0),fee=a.reduce((s,r)=>s+(r.fees_earned_sol||0),0);
 const amt=a.reduce((s,r)=>s+(r.amount_sol||0),0)/n,wins=a.filter(r=>r.pnl_sol>0).length;
 const hold=a.reduce((s,r)=>s+(r.minutes_held||0),0)/n;const srt=[...a].sort((x,y)=>x.pnl_sol-y.pnl_sol);
 console.log(`=== ${label} (n=${n}) ===`);
 console.log("avg size",amt.toFixed(3),"| win",(wins/n*100).toFixed(1)+"%","| net",net.toFixed(4),"SOL (/pos "+(net/n).toFixed(5)+")");
 console.log("net%/cycle",(net/n/amt*100).toFixed(3)+"% | fees",fee.toFixed(4),"| hold",hold.toFixed(0)+"m");
 console.log("worst",srt.slice(0,3).map(r=>r.pnl_sol.toFixed(4)+" "+r.pool_name).join(" | "));}
agg(post,"POST"); agg(pre,"PRE baseline");
// normalized close reasons
const norm=r=>{const s=(r||"").toLowerCase();return s.includes("stop loss")?"Stop Loss":s.includes("emergency")?"Emergency":s.includes("trailing")?"Trailing TP":(s.includes("rule 3")||s.includes("pumped"))?"Rule 3 (pump)":s.includes("low yield")?"Low Yield":s.includes("oor")||s.includes("range")?"OOR":"other";};
const by={};for(const r of post){const k=norm(r.close_reason);(by[k]=by[k]||{n:0,pnl:0,win:0});by[k].n++;by[k].pnl+=r.pnl_sol;if(r.pnl_sol>0)by[k].win++;}
console.log("\nREASON         n   netPnL    win%");
for(const [k,v] of Object.entries(by).sort((a,b)=>b[1].pnl-a[1].pnl))console.log(k.padEnd(14),String(v.n).padStart(3),v.pnl.toFixed(4).padStart(9),(v.win/v.n*100).toFixed(0).padStart(4)+"%");
' 2>&1 | grep -Ev "punycode|Deprecat|trace-dep"
```

The close-reason table reveals the **profit engine** (usually Trailing TP, ~100% win) vs near-breakeven churn (Rule 3 pump, Low Yield) vs the **drag** (Stop Loss + Emergency — few events but they eat a large share of gross).

## Step 3 — On-chain wallet-level reconciliation (GROUND TRUTH)

The bot's `pnl_sol` excludes some fixed costs (rent, swap slippage). To get the real all-in number, compare on-chain equity at two **zero-position anchors** (equity = free SOL, no position-valuation guesswork) — but only valid if there are **no external deposits/withdrawals** between them.

**3a. Confirm zero external flows** + measure tx fees. Write to project dir:

```bash
cat > recon-flows.mjs <<'EOF'
await import("./envcrypt.js");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const conn = new Connection(process.env.RPC_URL,"confirmed");
const pk = new PublicKey("Ckn5Q43mNiEmUvfxiszfLiJ67F4q6hkW4zLbVTXPVCru");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rt=async fn=>{for(let a=0;a<6;a++){try{return await fn();}catch(e){if(/429|413|Too many|Payload/.test(e.message)){await sleep(900*(a+1));continue;}throw e;}}throw new Error("exhausted");};
const WIN_START=Date.parse("2026-06-13T06:25:00Z")/1000;
let before,all=[];while(all.length<3000){const s=await rt(()=>conn.getSignaturesForAddress(pk,{limit:1000,before}));if(!s.length)break;all.push(...s);before=s.at(-1).signature;if((s.at(-1).blockTime||0)<WIN_START)break;}
const win=all.filter(s=>(s.blockTime||0)>=WIN_START&&!s.err);
let dep=0,wd=0,fee=0;
for(const s of win){const tx=await rt(()=>conn.getParsedTransaction(s.signature,{maxSupportedTransactionVersion:0}));await sleep(120);if(!tx?.meta)continue;
 const keys=tx.transaction.message.accountKeys.map(k=>k.pubkey?k.pubkey.toString():k.toString());const wi=keys.findIndex(k=>k===pk.toString());if(wi<0)continue;
 fee+=(tx.meta.fee||0)/LAMPORTS_PER_SOL;const d=(tx.meta.postBalances[wi]-tx.meta.preBalances[wi])/LAMPORTS_PER_SOL;
 const ins=tx.transaction.message.instructions||[];const onlySys=ins.every(x=>x.program==="system"||x.program==="computeBudget");
 const inT=ins.some(x=>x.program==="system"&&x.parsed?.type==="transfer"&&x.parsed?.info?.destination===pk.toString());
 const outT=ins.some(x=>x.program==="system"&&x.parsed?.type==="transfer"&&x.parsed?.info?.source===pk.toString());
 if(inT&&onlySys&&d>0.02)dep+=d; if(outT&&onlySys&&d<-0.02)wd+=Math.abs(d);}
console.log("IN_WINDOW",win.length,"DEPOSITS_SOL",dep.toFixed(4),"WITHDRAWALS_SOL",wd.toFixed(4),"TX_FEES_SOL",fee.toFixed(5));
EOF
node recon-flows.mjs 2>&1 | grep -Ev "punycode|Deprecat|trace-dep"; rm -f recon-flows.mjs
```

If deposits/withdrawals ≠ 0, you must account for them (or pick anchors on the same side of the flow).

**3b. Find zero-position anchors** — the CRON log prints `No open positions (state)` every idle cycle:

```bash
for d in 14 15 16 17 18 19 20 21; do f=logs/agent-2026-06-$d.log;[ -f "$f" ]||continue;
 first=$(grep -oE "2026-06-${d}T[0-9:]+.*No open positions" "$f"|head -1|grep -oE "T[0-9:]+"|head -1);
 last=$(grep -oE "2026-06-${d}T[0-9:]+.*No open positions" "$f"|tail -1|grep -oE "T[0-9:]+"|head -1);
 echo "Jun-$d count=$(grep -c 'No open positions' "$f") first=$first last=$last"; done
```

Pick an **early** anchor (first clean zero-pos after WIN_START) and a **late** anchor.

**3c. Fetch on-chain free SOL at each anchor** (postBalance of nearest tx ≤ anchor time):

```bash
cat > recon-anchors.mjs <<'EOF'
await import("./envcrypt.js");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const conn=new Connection(process.env.RPC_URL,"confirmed");const pk=new PublicKey("Ckn5Q43mNiEmUvfxiszfLiJ67F4q6hkW4zLbVTXPVCru");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const rt=async fn=>{for(let a=0;a<6;a++){try{return await fn();}catch(e){if(/429|413|Too many|Payload/.test(e.message)){await sleep(900*(a+1));continue;}throw e;}}throw new Error("x");};
let before,all=[];while(all.length<3000){const s=await rt(()=>conn.getSignaturesForAddress(pk,{limit:1000,before}));if(!s.length)break;all.push(...s);before=s.at(-1).signature;if((s.at(-1).blockTime||0)<Date.parse("2026-06-13T00:00:00Z")/1000)break;}
all=all.filter(s=>!s.err).sort((a,b)=>a.blockTime-b.blockTime);
const balAt=async iso=>{const t=Date.parse(iso)/1000;let p=null;for(const s of all){if((s.blockTime||0)<=t)p=s;else break;}if(!p)return null;
 const tx=await rt(()=>conn.getParsedTransaction(p.signature,{maxSupportedTransactionVersion:0}));const keys=tx.transaction.message.accountKeys.map(k=>k.pubkey?k.pubkey.toString():k.toString());
 return {bal:tx.meta.postBalances[keys.findIndex(k=>k===pk.toString())]/LAMPORTS_PER_SOL,at:new Date(p.blockTime*1000).toISOString()};};
const A=await balAt("2026-06-14T00:33:00Z");   // <-- early anchor
const B=await balAt("2026-06-21T09:15:00Z");   // <-- late anchor
console.log("EARLY",JSON.stringify(A),"\nLATE",JSON.stringify(B),"\nNET_TRADING_SOL",(B.bal-A.bal).toFixed(4));
EOF
node recon-anchors.mjs 2>&1 | grep -Ev "punycode|Deprecat|trace-dep"; rm -f recon-anchors.mjs
```

**3d. Isolate the hidden cost**: run Step 2's aggregation but filtered to `[anchorA, anchorB]`. Then:
`hidden_cost = lessons_net − onchain_net`, and `cost_per_cycle = hidden_cost / closes`. In the 2026-06-21 run this was ~0.0007 SOL/cycle (~19% of gross) → bot accounting trustworthy, costs real but not edge-killing.

## Step 4 — Capital utilization

From Step 3b counts: `idle_fraction ≈ zero-pos cycles / total cycles`. Estimate avg concurrent positions = `Σ(minutes_held) / window_minutes` (from lessons), then `avg_working_capital ≈ avg_concurrent × avg_size`. Compare to total wallet equity → utilization %. In the 2026-06-21 run: ~60% idle, ~0.67 avg concurrent, ~17% of 4-slot capacity → **capacity-limited, not capital-limited**.

## Step 5 — Sizing recommendation (the insight)

Anchor every sizing answer on this identity:

> **Profit ≈ deploy_frequency × avg_size × edge_per_cycle**

Adding capital changes **none** of these three terms. So diagnose first:

- **Capital-limited** (slots regularly maxed, screener finds more good pools than capacity) → more slots/capital captures real opportunities. **Rare here.**
- **Capacity-limited** (slots rarely fill, wallet idle a lot) → adding capital just dilutes return-on-capital; absolute profit stays flat. **This is the usual Meridian state.**

**Dilution math to show the user** (fill with real numbers): same absolute profit/week, bigger denominator → return% collapses. Adding idle SOL to a bot-controlled hot wallet = more risk, zero extra return.

**The only data-supported way to scale** is to raise per-position size *gradually and prove the edge holds at each step*, because exit-swap slippage in small pools ($10–150k TVL) compresses the edge as size grows:

1. Bump `maxDeployAmount` one step (e.g. 0.5 → 0.65), keep ~1 week.
2. Re-run Steps 2–3 for that window. Pass = `net%/cycle` stays ≥ ~0.5% (compare to the recorded baseline) and exit slippage on autoswap doesn't balloon.
3. Hold → step again (0.65 → 0.8). Compress → revert.
4. **Only after** size is proven larger AND slots start filling does adding fresh capital make sense.

IDR→SOL context: get live SOL price from `getWalletBalances()` (`sol_usd/sol`), use IDR/USD ≈ 16,300 (verify if precision matters).

## Output format

Lead with the verdict. Tables for: PRE/POST metrics, close-reason breakdown, reconciliation (on-chain net vs bot net vs hidden cost), and the sizing dilution comparison. Always state the on-chain net as the trustworthy figure and explicitly flag any earlier estimate it corrects. End with a concrete next action (apply a size step, hold capital, etc.).
