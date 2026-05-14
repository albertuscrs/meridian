#!/bin/bash
# update-handover.sh
# Safely append or update sections in docs/HANDOVER.md
# Usage: ./update-handover.sh [append|replace|backup|diff]

set -euo pipefail

HANDOVER_PATH="docs/HANDOVER.md"
NEW_SECTION_PATH="docs/_handover-append.md"  # temporary file with new content
BACKUP_DIR="docs/.handover-backups"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ensure_backup_dir() {
    mkdir -p "$BACKUP_DIR"
}

backup_handover() {
    ensure_backup_dir
    local timestamp=$(date +%Y%m%d-%H%M%S)
    local backup_path="$BACKUP_DIR/HANDOVER-$timestamp.md.bak"
    cp "$HANDOVER_PATH" "$backup_path"
    echo -e "${GREEN}✅ Backup: $backup_path${NC}"
    # Keep only last 10 backups
    ls -t "$BACKUP_DIR"/HANDOVER-*.md.bak 2>/dev/null | tail -n +11 | xargs -r rm
}

verify_handover_exists() {
    if [[ ! -f "$HANDOVER_PATH" ]]; then
        echo -e "${RED}❌ $HANDOVER_PATH not found${NC}"
        exit 1
    fi
}

verify_append_file_exists() {
    if [[ ! -f "$NEW_SECTION_PATH" ]]; then
        echo -e "${RED}❌ $NEW_SECTION_PATH not found${NC}"
        echo "Create this file first with the content you want to append."
        echo "Example: nano $NEW_SECTION_PATH"
        exit 1
    fi
}

# Command: append — adds new content to end of HANDOVER.md
cmd_append() {
    verify_handover_exists
    verify_append_file_exists
    backup_handover

    echo "" >> "$HANDOVER_PATH"
    cat "$NEW_SECTION_PATH" >> "$HANDOVER_PATH"

    local lines_added=$(wc -l < "$NEW_SECTION_PATH")
    echo -e "${GREEN}✅ Appended $lines_added lines to $HANDOVER_PATH${NC}"

    # Clean up temp file after successful append
    read -p "Delete $NEW_SECTION_PATH? (y/N): " confirm
    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        rm "$NEW_SECTION_PATH"
        echo -e "${GREEN}✅ Cleaned up $NEW_SECTION_PATH${NC}"
    fi
}

# Command: replace — replace content between markers
# Markers: <!-- BEGIN:SECTION_NAME --> ... <!-- END:SECTION_NAME -->
cmd_replace() {
    verify_handover_exists
    verify_append_file_exists

    if [[ -z "${1:-}" ]]; then
        echo -e "${RED}❌ Section name required${NC}"
        echo "Usage: $0 replace SECTION_NAME"
        echo "Markers must exist in $HANDOVER_PATH:"
        echo "  <!-- BEGIN:SECTION_NAME -->"
        echo "  ...old content..."
        echo "  <!-- END:SECTION_NAME -->"
        exit 1
    fi

    local section="$1"
    local begin_marker="<!-- BEGIN:$section -->"
    local end_marker="<!-- END:$section -->"

    if ! grep -q "$begin_marker" "$HANDOVER_PATH"; then
        echo -e "${RED}❌ Marker $begin_marker not found${NC}"
        exit 1
    fi
    if ! grep -q "$end_marker" "$HANDOVER_PATH"; then
        echo -e "${RED}❌ Marker $end_marker not found${NC}"
        exit 1
    fi

    backup_handover

    # Use awk to replace content between markers
    awk -v begin="$begin_marker" -v endm="$end_marker" -v replacement_file="$NEW_SECTION_PATH" '
        $0 ~ begin { print; system("cat " replacement_file); in_section=1; next }
        $0 ~ endm { in_section=0; print; next }
        !in_section { print }
    ' "$HANDOVER_PATH" > "$HANDOVER_PATH.tmp"

    mv "$HANDOVER_PATH.tmp" "$HANDOVER_PATH"
    echo -e "${GREEN}✅ Replaced section $section in $HANDOVER_PATH${NC}"
}

# Command: backup — just backup, no changes
cmd_backup() {
    verify_handover_exists
    backup_handover
}

# Command: diff — show what would be appended/replaced
cmd_diff() {
    verify_handover_exists
    verify_append_file_exists

    echo -e "${YELLOW}Preview of content to append:${NC}"
    echo "─────────────────────────────────────"
    cat "$NEW_SECTION_PATH"
    echo "─────────────────────────────────────"
    echo ""
    echo "Current end of $HANDOVER_PATH:"
    tail -20 "$HANDOVER_PATH"
}

# Command: rollback — restore from most recent backup
cmd_rollback() {
    verify_handover_exists
    ensure_backup_dir

    local latest_backup=$(ls -t "$BACKUP_DIR"/HANDOVER-*.md.bak 2>/dev/null | head -1)

    if [[ -z "$latest_backup" ]]; then
        echo -e "${RED}❌ No backups found in $BACKUP_DIR${NC}"
        exit 1
    fi

    echo -e "${YELLOW}Rolling back from: $latest_backup${NC}"
    read -p "Confirm rollback? (y/N): " confirm

    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        # Backup current before rollback (defensive)
        backup_handover
        cp "$latest_backup" "$HANDOVER_PATH"
        echo -e "${GREEN}✅ Restored from $latest_backup${NC}"
    else
        echo "Rollback cancelled"
    fi
}

# Command: list-backups
cmd_list_backups() {
    ensure_backup_dir
    echo "Backups in $BACKUP_DIR:"
    ls -lh "$BACKUP_DIR"/HANDOVER-*.md.bak 2>/dev/null || echo "(no backups yet)"
}

# Main
case "${1:-help}" in
    append)
        cmd_append
        ;;
    replace)
        shift
        cmd_replace "$@"
        ;;
    backup)
        cmd_backup
        ;;
    diff)
        cmd_diff
        ;;
    rollback)
        cmd_rollback
        ;;
    list-backups)
        cmd_list_backups
        ;;
    help|*)
        cat << EOF
update-handover.sh — Safe HANDOVER.md editor

Usage:
  $0 append              Append docs/_handover-append.md to HANDOVER.md
  $0 replace SECTION     Replace content between <!-- BEGIN:SECTION --> markers
  $0 backup              Just create a backup, no changes
  $0 diff                Preview what would be appended
  $0 rollback            Restore from most recent backup
  $0 list-backups        Show all backups
  $0 help                Show this help

Workflow for append:
  1. Create docs/_handover-append.md with new content
  2. $0 diff               (preview)
  3. $0 append             (apply with auto-backup)

Workflow for replace (versioned section):
  1. Add markers to HANDOVER.md:
       <!-- BEGIN:PHASE_H -->
       ...content...
       <!-- END:PHASE_H -->
  2. Edit docs/_handover-append.md with new content (no markers)
  3. $0 replace PHASE_H

Backups stored in: $BACKUP_DIR (keeps last 10)
EOF
        ;;
esac
