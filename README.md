# cli-killapp

Kill any app by name. Fuzzy search, interactive multi-select, zero zombies.

```
  ██╗  ██╗██╗██╗     ██╗      █████╗ ██████╗ ██████╗
  ██║ ██╔╝██║██║     ██║     ██╔══██╗██╔══██╗██╔══██╗
  █████╔╝ ██║██║     ██║     ███████║██████╔╝██████╔╝
  ██╔═██╗ ██║██║     ██║     ██╔══██║██╔═══╝ ██╔═══╝
  ██║  ██╗██║███████╗███████╗██║  ██║██║     ██║
  ╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝
```

## Install

```bash
# Use directly with npx (no install needed)
npx cli-killapp warp

# Or install globally
npm i -g cli-killapp
killapp warp

# Short alias
ka warp
```

## What it does

1. Scans all running processes via `ps aux`
2. On macOS, enriches with official app names via `lsappinfo` (so "Warp" is found even though its binary is named "stable")
3. Fuzzy-matches your query against app name, bundle ID, command path, and binary name
4. Shows an interactive multi-select checkbox — high-confidence matches (80%+) are pre-selected
5. Kills entire process trees bottom-up (children first, then parent)
6. SIGTERM → brief grace → SIGKILL (-9) → process group kill
7. Reaps zombie children
8. Verifies processes are actually gone

## Usage

```bash
killapp <name> [options]
```

### Options

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
| `-y, --yes` | Auto-kill all 80%+ matches (no interactive prompt) |
| `-s, --silent` | Suppress banner and verbose output |

### Examples

```bash
killapp warp              # Find and kill Warp terminal
killapp "google chrome"   # Kill Chrome and all its helpers
killapp slack             # Kill Slack
ka figma --yes            # Auto-kill Figma without prompt
npx cli-killapp discord   # No install needed
```

## Fuzzy Search

The search matches against multiple fields with weighted scoring:

| Field | Weight | Example |
|-------|--------|---------|
| App name (from lsappinfo) | 40% | "Warp" |
| Bundle ID | 20% | "dev.warp.Warp-Stable" |
| App path (.app name) | 20% | "/Applications/Warp.app/..." |
| Full command | 10% | "/Applications/Warp.app/Contents/MacOS/stable" |
| Binary name | 10% | "stable" |

This means typing `warp` will find the Warp terminal even though its binary is called `stable`.

## Platforms

- **macOS** — first-class support with `lsappinfo` enrichment for official app names
- **Linux** — `ps aux` with path-based name extraction

## License

MIT
