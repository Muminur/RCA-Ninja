#!/usr/bin/env bash
# install.sh — claude-rca installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/Muminur/RCA-Ninja/main/scripts/install.sh | bash
set -euo pipefail

# ---------------------------------------------------------------------------
# ANSI color codes
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

REPO_URL="https://github.com/Muminur/RCA-Ninja.git"
INSTALL_DIR="${HOME}/.claude-rca"
MIN_NODE_MAJOR=20
MIN_GIT_MAJOR=2
MIN_GIT_MINOR=20

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { printf "${CYAN}  -->${RESET} %s\n" "$*"; }
success() { printf "${GREEN}  [OK]${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}  [WARN]${RESET} %s\n" "$*"; }
error()   { printf "${RED}  [ERROR]${RESET} %s\n" "$*" >&2; }
die()     { error "$*"; exit 1; }
step()    { printf "\n${BOLD}${BLUE}==> %s${RESET}\n" "$*"; }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
print_banner() {
  printf "\n"
  printf "${BOLD}${CYAN}"
  printf "  ╔══════════════════════════════════════════════════════╗\n"
  printf "  ║           claude-rca  installer  v0.1.0             ║\n"
  printf "  ║   Turn bug-fix commits into structured RCA docs     ║\n"
  printf "  ╚══════════════════════════════════════════════════════╝\n"
  printf "${RESET}\n"
  printf "  Repo : %s\n" "$REPO_URL"
  printf "  Dir  : %s\n" "$INSTALL_DIR"
  printf "\n"
}

# ---------------------------------------------------------------------------
# OS detection
# ---------------------------------------------------------------------------
detect_os() {
  step "Detecting operating system"

  OS="unknown"
  DISTRO="unknown"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    OS="macos"
    info "Detected macOS $(sw_vers -productVersion)"
  elif [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    source /etc/os-release
    OS="linux"
    DISTRO="${ID:-unknown}"
    info "Detected Linux — ${NAME:-$DISTRO}"
  else
    OS="linux"
    warn "Could not read /etc/os-release; assuming generic Linux"
  fi
}

# ---------------------------------------------------------------------------
# Node.js version check
# ---------------------------------------------------------------------------
check_node() {
  step "Checking Node.js (required: >= ${MIN_NODE_MAJOR})"

  if ! command -v node &>/dev/null; then
    error "Node.js not found on PATH."
    printf "\n${BOLD}Install Node.js ${MIN_NODE_MAJOR} LTS:${RESET}\n"
    if [[ "$OS" == "macos" ]]; then
      printf "  macOS (Homebrew) : brew install node@${MIN_NODE_MAJOR}\n"
      printf "  macOS (nvm)      : brew install nvm && nvm install ${MIN_NODE_MAJOR}\n"
    else
      printf "  nvm (recommended):\n"
      printf "    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash\n"
      printf "    nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}\n"
      printf "  NodeSource apt   :\n"
      printf "    curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -\n"
      printf "    sudo apt-get install -y nodejs\n"
    fi
    printf "  Official page    : https://nodejs.org/en/download\n\n"
    die "Re-run this script after installing Node.js >= ${MIN_NODE_MAJOR}."
  fi

  node_version="$(node --version)"          # e.g. v22.1.0
  node_major="${node_version#v}"            # strip leading 'v'
  node_major="${node_major%%.*}"            # keep major only

  if (( node_major < MIN_NODE_MAJOR )); then
    error "Found Node.js ${node_version} but need >= ${MIN_NODE_MAJOR}."
    printf "\n${BOLD}Upgrade Node.js:${RESET}\n"
    printf "  nvm: nvm install ${MIN_NODE_MAJOR} && nvm alias default ${MIN_NODE_MAJOR}\n"
    printf "  Or visit: https://nodejs.org/en/download\n\n"
    die "Node.js >= ${MIN_NODE_MAJOR} required."
  fi

  success "Node.js ${node_version}"
}

# ---------------------------------------------------------------------------
# git version check
# ---------------------------------------------------------------------------
check_git() {
  step "Checking git (required: >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR})"

  if ! command -v git &>/dev/null; then
    error "git not found on PATH."
    printf "\n${BOLD}Install git:${RESET}\n"
    if [[ "$OS" == "macos" ]]; then
      printf "  brew install git\n"
    else
      printf "  sudo apt-get install -y git    # Debian/Ubuntu\n"
      printf "  sudo dnf install -y git        # Fedora\n"
      printf "  sudo pacman -S git             # Arch\n"
    fi
    printf "\n"
    die "Re-run this script after installing git >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}."
  fi

  git_version="$(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
  git_major="${git_version%%.*}"
  git_rest="${git_version#*.}"
  git_minor="${git_rest%%.*}"

  if (( git_major < MIN_GIT_MAJOR )) || \
     { (( git_major == MIN_GIT_MAJOR )) && (( git_minor < MIN_GIT_MINOR )); }; then
    error "Found git ${git_version} but need >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}."
    printf "\n${BOLD}Upgrade git:${RESET}\n"
    if [[ "$OS" == "macos" ]]; then
      printf "  brew install git && brew upgrade git\n"
    else
      printf "  sudo add-apt-repository ppa:git-core/ppa   # Ubuntu/Debian\n"
      printf "  sudo apt-get update && sudo apt-get install git\n"
    fi
    printf "\n"
    die "git >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} required."
  fi

  success "git ${git_version}"
}

# ---------------------------------------------------------------------------
# ripgrep — auto-install when missing
# ---------------------------------------------------------------------------
install_ripgrep_macos() {
  if command -v brew &>/dev/null; then
    info "Installing ripgrep via Homebrew..."
    brew install ripgrep
  else
    error "Homebrew not found. Install ripgrep manually:"
    printf "  https://github.com/BurntSushi/ripgrep#installation\n\n"
    die "Please install ripgrep and re-run this script."
  fi
}

install_ripgrep_linux() {
  case "$DISTRO" in
    ubuntu|debian|linuxmint|pop|elementary|kali)
      info "Installing ripgrep via apt-get..."
      sudo apt-get update -q
      sudo apt-get install -y ripgrep
      ;;
    fedora|rhel|centos|rocky|almalinux)
      info "Installing ripgrep via dnf..."
      sudo dnf install -y ripgrep
      ;;
    arch|manjaro|endeavouros|garuda)
      info "Installing ripgrep via pacman..."
      sudo pacman -S --noconfirm ripgrep
      ;;
    opensuse*|suse*)
      info "Installing ripgrep via zypper..."
      sudo zypper install -y ripgrep
      ;;
    *)
      warn "Unknown Linux distro '${DISTRO}'. Cannot auto-install ripgrep."
      printf "\n${BOLD}Install ripgrep manually:${RESET}\n"
      printf "  cargo install ripgrep                          # via Rust/cargo\n"
      printf "  https://github.com/BurntSushi/ripgrep/releases # pre-built binaries\n\n"
      die "Please install ripgrep and re-run this script."
      ;;
  esac
}

check_ripgrep() {
  step "Checking ripgrep"

  if command -v rg &>/dev/null; then
    rg_version="$(rg --version | head -1)"
    success "ripgrep — ${rg_version}"
    return
  fi

  warn "ripgrep not found. Attempting auto-install..."

  if [[ "$OS" == "macos" ]]; then
    install_ripgrep_macos
  else
    install_ripgrep_linux
  fi

  if ! command -v rg &>/dev/null; then
    die "ripgrep installation failed. Please install it manually."
  fi

  rg_version="$(rg --version | head -1)"
  success "ripgrep installed — ${rg_version}"
}

# ---------------------------------------------------------------------------
# Claude Code CLI
# ---------------------------------------------------------------------------
check_claude() {
  step "Checking Claude Code CLI"

  if command -v claude &>/dev/null; then
    claude_version="$(claude --version 2>/dev/null || echo 'unknown version')"
    success "Claude Code CLI — ${claude_version}"
    return
  fi

  warn "Claude Code CLI not found. Installing via npm..."
  npm install -g @anthropic-ai/claude-code

  if ! command -v claude &>/dev/null; then
    die "Claude Code CLI installation failed. Run: npm install -g @anthropic-ai/claude-code"
  fi

  claude_version="$(claude --version 2>/dev/null || echo 'unknown version')"
  success "Claude Code CLI installed — ${claude_version}"

  printf "\n"
  printf "${BOLD}${YELLOW}  ══════════════════════════════════════════════════════${RESET}\n"
  printf "${BOLD}${YELLOW}  ACTION REQUIRED: You must authenticate before use!${RESET}\n"
  printf "${BOLD}${YELLOW}  Run this command now:  claude login${RESET}\n"
  printf "${BOLD}${YELLOW}  ══════════════════════════════════════════════════════${RESET}\n"
  printf "\n"
}

# ---------------------------------------------------------------------------
# Clone / update repo
# ---------------------------------------------------------------------------
clone_repo() {
  step "Setting up claude-rca repository at ${INSTALL_DIR}"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    info "Existing installation found — pulling latest changes..."
    git -C "${INSTALL_DIR}" pull --ff-only
    success "Repository updated"
  else
    if [[ -d "${INSTALL_DIR}" ]]; then
      warn "Directory ${INSTALL_DIR} exists but is not a git repo. Removing it..."
      rm -rf "${INSTALL_DIR}"
    fi
    info "Cloning ${REPO_URL} → ${INSTALL_DIR}..."
    git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
    success "Repository cloned"
  fi
}

# ---------------------------------------------------------------------------
# npm install + link
# ---------------------------------------------------------------------------
install_npm() {
  step "Installing npm dependencies and linking the CLI"

  info "Running npm ci in ${INSTALL_DIR}..."
  npm ci --prefix "${INSTALL_DIR}"

  info "Running npm link to put claude-rca on PATH..."
  # npm link must run from the package directory
  (cd "${INSTALL_DIR}" && npm link)

  # Add npm global bin to PATH for this session
  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo '')"
  if [[ -n "$npm_prefix" ]] && [[ -d "${npm_prefix}/bin" ]]; then
    export PATH="${npm_prefix}/bin:${PATH}"
  fi

  if command -v claude-rca &>/dev/null; then
    success "claude-rca linked to PATH and verified"
  else
    warn "claude-rca linked but not found on PATH in this session."
    info "Close and re-open your terminal, then verify with: claude-rca --version"
  fi
}

# ---------------------------------------------------------------------------
# Run doctor to verify everything is wired up
# ---------------------------------------------------------------------------
run_doctor() {
  step "Running claude-rca doctor"

  if ! claude-rca doctor; then
    warn "doctor reported one or more issues above — review them before proceeding."
  else
    success "All environment checks passed"
  fi
}

# ---------------------------------------------------------------------------
# Optional: Obsidian REST API integration setup
# ---------------------------------------------------------------------------
setup_obsidian_api() {
  printf "\n"
  step "Optional: Obsidian REST API integration"

  local answer=""
  read -rp "  Would you like to set up Obsidian vault sync? [y/N] " answer
  answer="${answer:-N}"

  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    info "Skipping Obsidian setup."
    return
  fi

  printf "\n"
  info "For REST API sync, install the 'Local REST API' community plugin in Obsidian:"
  printf "    1. Obsidian → Settings → Community plugins → Browse → 'Local REST API'\n"
  printf "    2. Install, enable, and copy the API key from plugin settings\n\n"

  local api_key=""
  read -rp "  Enter your Obsidian REST API key (leave blank for filesystem-only sync): " api_key

  local vault_path=""
  read -rp "  Enter your Obsidian vault path (e.g. ~/Documents/My Vault): " vault_path

  # Write secrets to .env (gitignored), not .claude-rca.json
  local env_file="${INSTALL_DIR}/.env.example"
  if [[ -n "$api_key" || -n "$vault_path" ]]; then
    local target_env="${PWD}/.env"
    if [[ ! -f "$target_env" ]] && [[ -f "$env_file" ]]; then
      cp "$env_file" "$target_env"
      info "Created .env from template (gitignored — safe for secrets)"
    fi
    if [[ -n "$api_key" ]]; then
      if [[ -f "$target_env" ]]; then
        sed -i "s|^OBSIDIAN_API_KEY=.*|OBSIDIAN_API_KEY=${api_key}|" "$target_env" 2>/dev/null || \
          printf "\nOBSIDIAN_API_KEY=${api_key}\n" >> "$target_env"
      else
        printf "OBSIDIAN_API_KEY=${api_key}\nOBSIDIAN_HOST=127.0.0.1\nOBSIDIAN_PORT=27124\n" > "$target_env"
      fi
      success "API key saved to .env (not committed to git)"
    fi
  fi

  if [[ -n "$vault_path" ]]; then
    vault_path="${vault_path/#\~/$HOME}"
    claude-rca config --set "obsidian.vault_path=${vault_path}" 2>/dev/null
    success "Vault path set: ${vault_path}"
  fi

  claude-rca config --set "obsidian.enabled=true" 2>/dev/null
  claude-rca config --set "auto_generate=true" 2>/dev/null
  success "Obsidian sync enabled, auto-generate on fix: commits activated"
}

# ---------------------------------------------------------------------------
# Optional: MCP server setup
# ---------------------------------------------------------------------------
setup_mcp() {
  printf "\n"
  step "Optional: MCP server configuration"

  info "claude-rca ships an MCP server that exposes RCA tools to Claude Desktop."
  printf "  Run it with: claude-rca mcp-server\n\n"

  # Detect Claude Desktop config location
  local config_path=""
  if [[ "$OS" == "macos" ]]; then
    config_path="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
  else
    config_path="${HOME}/.config/Claude/claude_desktop_config.json"
  fi

  if [[ ! -f "$config_path" ]]; then
    info "Claude Desktop config not found at expected path."
    printf "\n${BOLD}To add the MCP server manually, merge this into your Claude Desktop config:${RESET}\n\n"
    printf '    {\n'
    printf '      "mcpServers": {\n'
    printf '        "claude-rca": {\n'
    printf '          "command": "claude-rca",\n'
    printf '          "args": ["mcp-server"]\n'
    printf '        }\n'
    printf '      }\n'
    printf '    }\n\n'
    return
  fi

  info "Found Claude Desktop config at: ${config_path}"
  local answer=""
  read -rp "  Would you like to add the claude-rca MCP server to Claude Desktop? [y/N] " answer
  answer="${answer:-N}"

  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    printf "\n${BOLD}To add the MCP server manually, merge this into:${RESET}\n  ${config_path}\n\n"
    printf '    {\n'
    printf '      "mcpServers": {\n'
    printf '        "claude-rca": {\n'
    printf '          "command": "claude-rca",\n'
    printf '          "args": ["mcp-server"]\n'
    printf '        }\n'
    printf '      }\n'
    printf '    }\n\n'
    return
  fi

  # Merge mcpServers.claude-rca into the existing JSON config using python3 or node
  local merge_script='
import json, sys, os

config_path = sys.argv[1]
with open(config_path, "r") as f:
    cfg = json.load(f)

cfg.setdefault("mcpServers", {})
cfg["mcpServers"]["claude-rca"] = {
    "command": "claude-rca",
    "args": ["mcp-server"]
}

tmp_path = config_path + ".tmp"
with open(tmp_path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.replace(tmp_path, config_path)
print("OK")
'

  local merged=false

  if command -v python3 &>/dev/null; then
    if python3 -c "$merge_script" "$config_path" 2>/dev/null; then
      merged=true
    fi
  fi

  if [[ "$merged" != true ]] && command -v node &>/dev/null; then
    local node_script='
const fs = require("fs");
const path = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["claude-rca"] = { command: "claude-rca", args: ["mcp-server"] };
const tmp = path + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
fs.renameSync(tmp, path);
console.log("OK");
'
    if node -e "$node_script" "$config_path" 2>/dev/null; then
      merged=true
    fi
  fi

  if [[ "$merged" == true ]]; then
    success "MCP server added to Claude Desktop config"
    info "Restart Claude Desktop to load the new MCP server."
  else
    warn "Could not automatically update the config (no python3 or node available)."
    printf "\n${BOLD}Add this manually to:${RESET}\n  ${config_path}\n\n"
    printf '    "mcpServers": {\n'
    printf '      "claude-rca": {\n'
    printf '        "command": "claude-rca",\n'
    printf '        "args": ["mcp-server"]\n'
    printf '      }\n'
    printf '    }\n\n'
  fi
}

# ---------------------------------------------------------------------------
# Final success message
# ---------------------------------------------------------------------------
print_success() {
  printf "\n"
  printf "${GREEN}${BOLD}"
  printf "  ╔══════════════════════════════════════════════════════╗\n"
  printf "  ║        Installation complete!                       ║\n"
  printf "  ╚══════════════════════════════════════════════════════╝\n"
  printf "${RESET}\n"
  printf "${BOLD}Next steps:${RESET}\n\n"
  printf "  1. Authenticate with Claude (if you haven't already):\n"
  printf "       claude login\n\n"
  printf "  2. Initialize claude-rca in your git repo:\n"
  printf "       cd your-project\n"
  printf "       claude-rca init          ${CYAN}# creates config + installs git hooks${RESET}\n\n"
  printf "  3. That's it! Every ${BOLD}fix:${RESET} commit now auto-generates an RCA.\n"
  printf "       git commit -m \"fix: your fix message\"\n"
  printf "       ${CYAN}# → RCA generated in background, synced to Obsidian${RESET}\n\n"
  printf "  Or generate manually:  claude-rca generate\n"
  printf "  Search your corpus:    claude-rca search \"null pointer\"\n"
  printf "  Start MCP server:      claude-rca mcp-server\n"
  printf "  Check environment:     claude-rca doctor\n\n"
  printf "  Docs: https://github.com/Muminur/RCA-Ninja\n\n"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  print_banner
  detect_os
  check_node
  check_git
  check_ripgrep
  check_claude
  clone_repo
  install_npm
  run_doctor
  setup_obsidian_api
  setup_mcp
  print_success
}

main "$@"
