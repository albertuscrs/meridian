---
name: add-config-key
description: Wire a new Meridian config key end-to-end — config.js default, CONFIG_MAP, update_config schema, /settings UI with settingValue mapping and ✓-marked choice buttons, startup validator, regression tests. Use whenever adding, renaming, or exposing any config key; a key wired by memory always misses a touchpoint.
---

# Add a Config Key End-to-End

A config key here has up to SIX touchpoints. Each missed one fails silently in a
different way (UI shows "off", LLM can't set it, startup warns "unknown key", value
never read). Work through this checklist top to bottom; skip only the steps whose
"needed when" doesn't apply, and say which you skipped.

## Step 1 — config.js: read + default (always required)

Add to the correct section (`screening`, `gmgn`, `management`, `risk`, `strategy`,
`schedule`, `llm`, `indicators`, `darwin`, `pnl`):

```js
myNewKey: u.myNewKey ?? <default>,   // <one-line: what it does, units>
```

Notes:
- GMGN-section keys use the `gmgnValue("shortName", "gmgnLongName", default)` helper —
  follow the neighbors.
- The startup validator (`findUnknownUserConfigKeys` in executor.js) discovers known
  keys by scanning config.js for `u.<key>` — using the `u.` pattern is what keeps the
  key off the "unknown keys" startup warning. If the key is read some other way, it
  needs an explicit entry in the validator's `known` set.

## Step 2 — executor.js CONFIG_MAP (needed when: settable at runtime)

`CONFIG_MAP` (module scope, exported) maps key → `[section, configField, ...aliases]`.
Add the entry or `update_config` will reject the key. If the key must only be
changeable by the operator via Telegram (not the LLM), put it in `OPERATOR_ONLY_KEYS`
instead and skip Step 3.

## Step 3 — tools/definitions.js update_config schema (needed when: LLM-settable)

Add the key name to the `update_config` tool's key list (the long enum/description
around the `update_config` entry). Without this the LLM never knows the key exists.
Grep first: `grep -n "update_config" tools/definitions.js`.

## Step 4 — /settings UI (needed when: it should appear in Telegram /settings)

In `settings-menu.js`:

1. **`settingValue(key)` mapping — MANDATORY for any key shown in the UI.** Without
   it every button renders "off" regardless of the real value. Add the key → live
   config path entry.
2. Buttons:
   - Toggle: follow an existing `settingButton` toggle row.
   - **Multi-choice: use `choiceButton(key, label, rawValue)`** — it compares the
     live value (array-aware via `normalizeMenuValue`) and appends " ✓" to the active
     option. Never build multi-choice rows from plain `settingButton` (loses the
     active marker).
   - Free-value input: follow the pending-input pattern
     (`hasPendingInput`/`takePendingInput`).
3. If the value needs parsing (number/bool/array/null), confirm `parseConfigValue`
   handles the shape.

## Step 5 — Verify offline BEFORE restarting anything

```bash
node --check config.js tools/executor.js settings-menu.js tools/definitions.js
node --input-type=module -e '
  const { config } = await import("./config.js");
  console.log("live value:", /* config.<section>.myNewKey */ );
  const { settingValue, renderSettingsMenu } = await import("./settings-menu.js");
  console.log("settingValue:", settingValue("myNewKey"));
  // For UI keys: render the page and eyeball the button labels + ✓ placement
  console.log(JSON.stringify(renderSettingsMenu("<page>"), null, 1));
  process.exit(0);   // REQUIRED — module-scope timers keep the event loop alive; without this the script hangs forever
'
node --input-type=module -e '
  const { findUnknownUserConfigKeys } = await import("./tools/executor.js");
  console.log("unknown:", findUnknownUserConfigKeys());
  process.exit(0);
'
```

The `unknown:` list must not contain the new key. (Verified working 2026-07-07 —
without `process.exit(0)` these imports hang: telegram/executor modules start
intervals at module scope.)

## Step 6 — Regression tests (test/regression-test.js)

Add to the appropriate section (or a new one following the numbering):
- Source-check: config.js contains `myNewKey: u.myNewKey ?? <default>`
- Source-check: CONFIG_MAP contains the key (if Step 2)
- Functional: `settingValue("myNewKey")` returns the mapped value (if Step 4) —
  settings-menu.js is importable in tests
- Default-value check if the default encodes a decision (e.g. thresholds)

Run: `node test/regression-test.js` → all pass (404+; note the new total).

## Step 7 — Docs + delivery

- If the key is screening/risk/management-relevant, add it to the CLAUDE.md config
  notes (or the relevant docs/ file).
- One commit for the whole key (config + UI + tests are one topic).
- Remember: the running bot won't see a `user-config.json` edit — activate via
  `/settings` (live) or restart per the `restart-bot` skill.
- **Never commit `user-config.json` / `gmgn-config.json`** (gitignored, contain keys).
  If the operator wants a value changed there, edit via python JSON round-trip
  (preserve indent=2) or tell them to use /settings.

## Renaming or removing a key

Do the checklist in reverse and also:
- Grep the whole repo for the old name (`grep -rn oldKey . --include="*.js"`).
- Remove it from `user-config.json` (JSON round-trip edit — file is gitignored but live).
- Removal without cleanup leaves a dead key that the startup validator will flag
  forever (that's how `maxBundlePct` lingered for months).
