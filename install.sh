#!/usr/bin/env bash
set -euo pipefail

PANTHEON_REPO_URL="${PANTHEON_REPO_URL:-https://github.com/neno-co/pantheon-pi.git}"
PANTHEON_INSTALL_DIR="${PANTHEON_INSTALL_DIR:-${HOME}/.pantheon/pantheon-pi}"
PANTHEON_INSTALL_BRANCH="${PANTHEON_INSTALL_BRANCH:-}"
PANTHEON_INSTALL_DRY_RUN="${PANTHEON_INSTALL_DRY_RUN:-}"

log() {
  printf '\033[1;35m[pantheon]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[pantheon]\033[0m %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

print_args() {
  local separator=""
  for arg in "$@"; do
    printf '%s%q' "$separator" "$arg"
    separator=" "
  done
}

print_command() {
  printf '+ '
  print_args "$@"
  printf '\n'
}

run() {
  if [ -n "$PANTHEON_INSTALL_DRY_RUN" ]; then
    print_command "$@"
    return 0
  fi
  "$@"
}

run_in_dir() {
  local dir="$1"
  shift
  if [ -n "$PANTHEON_INSTALL_DRY_RUN" ]; then
    printf '+ cd %q && ' "$dir"
    print_args "$@"
    printf '\n'
    return 0
  fi
  (
    cd "$dir"
    "$@"
  )
}

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! have "$command_name"; then
    fail "Missing required command: ${command_name}. ${install_hint}"
  fi
}

require_command git "Install Git, then rerun this installer."
require_command bun "Install Bun first: https://bun.sh"
require_command pi "Install Pi first, then rerun this installer."
require_command acpx "Install acpx first, then rerun this installer."

log "Installing Pantheon-Pi"
log "Repo: ${PANTHEON_REPO_URL}"
log "Directory: ${PANTHEON_INSTALL_DIR}"

if [ -d "$PANTHEON_INSTALL_DIR/.git" ]; then
  log "Existing checkout found; updating with git pull --ff-only"
  run git -C "$PANTHEON_INSTALL_DIR" fetch --prune
  if [ -n "$PANTHEON_INSTALL_BRANCH" ]; then
    run git -C "$PANTHEON_INSTALL_DIR" checkout "$PANTHEON_INSTALL_BRANCH"
  fi
  run git -C "$PANTHEON_INSTALL_DIR" pull --ff-only
elif [ -e "$PANTHEON_INSTALL_DIR" ]; then
  fail "${PANTHEON_INSTALL_DIR} exists but is not a git checkout. Set PANTHEON_INSTALL_DIR to another path or move it aside."
else
  log "Cloning Pantheon-Pi"
  run mkdir -p "$(dirname "$PANTHEON_INSTALL_DIR")"
  if [ -n "$PANTHEON_INSTALL_BRANCH" ]; then
    run git clone --depth 1 --branch "$PANTHEON_INSTALL_BRANCH" "$PANTHEON_REPO_URL" "$PANTHEON_INSTALL_DIR"
  else
    run git clone --depth 1 "$PANTHEON_REPO_URL" "$PANTHEON_INSTALL_DIR"
  fi
fi

log "Installing package dependencies"
run bun install --cwd "$PANTHEON_INSTALL_DIR"

log "Registering Pantheon as a Pi package"
run_in_dir "$PANTHEON_INSTALL_DIR" pi install .

log "Linking the pantheon launcher onto your PATH"
run_in_dir "$PANTHEON_INSTALL_DIR" bun link

log "Verifying packaged assets"
run_in_dir "$PANTHEON_INSTALL_DIR" pantheon init

log "Pantheon installed. Before first use, make sure Claude Code, OpenAI Codex, and Gemini are authenticated locally."
printf '  claude auth login  # Claude Code / Anthropic auth\n'
printf '  codex login        # OpenAI Codex auth\n'
printf '  gemini auth login  # Google Gemini auth\n'
printf '\n'
log "Then try:"
printf '  pantheon\n'
printf '  pantheon --agent oracle\n'
printf '  pantheon telemetry stats\n'
