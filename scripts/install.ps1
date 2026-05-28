#Requires -Version 5.1
<#
.SYNOPSIS
    claude-rca installer for Windows

.DESCRIPTION
    Installs claude-rca — a local-first CLI that turns bug-fix commits into
    structured Root Cause Analysis Markdown artifacts.

    Checks prerequisites (Node.js >= 20, git, ripgrep, Claude Code CLI),
    installs missing tools where possible, clones the repo, runs npm ci && npm link,
    and runs claude-rca doctor to verify the setup.

.NOTES
    Repository : https://github.com/Muminur/RCA-Ninja.git
    Requires   : Windows 10 / Windows Server 2019 or later (winget available)
    Run as     : Regular user with internet access. Elevation prompted only for
                 winget/choco ripgrep install if needed.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$REPO_URL    = 'https://github.com/Muminur/RCA-Ninja.git'
$INSTALL_DIR = Join-Path $env:USERPROFILE '.claude-rca'
$MIN_NODE    = 20
$MIN_GIT_MAJOR = 2
$MIN_GIT_MINOR = 20

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
function Write-Banner {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║           claude-rca  installer  v0.1.0             ║" -ForegroundColor Cyan
    Write-Host "  ║   Turn bug-fix commits into structured RCA docs     ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Repo : $REPO_URL"
    Write-Host "  Dir  : $INSTALL_DIR"
    Write-Host ""
}

function Write-Step   { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Blue }
function Write-Info   { param([string]$msg) Write-Host "  --> $msg" -ForegroundColor Cyan }
function Write-OK     { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn   { param([string]$msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err    { param([string]$msg) Write-Host "  [ERROR] $msg" -ForegroundColor Red }
function Fail         { param([string]$msg) Write-Err $msg; exit 1 }

# ---------------------------------------------------------------------------
# Check Node.js >= 20
# ---------------------------------------------------------------------------
function Test-Node {
    Write-Step "Checking Node.js (required: >= $MIN_NODE)"

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Err "Node.js not found on PATH."
        Write-Host ""
        Write-Host "  Install Node.js $MIN_NODE LTS:" -ForegroundColor Yellow
        Write-Host "    winget install OpenJS.NodeJS.LTS"
        Write-Host "    -- or --"
        Write-Host "    https://nodejs.org/en/download (choose Windows Installer)"
        Write-Host ""
        Write-Host "  After installing, close and re-open this terminal, then re-run this script."
        Write-Host ""
        Fail "Node.js >= $MIN_NODE is required."
    }

    $rawVersion = (node --version)              # e.g. v22.1.0
    $major = [int]($rawVersion -replace '^v(\d+).*', '$1')

    if ($major -lt $MIN_NODE) {
        Write-Err "Found Node.js $rawVersion but need >= $MIN_NODE."
        Write-Host ""
        Write-Host "  Upgrade Node.js:" -ForegroundColor Yellow
        Write-Host "    winget upgrade OpenJS.NodeJS.LTS"
        Write-Host "    -- or visit https://nodejs.org/en/download"
        Write-Host ""
        Fail "Node.js >= $MIN_NODE required."
    }

    Write-OK "Node.js $rawVersion"
}

# ---------------------------------------------------------------------------
# Check git >= 2.20
# ---------------------------------------------------------------------------
function Test-Git {
    Write-Step "Checking git (required: >= $MIN_GIT_MAJOR.$MIN_GIT_MINOR)"

    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Write-Err "git not found on PATH."
        Write-Host ""
        Write-Host "  Install git:" -ForegroundColor Yellow
        Write-Host "    winget install Git.Git"
        Write-Host "    -- or visit https://git-scm.com/download/win"
        Write-Host ""
        Fail "Re-run this script after installing git >= $MIN_GIT_MAJOR.$MIN_GIT_MINOR."
    }

    $gitRaw = (git --version)               # git version 2.44.0.windows.1
    if ($gitRaw -match '(\d+)\.(\d+)\.') {
        $gMajor = [int]$Matches[1]
        $gMinor = [int]$Matches[2]
    } else {
        Write-Warn "Could not parse git version string: '$gitRaw'. Proceeding anyway."
        return
    }

    if ($gMajor -lt $MIN_GIT_MAJOR -or ($gMajor -eq $MIN_GIT_MAJOR -and $gMinor -lt $MIN_GIT_MINOR)) {
        Write-Err "Found git $gMajor.$gMinor but need >= $MIN_GIT_MAJOR.$MIN_GIT_MINOR."
        Write-Host ""
        Write-Host "  Upgrade git:" -ForegroundColor Yellow
        Write-Host "    winget upgrade Git.Git"
        Write-Host ""
        Fail "git >= $MIN_GIT_MAJOR.$MIN_GIT_MINOR required."
    }

    Write-OK "git $gMajor.$gMinor (from: $gitRaw)"
}

# ---------------------------------------------------------------------------
# Check / install ripgrep
# ---------------------------------------------------------------------------
function Install-Ripgrep-Winget {
    Write-Info "Installing ripgrep via winget..."
    winget install BurntSushi.ripgrep.MSVC --accept-package-agreements --accept-source-agreements
}

function Install-Ripgrep-Choco {
    Write-Info "Installing ripgrep via Chocolatey..."
    choco install ripgrep -y
}

function Test-Ripgrep {
    Write-Step "Checking ripgrep"

    if (Get-Command rg -ErrorAction SilentlyContinue) {
        $rgVer = (rg --version | Select-Object -First 1)
        Write-OK "ripgrep — $rgVer"
        return
    }

    Write-Warn "ripgrep not found. Attempting auto-install..."

    # Try winget first (available on Windows 10 1809+ and Windows 11)
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        try {
            Install-Ripgrep-Winget
        } catch {
            Write-Warn "winget install failed: $_"
        }
    }

    # If still not found, try Chocolatey
    if (-not (Get-Command rg -ErrorAction SilentlyContinue)) {
        $choco = Get-Command choco -ErrorAction SilentlyContinue
        if ($choco) {
            try {
                Install-Ripgrep-Choco
            } catch {
                Write-Warn "Chocolatey install failed: $_"
            }
        }
    }

    # Refresh PATH so the newly installed binary is visible
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH', 'User')

    if (-not (Get-Command rg -ErrorAction SilentlyContinue)) {
        Write-Err "Could not auto-install ripgrep."
        Write-Host ""
        Write-Host "  Install ripgrep manually:" -ForegroundColor Yellow
        Write-Host "    winget install BurntSushi.ripgrep.MSVC"
        Write-Host "    -- or download from https://github.com/BurntSushi/ripgrep/releases"
        Write-Host ""
        Fail "Please install ripgrep and re-run this script."
    }

    $rgVer = (rg --version | Select-Object -First 1)
    Write-OK "ripgrep installed — $rgVer"
}

# ---------------------------------------------------------------------------
# Check / install Claude Code CLI
# ---------------------------------------------------------------------------
function Test-Claude {
    Write-Step "Checking Claude Code CLI"

    if (Get-Command claude -ErrorAction SilentlyContinue) {
        $claudeVer = try { (claude --version 2>&1) } catch { 'unknown version' }
        Write-OK "Claude Code CLI — $claudeVer"
        return
    }

    Write-Warn "Claude Code CLI not found. Installing via npm..."
    npm install -g @anthropic-ai/claude-code

    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH', 'User')

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Fail "Claude Code CLI installation failed. Run: npm install -g @anthropic-ai/claude-code"
    }

    $claudeVer = try { (claude --version 2>&1) } catch { 'unknown version' }
    Write-OK "Claude Code CLI installed — $claudeVer"

    Write-Host ""
    Write-Host "  ══════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host "  ACTION REQUIRED: You must authenticate before use!" -ForegroundColor Yellow
    Write-Host "  Run this command now:  claude login" -ForegroundColor Yellow
    Write-Host "  ══════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Clone / update repo
# ---------------------------------------------------------------------------
function Invoke-Clone {
    Write-Step "Setting up claude-rca repository at $INSTALL_DIR"

    $gitDir = Join-Path $INSTALL_DIR '.git'
    if (Test-Path $gitDir) {
        Write-Info "Existing installation found — pulling latest changes..."
        git -C $INSTALL_DIR pull --ff-only
        Write-OK "Repository updated"
    } else {
        if (Test-Path $INSTALL_DIR) {
            Write-Warn "Directory $INSTALL_DIR exists but is not a git repo. Removing it..."
            Remove-Item -Recurse -Force $INSTALL_DIR
        }
        Write-Info "Cloning $REPO_URL -> $INSTALL_DIR ..."
        git clone --depth 1 $REPO_URL $INSTALL_DIR
        Write-OK "Repository cloned"
    }
}

# ---------------------------------------------------------------------------
# npm ci + npm link
# ---------------------------------------------------------------------------
function Invoke-NpmInstall {
    Write-Step "Installing npm dependencies and linking the CLI"

    Write-Info "Running npm ci in $INSTALL_DIR ..."
    npm ci --prefix $INSTALL_DIR

    Write-Info "Running npm link ..."
    Push-Location $INSTALL_DIR
    try {
        npm link
    } finally {
        Pop-Location
    }

    # Refresh PATH so the symlink is visible in this session
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH', 'User')

    # Also add npm global bin directly in case env refresh missed it
    $npmGlobal = try { (npm config get prefix 2>$null) } catch { '' }
    if ($npmGlobal -and (Test-Path $npmGlobal)) {
        $env:PATH = "$npmGlobal;$env:PATH"
    }

    if (Get-Command claude-rca -ErrorAction SilentlyContinue) {
        Write-OK "claude-rca linked to PATH and verified"
    } else {
        Write-Warn "claude-rca linked but not yet on PATH in this session."
        Write-Host "    Close and re-open your terminal, then verify with: claude-rca --version" -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# Run doctor
# ---------------------------------------------------------------------------
function Invoke-Doctor {
    Write-Step "Running claude-rca doctor"

    $doctorOk = $true
    try {
        claude-rca doctor
        if ($LASTEXITCODE -ne 0) { $doctorOk = $false }
    } catch {
        $doctorOk = $false
    }

    if (-not $doctorOk) {
        Write-Warn "doctor reported one or more issues above — review them before proceeding."
    } else {
        Write-OK "All environment checks passed"
    }
}

# ---------------------------------------------------------------------------
# Optional: Obsidian REST API integration setup
# ---------------------------------------------------------------------------
function Invoke-ObsidianSetup {
    Write-Host ""
    Write-Step "Optional: Obsidian vault sync"

    $answer = Read-Host "  Would you like to set up Obsidian vault sync? [y/N]"
    if ($answer -notmatch '^[Yy]') {
        Write-Info "Skipping Obsidian setup."
        return
    }

    Write-Host ""
    Write-Info "For REST API sync, install 'Local REST API' plugin in Obsidian:"
    Write-Host "    1. Obsidian -> Settings -> Community plugins -> Browse -> 'Local REST API'"
    Write-Host "    2. Install, enable, and copy the API key from plugin settings"
    Write-Host ""

    $apiKey = Read-Host "  Enter your Obsidian REST API key (leave blank for filesystem-only sync)"
    $vaultPath = Read-Host "  Enter your Obsidian vault path (e.g. C:\Users\You\Documents\My Vault)"

    # Write secrets to .env (gitignored), not .claude-rca.json
    if ($apiKey -ne '' -or $vaultPath -ne '') {
        $envExample = Join-Path $INSTALL_DIR '.env.example'
        $targetEnv = Join-Path (Get-Location) '.env'
        if (-not (Test-Path $targetEnv) -and (Test-Path $envExample)) {
            Copy-Item $envExample $targetEnv
            Write-Info "Created .env from template (gitignored)"
        }
        if ($apiKey -ne '') {
            $envContent = if (Test-Path $targetEnv) { Get-Content $targetEnv -Raw } else { '' }
            if ($envContent -match 'OBSIDIAN_API_KEY=') {
                $envContent = $envContent -replace 'OBSIDIAN_API_KEY=.*', "OBSIDIAN_API_KEY=$apiKey"
            } else {
                $envContent += "`nOBSIDIAN_API_KEY=$apiKey`nOBSIDIAN_HOST=127.0.0.1`nOBSIDIAN_PORT=27124`n"
            }
            Set-Content -Path $targetEnv -Value $envContent -Encoding UTF8
            Write-OK "API key saved to .env (not committed to git)"
        }
    }

    if ($vaultPath -ne '') {
        claude-rca config --set "obsidian.vault_path=$vaultPath"
        Write-OK "Vault path set: $vaultPath"
    }

    claude-rca config --set "obsidian.enabled=true"
    claude-rca config --set "auto_generate=true"
    Write-OK "Obsidian sync enabled, auto-generate on fix: commits activated"
}

# ---------------------------------------------------------------------------
# Optional: MCP server setup
# ---------------------------------------------------------------------------
function Invoke-McpSetup {
    Write-Host ""
    Write-Step "Optional: MCP server configuration"

    Write-Info "claude-rca ships an MCP server that exposes RCA tools to Claude Desktop."
    Write-Host "  Run it with: claude-rca mcp-server"
    Write-Host ""

    # Detect Claude Desktop config location on Windows
    $configPath = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'

    $manualInstructions = @"

  To add the MCP server manually, merge this into your Claude Desktop config:
  $configPath

  {
    "mcpServers": {
      "claude-rca": {
        "command": "claude-rca",
        "args": ["mcp-server"]
      }
    }
  }

"@

    if (-not (Test-Path $configPath)) {
        Write-Info "Claude Desktop config not found at expected path."
        Write-Host $manualInstructions
        return
    }

    Write-Info "Found Claude Desktop config at: $configPath"
    $answer = Read-Host "  Would you like to add the claude-rca MCP server to Claude Desktop? [y/N]"
    if ($answer -notmatch '^[Yy]') {
        Write-Host $manualInstructions
        return
    }

    # Merge the mcpServers.claude-rca entry using PowerShell JSON manipulation
    try {
        $raw = Get-Content -Path $configPath -Raw -Encoding UTF8
        $cfg = $raw | ConvertFrom-Json

        # Ensure mcpServers property exists
        if (-not ($cfg.PSObject.Properties['mcpServers'])) {
            $cfg | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value ([PSCustomObject]@{})
        }

        # Add or overwrite the claude-rca entry
        $entry = [PSCustomObject]@{
            command = 'claude-rca'
            args    = @('mcp-server')
        }
        if ($cfg.mcpServers.PSObject.Properties['claude-rca']) {
            $cfg.mcpServers.'claude-rca' = $entry
        } else {
            $cfg.mcpServers | Add-Member -MemberType NoteProperty -Name 'claude-rca' -Value $entry
        }

        $updated = $cfg | ConvertTo-Json -Depth 10
        $tmpPath = $configPath + '.tmp'
        Set-Content -Path $tmpPath -Value $updated -Encoding UTF8
        Move-Item -Path $tmpPath -Destination $configPath -Force

        Write-OK "MCP server added to Claude Desktop config"
        Write-Info "Restart Claude Desktop to load the new MCP server."
    } catch {
        Write-Warn "Could not automatically update the config: $_"
        Write-Host $manualInstructions
    }
}

# ---------------------------------------------------------------------------
# Success message
# ---------------------------------------------------------------------------
function Write-Success {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "  ║        Installation complete!                       ║" -ForegroundColor Green
    Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White

    Write-Host ""
    Write-Host "  1. Authenticate with Claude (if you haven't already):"
    Write-Host "       claude login"

    Write-Host ""
    Write-Host "  2. Initialize claude-rca in your git repo:"
    Write-Host "       cd your-project"
    Write-Host "       claude-rca init          # creates config + installs git hooks"

    Write-Host ""
    Write-Host "  3. That's it! Every fix: commit now auto-generates an RCA."
    Write-Host "       git commit -m `"fix: your fix message`""
    Write-Host "       # RCA generated in background, synced to Obsidian"

    Write-Host ""
    Write-Host "  Or generate manually:  claude-rca generate"
    Write-Host "  Search your corpus:    claude-rca search `"null pointer`""
    Write-Host "  Start MCP server:      claude-rca mcp-server"
    Write-Host "  Check environment:     claude-rca doctor"

    Write-Host ""
    Write-Host "  Docs: https://github.com/Muminur/RCA-Ninja"
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
function Main {
    Write-Banner
    Test-Node
    Test-Git
    Test-Ripgrep
    Test-Claude
    Invoke-Clone
    Invoke-NpmInstall
    Invoke-Doctor
    Invoke-ObsidianSetup
    Invoke-McpSetup
    Write-Success
}

Main
