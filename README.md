kill any app by name. fuzzy search, interactive multi-select, zero zombies.

```bash
npx cli-killapp warp
```

---

## what it does

1. scans all running processes via `ps aux`
2. on macOS, enriches with official app names via `lsappinfo` (so "Warp" is found even though its binary is named "stable")
3. fuzzy-matches your query against app name, bundle ID, command path, and binary name
4. shows an interactive multi-select checkbox — high-confidence matches (80%+) are pre-selected
5. kills entire process trees bottom-up (children first, then parent)
6. SIGTERM → brief grace → SIGKILL (-9) → process group kill
7. reaps zombie children
8. verifies processes are actually gone

## install

```bash
# use directly with npx (no install needed)
npx cli-killapp warp

# or install globally
npm i -g cli-killapp
killapp warp

# short alias
ka warp
```

## usage

```bash
killapp <name> [options]
```

### options

| flag | description |
|:---|:---|
| `-h, --help` | show help |
| `-v, --version` | show version |
| `-y, --yes` | auto-kill all 80%+ matches (no interactive prompt) |
| `-s, --silent` | suppress banner and verbose output |

### examples

```bash
killapp warp              # find and kill Warp terminal
killapp "google chrome"   # kill Chrome and all its helpers
killapp slack             # kill Slack
ka figma --yes            # auto-kill Figma without prompt
npx cli-killapp discord   # no install needed
```

## fuzzy search

the search matches against multiple fields with weighted scoring:

| field | weight | example |
|:---|:---|:---|
| app name (from lsappinfo) | 40% | "Warp" |
| bundle ID | 20% | "dev.warp.Warp-Stable" |
| app path (.app name) | 20% | "/Applications/Warp.app/..." |
| full command | 10% | "/Applications/Warp.app/Contents/MacOS/stable" |
| binary name | 10% | "stable" |

this means typing `warp` will find the Warp terminal even though its binary is called `stable`.

## platforms

- macOS — first-class support with `lsappinfo` enrichment for official app names
- Linux — `ps aux` with path-based name extraction

## license

MIT
