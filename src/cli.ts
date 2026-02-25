#!/usr/bin/env node

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import figlet from 'figlet';
import Fuse from 'fuse.js';
import { checkbox, Separator } from '@inquirer/prompts';

// ── Dynamic chalk import (ESM) ──────────────────────────────────────
const chalk = (await import('chalk')).default;

// ── Version ──────────────────────────────────────────────────────────
const _require = createRequire(import.meta.url);
const { version: VERSION } = _require('../package.json') as { version: string };

// ── Types ────────────────────────────────────────────────────────────
interface RawProcess {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
  binaryName: string;
}

interface AppInfo {
  displayName: string;
  bundleId: string;
  bundlePath: string;
}

interface EnrichedProcess {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
  binaryName: string;
  appName: string;
  appNameFromPath: string;
  bundleId: string;
  bundlePath: string;
  children: number[];
}

interface SearchResult {
  process: EnrichedProcess;
  confidence: number;
}

interface AppGroup {
  appName: string;
  bundleId: string;
  processes: SearchResult[];
  bestConfidence: number;
}

// ── ASCII Banner ─────────────────────────────────────────────────────
function showBanner(): void {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return;

  const killLines = figlet.textSync('kill', { font: 'ANSI Shadow' }).split('\n');
  const appLines = figlet.textSync('app', { font: 'ANSI Shadow' }).split('\n');

  const killGradient = [
    chalk.hex('#ff4d4d'),
    chalk.hex('#ff5a3a'),
    chalk.hex('#ff6b35'),
    chalk.hex('#ff7c28'),
    chalk.hex('#ff8c1a'),
    chalk.hex('#ffaa00'),
    chalk.hex('#ffaa00'),
  ];
  const appColor = chalk.hex('#00ffc8').bold;

  console.log();
  const rows = Math.max(killLines.length, appLines.length);
  for (let i = 0; i < rows; i++) {
    const kLine = killLines[i] || '';
    const aLine = appLines[i] || '';
    if (!kLine.trim() && !aLine.trim()) continue;
    const colorFn = killGradient[Math.min(i, killGradient.length - 1)];
    console.log('  ' + colorFn(kLine) + appColor(aLine));
  }

  console.log();
  console.log('  ' + chalk.hex('#ff6b35')('Kill'.padEnd(10)) + chalk.gray('Find and kill any app by name. Fuzzy search, no zombies.'));
  console.log('  ' + chalk.hex('#00ffc8')('App'.padEnd(10)) + chalk.gray(`v${VERSION} \u2014 killapp or ka`));
  console.log();
}

// ── Symbols ──────────────────────────────────────────────────────────
const sym = {
  arrow:  chalk.hex('#00ffc8')('\u25B6'),
  bullet: chalk.hex('#ff6b35')('\u25CF'),
  check:  chalk.green('\u2714'),
  cross:  chalk.red('\u2718'),
  warn:   chalk.yellow('\u26A0'),
  skull:  chalk.red('\u2620'),
  info:   chalk.cyan('\u25C6'),
  line:   chalk.gray('\u2502'),
  corner: chalk.gray('\u2514'),
  tee:    chalk.gray('\u251C'),
};

// ── Helpers ──────────────────────────────────────────────────────────
function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Process Discovery ────────────────────────────────────────────────
function parseProcessList(): RawProcess[] {
  const output = exec('ps aux 2>/dev/null');
  if (!output) return [];

  const lines = output.split('\n');
  const results: RawProcess[] = [];
  const myPid = process.pid;
  const myPpid = process.ppid;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // ps aux: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;

    const pid = Number(parts[1]);
    if (!pid || pid === myPid || pid === myPpid) continue;

    const user = parts[0];
    const cpu = parseFloat(parts[2]) || 0;
    const mem = parseFloat(parts[3]) || 0;
    const command = parts.slice(10).join(' ');

    const execPath = command.split(/\s/)[0];
    const binaryName = execPath.split('/').pop() || 'unknown';

    results.push({ pid, user, cpu, mem, command, binaryName });
  }

  return results;
}

function buildChildMap(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const output = exec('ps -eo pid=,ppid= 2>/dev/null');
  if (!output) return map;

  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!pid || !ppid) continue;

    if (!map.has(ppid)) map.set(ppid, []);
    map.get(ppid)!.push(pid);
  }

  return map;
}

// ── macOS App Enrichment ─────────────────────────────────────────────
function parseLsAppInfo(): Map<number, AppInfo> {
  const map = new Map<number, AppInfo>();
  if (platform() !== 'darwin') return map;

  const output = exec('lsappinfo list 2>/dev/null');
  if (!output) return map;

  const lines = output.split('\n');
  let displayName = '';
  let bundleId = '';
  let bundlePath = '';
  let pid = 0;

  for (const line of lines) {
    // Entry header: N) "DisplayName" ASN:...
    const headerMatch = line.match(/^\s*\d+\)\s+"(.+?)"\s+ASN:/);
    if (headerMatch) {
      // Flush previous entry
      if (pid > 0 && displayName) {
        map.set(pid, { displayName, bundleId, bundlePath });
      }
      displayName = headerMatch[1];
      bundleId = '';
      bundlePath = '';
      pid = 0;
      continue;
    }

    const bundleMatch = line.match(/^\s*bundleID="(.+?)"/);
    if (bundleMatch) {
      bundleId = bundleMatch[1];
      continue;
    }

    const pathMatch = line.match(/^\s*bundle path="(.+?)"/);
    if (pathMatch) {
      bundlePath = pathMatch[1];
      continue;
    }

    const pidMatch = line.match(/\bpid\s*=\s*(\d+)/);
    if (pidMatch) {
      pid = Number(pidMatch[1]);
      continue;
    }
  }

  // Flush last entry
  if (pid > 0 && displayName) {
    map.set(pid, { displayName, bundleId, bundlePath });
  }

  return map;
}

// ── Enrichment ───────────────────────────────────────────────────────
function enrichProcesses(
  raw: RawProcess[],
  appInfoMap: Map<number, AppInfo>,
  childMap: Map<number, number[]>,
): EnrichedProcess[] {
  return raw.map((proc) => {
    const info = appInfoMap.get(proc.pid);

    // Extract app name from .app path: /Applications/Warp.app/... -> "Warp"
    const appPathMatch = proc.command.match(/\/([^/]+)\.app\b/);
    const appNameFromPath = appPathMatch ? appPathMatch[1] : '';

    const appName = info?.displayName || appNameFromPath || proc.binaryName;
    const children = childMap.get(proc.pid) || [];

    return {
      ...proc,
      appName,
      appNameFromPath,
      bundleId: info?.bundleId || '',
      bundlePath: info?.bundlePath || '',
      children,
    };
  });
}

// ── Fuzzy Search ─────────────────────────────────────────────────────
function searchProcesses(processes: EnrichedProcess[], query: string): SearchResult[] {
  const fuse = new Fuse(processes, {
    keys: [
      { name: 'appName', weight: 0.40 },
      { name: 'bundleId', weight: 0.20 },
      { name: 'appNameFromPath', weight: 0.20 },
      { name: 'command', weight: 0.10 },
      { name: 'binaryName', weight: 0.10 },
    ],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
  });

  const results = fuse.search(query);

  return results
    .map((r) => ({
      process: r.item,
      confidence: 1 - (r.score ?? 1),
    }))
    .filter((r) => r.confidence >= 0.5);
}

// ── Grouping ─────────────────────────────────────────────────────────
function groupByApp(results: SearchResult[]): AppGroup[] {
  const groups = new Map<string, AppGroup>();

  for (const result of results) {
    const p = result.process;
    const key = (p.appNameFromPath || p.appName || p.binaryName).toLowerCase();

    if (!groups.has(key)) {
      groups.set(key, {
        appName: p.appName,
        bundleId: p.bundleId,
        processes: [],
        bestConfidence: 0,
      });
    }

    const group = groups.get(key)!;
    group.processes.push(result);
    if (result.confidence > group.bestConfidence) {
      group.bestConfidence = result.confidence;
      group.appName = p.appName;
      if (p.bundleId) group.bundleId = p.bundleId;
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.bestConfidence - a.bestConfidence || a.appName.localeCompare(b.appName),
  );
}

// ── Confidence Label ─────────────────────────────────────────────────
function confidenceLabel(confidence: number): string {
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.9) return chalk.green(`${pct}% match`);
  if (confidence >= 0.7) return chalk.yellow(`${pct}% match`);
  if (confidence >= 0.5) return chalk.gray(`${pct}% match`);
  return chalk.dim(`${pct}% match`);
}

// ── Interactive Multi-Select ─────────────────────────────────────────
async function showInteractiveSelect(groups: AppGroup[]): Promise<EnrichedProcess[]> {
  type Choice = { name: string; value: EnrichedProcess; checked: boolean };
  const choices: (Choice | Separator)[] = [];

  for (const group of groups) {
    const confLabel = confidenceLabel(group.bestConfidence);
    const bundleLabel = group.bundleId ? chalk.gray(` (${group.bundleId})`) : '';
    choices.push(
      new Separator(
        `  ${chalk.bold.white(group.appName)}${bundleLabel} ${confLabel} ` +
        chalk.gray(`\u2014 ${group.processes.length} process${group.processes.length > 1 ? 'es' : ''}`),
      ),
    );

    const sorted = [...group.processes].sort(
      (a, b) => b.confidence - a.confidence || b.process.cpu - a.process.cpu,
    );

    for (const result of sorted) {
      const p = result.process;
      const conf = result.confidence;

      const colorFn =
        conf >= 0.9 ? chalk.green :
        conf >= 0.7 ? chalk.yellow :
        chalk.gray;

      const cpuStr = p.cpu > 0 ? chalk.yellow(`${p.cpu.toFixed(1)}%cpu`) : chalk.gray('0%cpu');
      const memStr = p.mem > 0 ? chalk.cyan(`${p.mem.toFixed(1)}%mem`) : '';
      const cmdShort = p.command.length > 60 ? p.command.slice(0, 57) + '...' : p.command;

      const name =
        `${colorFn(`PID ${String(p.pid).padEnd(7)}`)}` +
        `${chalk.gray('\u2502')} ${cpuStr} ${memStr ? chalk.gray('\u2502') + ' ' + memStr + ' ' : ''}` +
        `${chalk.gray('\u2502')} ${chalk.white(p.binaryName)}` +
        `\n       ${chalk.gray(cmdShort)}`;

      choices.push({
        name,
        value: p,
        checked: conf >= 0.8,
      });
    }
  }

  const selected = await checkbox<EnrichedProcess>({
    message: `Select processes to kill ${chalk.gray('(space=toggle, enter=confirm)')}`,
    choices,
    pageSize: 20,
  });

  return selected;
}

// ── Kill Logic ───────────────────────────────────────────────────────
function killProcessTree(pid: number, allKilled: Set<number>): { killed: number[]; failed: number[] } {
  const killed: number[] = [];
  const failed: number[] = [];

  // Kill children first (bottom-up to avoid orphans becoming zombies)
  const childOutput = exec(`pgrep -P ${pid} 2>/dev/null`);
  const children = childOutput ? childOutput.split('\n').map(Number).filter(Boolean) : [];

  for (const childPid of children) {
    if (allKilled.has(childPid)) continue;
    const result = killProcessTree(childPid, allKilled);
    killed.push(...result.killed);
    failed.push(...result.failed);
  }

  if (allKilled.has(pid)) return { killed, failed };
  allKilled.add(pid);

  // SIGTERM first for brief grace period
  try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }

  spawnSync('sleep', ['0.1']);

  // SIGKILL if still alive
  if (pidExists(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }

  // Kill process group to catch stragglers
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }

  // Verify
  spawnSync('sleep', ['0.1']);
  if (pidExists(pid)) {
    failed.push(pid);
  } else {
    killed.push(pid);
  }

  return { killed, failed };
}

function reapZombies(pids: number[]): void {
  for (const pid of pids) {
    const ppidStr = exec(`ps -o ppid= -p ${pid} 2>/dev/null`);
    const ppid = Number(ppidStr);
    if (ppid > 1) {
      try { process.kill(ppid, 'SIGCHLD'); } catch { /* parent gone */ }
    }
  }
}

// ── Display ──────────────────────────────────────────────────────────
function displaySearchSummary(groups: AppGroup[], query: string): void {
  const totalProcs = groups.reduce((sum, g) => sum + g.processes.length, 0);
  console.log(
    `  ${sym.arrow} Found ${chalk.bold.white(String(totalProcs))} process${totalProcs > 1 ? 'es' : ''}` +
    ` matching ${chalk.hex('#00ffc8').bold(`"${query}"`)}` +
    ` across ${chalk.bold.white(String(groups.length))} app${groups.length > 1 ? 's' : ''}`,
  );
  console.log();
}

function displayResults(killed: number[], failed: number[], query: string): void {
  if (killed.length > 0) {
    console.log(
      `  ${sym.skull}  ${chalk.bold.white('Killed')} ` +
      `${chalk.hex('#00ffc8').bold(String(killed.length))} process${killed.length > 1 ? 'es' : ''} ` +
      `${chalk.gray('\u2014')} ${chalk.hex('#00ffc8').bold(`"${query}"`)} is ${chalk.green.bold('gone')}`,
    );
    for (const pid of killed) {
      console.log(`     ${sym.check} ${chalk.gray(`PID ${pid}`)}`);
    }
  }

  if (failed.length > 0) {
    console.log(
      `  ${sym.warn}  ${chalk.yellow.bold('Failed')} to kill ` +
      `${chalk.red.bold(String(failed.length))} process${failed.length > 1 ? 'es' : ''}`,
    );
    for (const pid of failed) {
      console.log(`     ${sym.cross} ${chalk.gray(`PID ${pid} \u2014 try with sudo`)}`);
    }
  }

  console.log();
}

// ── Self-Install ─────────────────────────────────────────────────────
const INSTALL_MARKER = join(homedir(), '.config', 'killapp', '.installed');

function isInstalledGlobally(): boolean {
  const which = exec('which killapp 2>/dev/null');
  if (!which) return false;
  if (which.includes('_npx') || which.includes('.npm/_npx')) return false;
  return true;
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}

async function offerGlobalInstall(): Promise<void> {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return;
  if (existsSync(INSTALL_MARKER)) return;
  if (isInstalledGlobally()) {
    mkdirSync(join(homedir(), '.config', 'killapp'), { recursive: true });
    writeFileSync(INSTALL_MARKER, new Date().toISOString());
    return;
  }

  console.log(`  ${chalk.gray('\u2500'.repeat(58))}`);
  console.log();
  console.log(`  ${sym.info} ${chalk.bold.white('Install globally?')} Run ${chalk.hex('#00ffc8')('killapp')} and ${chalk.hex('#00ffc8')('ka')} from anywhere.`);
  console.log();

  const yes = await promptYesNo(`  ${chalk.hex('#00ffc8')('\u25B6')} Install killapp system-wide? ${chalk.gray('[y/N]')} `);

  if (!yes) {
    mkdirSync(join(homedir(), '.config', 'killapp'), { recursive: true });
    writeFileSync(INSTALL_MARKER, 'declined');
    console.log();
    console.log(`  ${chalk.gray('No problem. Use')} ${chalk.hex('#00ffc8')('npx cli-killapp <name>')} ${chalk.gray('anytime.')}`);
    console.log();
    return;
  }

  console.log();
  console.log(`  ${sym.bullet} Installing ${chalk.hex('#00ffc8')('cli-killapp')} globally...`);
  console.log();

  try {
    execSync('npm install -g cli-killapp', { stdio: 'inherit', timeout: 30000 });
  } catch {
    console.log();
    console.log(`  ${sym.warn} ${chalk.yellow('Permission denied.')} Retrying with ${chalk.bold('sudo')}...`);
    console.log();
    try {
      execSync('sudo npm install -g cli-killapp', { stdio: 'inherit', timeout: 60000 });
    } catch {
      console.log();
      console.log(`  ${sym.cross} ${chalk.red('Install failed.')} You can install manually:`);
      console.log(`     ${chalk.gray('$')} sudo npm install -g cli-killapp`);
      console.log();
      mkdirSync(join(homedir(), '.config', 'killapp'), { recursive: true });
      writeFileSync(INSTALL_MARKER, 'failed');
      return;
    }
  }

  const killappPath = exec('which killapp 2>/dev/null');
  const kaPath = exec('which ka 2>/dev/null');

  console.log();
  console.log(`  ${sym.check} ${chalk.green.bold('Installed!')} Commands available system-wide:`);
  if (killappPath) console.log(`     ${chalk.hex('#00ffc8')('killapp')} ${chalk.gray('\u2192')} ${chalk.gray(killappPath)}`);
  if (kaPath) console.log(`     ${chalk.hex('#00ffc8')('ka')}       ${chalk.gray('\u2192')} ${chalk.gray(kaPath)}`);
  console.log();
  console.log(`  ${chalk.gray('Usage:')} ${chalk.hex('#00ffc8')('killapp warp')} ${chalk.gray('or')} ${chalk.hex('#00ffc8')('ka slack')}`);
  console.log();

  mkdirSync(join(homedir(), '.config', 'killapp'), { recursive: true });
  writeFileSync(INSTALL_MARKER, new Date().toISOString());
}

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Help
  if (args.includes('--help') || args.includes('-h')) {
    showBanner();
    console.log(`  ${chalk.bold.white('Usage')}  ${chalk.hex('#00ffc8')('killapp')} ${chalk.gray('<name>')} ${chalk.gray('[options]')}`);
    console.log(`         ${chalk.hex('#00ffc8')('npx cli-killapp')} ${chalk.gray('<name>')}`);
    console.log();
    console.log(`  ${chalk.bold.white('Options')}`);
    console.log(`    ${chalk.cyan('-h, --help')}       Show this help`);
    console.log(`    ${chalk.cyan('-v, --version')}    Show version`);
    console.log(`    ${chalk.cyan('-y, --yes')}        Auto-kill all 80%+ matches (no prompt)`);
    console.log(`    ${chalk.cyan('-s, --silent')}     Suppress banner and verbose output`);
    console.log();
    console.log(`  ${chalk.bold.white('Examples')}`);
    console.log(`    ${chalk.gray('$')} killapp warp`);
    console.log(`    ${chalk.gray('$')} killapp "google chrome"`);
    console.log(`    ${chalk.gray('$')} ka slack --yes`);
    console.log(`    ${chalk.gray('$')} npx cli-killapp figma`);
    console.log();
    process.exit(0);
  }

  // Version
  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    process.exit(0);
  }

  const silent = args.includes('--silent') || args.includes('-s');
  const autoYes = args.includes('--yes') || args.includes('-y');
  const queryArgs = args.filter((a) => !a.startsWith('-'));

  if (queryArgs.length === 0) {
    if (!silent) showBanner();
    console.error(`  ${sym.cross} ${chalk.red('No app name specified.')}`);
    console.log(`  ${chalk.gray('Usage: killapp <name>')}`);
    console.log();
    process.exit(1);
  }

  const query = queryArgs.join(' ');
  if (!silent) showBanner();

  // Step 1: Discover all processes
  const rawProcesses = parseProcessList();
  if (rawProcesses.length === 0) {
    console.log(`  ${sym.cross} ${chalk.red('Could not read process list.')}`);
    process.exit(1);
  }

  // Step 2: Enrich with lsappinfo (macOS) + child map
  const appInfoMap = parseLsAppInfo();
  const childMap = buildChildMap();
  const enriched = enrichProcesses(rawProcesses, appInfoMap, childMap);

  // Step 3: Fuzzy search
  const searchResults = searchProcesses(enriched, query);

  if (searchResults.length === 0) {
    console.log(
      `  ${sym.info} No processes found matching ` +
      `${chalk.hex('#00ffc8').bold(`"${query}"`)} ${chalk.gray('\u2014 nothing to kill')}`,
    );
    console.log();
    await offerGlobalInstall();
    process.exit(0);
  }

  // Step 4: Group by app
  const groups = groupByApp(searchResults);

  // Step 5: Display summary
  displaySearchSummary(groups, query);

  // Step 6: Select processes to kill
  let toKill: EnrichedProcess[];

  if (autoYes || !process.stdout.isTTY) {
    // Non-interactive: auto-select 80%+ confidence
    toKill = searchResults
      .filter((r) => r.confidence >= 0.8)
      .map((r) => r.process);

    if (toKill.length === 0) {
      console.log(`  ${sym.warn} ${chalk.yellow('No high-confidence matches (80%+) for auto-kill.')}`);
      console.log(`  ${chalk.gray('Run interactively to select manually.')}`);
      console.log();
      process.exit(1);
    }

    console.log(
      `  ${sym.bullet} Auto-killing ${chalk.bold.white(String(toKill.length))} ` +
      `process${toKill.length > 1 ? 'es' : ''} with 80%+ confidence...`,
    );
    console.log();
  } else {
    // Interactive: show multi-select
    toKill = await showInteractiveSelect(groups);

    if (toKill.length === 0) {
      console.log(`  ${sym.info} ${chalk.gray('No processes selected. Nothing to do.')}`);
      console.log();
      await offerGlobalInstall();
      process.exit(0);
    }
  }

  // Step 7: Kill selected processes
  const allKilled = new Set<number>();
  const totalKilled: number[] = [];
  const totalFailed: number[] = [];

  for (const proc of toKill) {
    if (allKilled.has(proc.pid)) continue;
    const { killed, failed } = killProcessTree(proc.pid, allKilled);
    totalKilled.push(...killed);
    totalFailed.push(...failed);
  }

  // Reap zombies
  reapZombies(totalKilled.concat(totalFailed));

  // Step 8: Verify with second pass
  spawnSync('sleep', ['0.2']);
  for (const proc of toKill) {
    if (pidExists(proc.pid) && !allKilled.has(proc.pid)) {
      exec(`kill -9 ${proc.pid} 2>/dev/null`);
      allKilled.add(proc.pid);
      spawnSync('sleep', ['0.1']);
      if (!pidExists(proc.pid)) {
        totalKilled.push(proc.pid);
      } else {
        totalFailed.push(proc.pid);
      }
    }
  }

  // Step 9: Show results
  displayResults(totalKilled, totalFailed, query);

  // Step 10: Offer global install
  await offerGlobalInstall();

  process.exit(totalFailed.length > 0 ? 1 : 0);
}

main();
