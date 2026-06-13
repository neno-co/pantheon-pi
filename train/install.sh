#!/usr/bin/env bash
# Install the `train` orchestrator so it can be run as a plain command instead of
# `bun run .../cli.ts` (or the old `deno run -A ...`). Idempotent — safe to re-run.
#
#   ./install.sh            # install deps, the `train` launcher, and slash commands
#   ./install.sh --force    # also overwrite existing ~/.claude/commands/*.md
#
# What it does:
#   1. installs train dependencies with bun
#   2. drops a `train` launcher on your PATH (~/.bun/bin or ~/.local/bin)
#   3. installs the four stage slash-commands into ~/.claude/commands so the
#      Agent SDK sessions can resolve /implement-linear-auto, /review-pr,
#      /address-pr, and /merge-pr regardless of which repo a stage runs in.
set -euo pipefail

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

TRAIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$TRAIN_DIR/cli.ts"

command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)"; exit 1; }

echo "==> Installing dependencies"
(cd "$TRAIN_DIR" && bun install >/dev/null)

# Pick a bin dir already on PATH; prefer bun's, fall back to ~/.local/bin.
BIN_DIR=""
case ":$PATH:" in
	*":$HOME/.bun/bin:"*) BIN_DIR="$HOME/.bun/bin" ;;
	*":$HOME/.local/bin:"*) BIN_DIR="$HOME/.local/bin" ;;
	*) BIN_DIR="$HOME/.local/bin" ;;
esac
mkdir -p "$BIN_DIR"

LAUNCHER="$BIN_DIR/train"
echo "==> Installing launcher at $LAUNCHER"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec bun "$CLI" "\$@"
EOF
chmod +x "$LAUNCHER"

case ":$PATH:" in
	*":$BIN_DIR:"*) : ;;
	*) echo "    note: $BIN_DIR is not on your PATH — add it, e.g. 'export PATH=\"$BIN_DIR:\$PATH\"'" ;;
esac

# Install the stage slash-commands into the user scope so SDK sessions resolve them.
CMD_DIR="$HOME/.claude/commands"
echo "==> Installing stage commands into $CMD_DIR"
mkdir -p "$CMD_DIR"
for cmd in implement-linear-auto review-pr address-pr merge-pr; do
	src="$TRAIN_DIR/commands/$cmd.md"
	dst="$CMD_DIR/$cmd.md"
	if [[ -f "$dst" && $FORCE -eq 0 ]]; then
		echo "    skip $cmd.md (exists; use --force to overwrite)"
	else
		cp "$src" "$dst"
		echo "    installed $cmd.md"
	fi
done

echo
echo "Done. Try: train help"
