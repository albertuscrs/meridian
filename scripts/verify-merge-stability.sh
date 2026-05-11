#!/bin/bash
# verify-merge-stability.sh
# Verifikasi stabilitas merge sebelum R8 implementation
# Usage: bash scripts/verify-merge-stability.sh [days]
# days: jumlah hari untuk verifikasi (default: 1)

DAYS=${1:-1}
LOG_DIR="logs"
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "🔍 Merge Stability Verification"
echo "=========================================="
echo "Checking last $DAYS day(s)..."
echo ""

# Function to check log files
check_logs() {
  local pattern="$1"
  local description="$2"
  local expected_max="${3:-999}"
  local count=0
  
  for i in $(seq 0 $((DAYS-1))); do
    date=$(date -d "-$i days" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d 2>/dev/null)
    logfile="$LOG_DIR/agent-${date}.log"
    if [ -f "$logfile" ]; then
      day_count=$(grep -c "$pattern" "$logfile" 2>/dev/null || true)
      count=$((count + day_count))
    fi
  done
  
  if [ "$count" -le "$expected_max" ]; then
    echo -e "${GREEN}✓${NC} $description: $count"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}✗${NC} $description: $count (expected <= $expected_max)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  
  return 0
}

# Function to check if pattern exists
check_exists() {
  local pattern="$1"
  local description="$2"
  local count=0
  
  for i in $(seq 0 $((DAYS-1))); do
    date=$(date -d "-$i days" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d 2>/dev/null)
    logfile="$LOG_DIR/agent-${date}.log"
    if [ -f "$logfile" ]; then
      day_count=$(grep -c "$pattern" "$logfile" 2>/dev/null || true)
      count=$((count + day_count))
    fi
  done
  
  if [ "$count" -gt 0 ]; then
    echo -e "${GREEN}✓${NC} $description: $count occurrences"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${YELLOW}⚠${NC} $description: 0 occurrences (may not have triggered yet)"
    WARN_COUNT=$((WARN_COUNT + 1))
  fi
  
  return 0
}

echo "📋 1. Bot Uptime Check"
echo "---------------------"
if ps aux | grep -i "meridian" | grep -v grep > /dev/null; then
  echo -e "${GREEN}✓${NC} Bot process is running"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "${RED}✗${NC} Bot process not found"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

echo "📋 2. Error Check (SyntaxErrors/Crashes)"
echo "----------------------------------------"
check_logs "SyntaxError" "SyntaxErrors" 0
check_logs "crash" "Crashes" 0
check_logs "fatal" "Fatal errors" 0
check_logs "uncaught" "Uncaught exceptions" 0
echo ""

echo "📋 3. R-Implementation Verification"
echo "-----------------------------------"
# R4.1: Trailing TP confirmation window (3s)
check_exists "window: 3000ms" "R4.1: Trailing TP (3s window)"

# R7: Safety-Lock
check_exists "Safety-Lock" "R7: Safety-Lock"

# R5: Pump-Hold
check_exists "Pump-Hold" "R5: Pump-Hold"

# R10: OOR consolidation
check_logs "R10" "R10: OOR errors" 0
echo ""

echo "📋 4. Profile Verification"
echo "--------------------------"
# Check user-config.json for profile setting
if [ -f "user-config.json" ]; then
  config_profile=$(grep -o '"closeProfile"[[:space:]]*:[[:space:]]*"[^"]*"' user-config.json | grep -o '"[^"]*"$' | tr -d '"')
  if [ "$config_profile" = "pecut" ]; then
    echo -e "${GREEN}✓${NC} Profile in config: 'pecut'"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}✗${NC} Profile in config: '$config_profile' (expected 'pecut')"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo -e "${RED}✗${NC} user-config.json not found"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Check logs for profile usage
PROFILE_COUNT=0
for i in $(seq 0 $((DAYS-1))); do
  date=$(date -d "-$i days" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d 2>/dev/null)
  logfile="$LOG_DIR/agent-${date}.log"
  if [ -f "$logfile" ]; then
    pecut_count=$(grep -c "profile: pecut" "$logfile" 2>/dev/null || true)
    PROFILE_COUNT=$((PROFILE_COUNT + pecut_count))
  fi
done

if [ "$PROFILE_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✓${NC} Profile 'pecut' in logs: $PROFILE_COUNT occurrences"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "${YELLOW}⚠${NC} Profile 'pecut' not in logs (may not have triggered yet)"
  WARN_COUNT=$((WARN_COUNT + 1))
fi
echo ""

echo "📋 5. No Duplicate Close Attempts"
echo "---------------------------------"
check_logs "duplicate close" "Duplicate closes" 0
echo ""

echo "📋 5b. R-Implementation Activity (Last 24h)"
echo "-------------------------------------------"
check_exists "trailing drop confirmed" "Trailing TP confirms"
check_exists "trailing drop rejected" "Trailing TP rejections (fakeout saved)"
check_exists "pump.*hold" "Pump-Hold events"
echo ""

echo "📋 6. Position Tracking"
echo "----------------------"
check_exists "Position.*marked out of range" "OOR tracking (out of range)"
check_exists "Position.*back in range" "OOR tracking (back in range)"
echo ""

echo "📋 7. Cooldown System"
echo "--------------------"
check_exists "cooldown" "Cooldown messages"
echo ""

echo "📋 8. Telegram Commands"
echo "----------------------"
check_exists "Registered.*bot commands" "Bot commands registered"
check_exists "Bot polling started" "Bot polling started"
echo ""

echo "📋 9. Cron Cycles"
echo "----------------"
check_exists "Cycles started" "Cron cycles started"
echo ""

echo "📋 10. Rate Limiting"
echo "-------------------"
check_logs "429 Too Many Requests" "Rate limit errors" 10
echo ""

echo "=========================================="
echo "📊 SUMMARY"
echo "=========================================="
echo -e "${GREEN}✓ Passed: $PASS_COUNT${NC}"
echo -e "${RED}✗ Failed: $FAIL_COUNT${NC}"
echo -e "${YELLOW}⚠ Warnings: $WARN_COUNT${NC}"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo -e "${GREEN}✅ MERGE STABILITY: PASS${NC}"
  echo ""
  echo "Stability criteria met for $DAYS day(s)."
  echo "Safe to proceed with R8 implementation."
  exit 0
else
  echo -e "${RED}❌ MERGE STABILITY: FAIL${NC}"
  echo ""
  echo "Issues detected. Review failures before proceeding."
  exit 1
fi
