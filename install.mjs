#!/usr/bin/env node
// ai-pack installer - connects every coding-agent harness on this machine to this folder.
// Zero dependencies, Node >= 18, Windows / macOS / Linux. Run `node install.mjs help`.
//
// Safety model: every change is recorded in ~/.ai-pack/state.json and `uninstall` undoes exactly
// that. Links are removed as links (never followed), real folders are never deleted, generated
// files are removed only while unchanged, user text around the managed blocks is kept, and an
// instruction file is copied to ~/.ai-pack/backups before its first edit.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const COMMAND_NAMES = ['install', 'uninstall', 'status', 'doctor', 'tags', 'enable', 'disable', 'update', 'zip', 'list', 'help', 'table'];
const FLAGS = { only: 'value', skip: 'value', home: 'value', root: 'value', platform: 'value', tags: 'value', all: 1, 'no-skills': 1, 'no-agents': 1, 'no-rules': 1, copy: 1, force: 1, 'with-git-hooks': 1, 'dry-run': 1 };
const ARGS = parseArgs(process.argv.slice(2));
const CMD = ARGS.help ? 'help' : ARGS._[0] || 'install';
const PACK = path.resolve(ARGS.root || path.dirname(fileURLToPath(import.meta.url)));
const HOME = path.resolve(ARGS.home || process.env.AI_PACK_HOME || os.homedir());
const TEST_HOME = Boolean(ARGS.home || process.env.AI_PACK_HOME);
const PLATFORM = (CMD === 'table' && ARGS.platform) || process.platform; // override only renders docs
const WIN = PLATFORM === 'win32';
const ENV = (k) => (TEST_HOME ? undefined : process.env[k]);
const p = (...xs) => path.join(...xs);
const H = (...xs) => p(HOME, ...xs);
const posix = (x) => x.split(path.sep).join('/');
const XDG = ENV('XDG_CONFIG_HOME') || H('.config');
const APPDATA = WIN ? ENV('APPDATA') || H('AppData', 'Roaming') : null;
const LOCALAPPDATA = WIN ? ENV('LOCALAPPDATA') || H('AppData', 'Local') : null;
const STATE_DIR = H('.ai-pack');
const STATE_FILE = p(STATE_DIR, 'state.json');
const LOCAL_FILE = p(PACK, '.ai-pack-local.json');
const RULES = p(PACK, 'rules', 'global-work-rules.md');
const RULES_MIN = p(PACK, 'rules', 'global-work-rules.min.md');
const BEGIN = '<!-- ai-pack:begin (managed by ai-pack install.mjs - edit outside this block) -->';
const BEGIN_TAG = '<!-- ai-pack:begin';
const END = '<!-- ai-pack:end -->';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DRY = Boolean(ARGS['dry-run']);
const listArg = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const OPT = {
  only: listArg(ARGS.only), skip: listArg(ARGS.skip), all: Boolean(ARGS.all), copy: Boolean(ARGS.copy), force: Boolean(ARGS.force),
  skills: !ARGS['no-skills'], agents: !ARGS['no-agents'], rules: !ARGS['no-rules'], hooks: Boolean(ARGS['with-git-hooks']), resync: false,
};

// ------------------------------------------------------------------------------------------ registry
// Global (user-level) locations only; project files are the project's business. Sources: each
// tool's docs/source as of 2026-09 (see README). Fields, all optional:
//   skills.reads   every global skill dir the tool scans. The installer links the pack's skills
//                  (one link per skill) into as FEW of them as possible, so no tool sees a skill twice.
//   skills.legacy  deprecated dirs: a link from there into this pack is removed (duplicates).
//   skills.dedupe  false: lists a skill found in two dirs twice; 'unverified': may do so.
//   agents         { mode: 'subdir', dir }  live link (tool scans agent dirs recursively), or
//                  { format, dir }          converted copies.
//   rules          { mode: 'file' | 'inline' | 'inline-min' | 'import' | 'manual', file, header, note,
//                    maxBytes | maxChars, fallback: 'min', shadowedBy, replaces, onlyWith + otherwise }
//   servedBy       (agents, rules) skip when one of these tools already provides them: it reads the
//                  same files (VS Code reads ~/.claude/agents and ~/.claude/rules, Cursor/goose read
//                  ~/.claude/agents).
const CODEX_HOME = ENV('CODEX_HOME') || H('.codex');
const COPILOT_HOME = ENV('COPILOT_HOME') || H('.copilot');
const GEMINI_HOME = ENV('GEMINI_CLI_HOME') ? p(ENV('GEMINI_CLI_HOME'), '.gemini') : H('.gemini');
const HERMES_HOME = ENV('HERMES_HOME') || (WIN && lstat(p(LOCALAPPDATA, 'hermes')) ? p(LOCALAPPDATA, 'hermes') : H('.hermes'));
const PI_DIR = ENV('PI_CODING_AGENT_DIR') || H('.pi', 'agent');
const GOOSE_CFG = WIN ? p(APPDATA, 'Block', 'goose', 'config') : p(XDG, 'goose');
const ZED_CFG = WIN ? p(APPDATA, 'Zed') : p(XDG, 'zed');
const VSCODE_USER = WIN ? p(APPDATA, 'Code', 'User') : PLATFORM === 'darwin' ? H('Library', 'Application Support', 'Code', 'User') : p(XDG, 'Code', 'User');
const AGENTS_SKILLS = H('.agents', 'skills');
const CLAUDE_SKILLS = H('.claude', 'skills');
const COPILOT_INSTRUCTIONS = p(COPILOT_HOME, 'instructions', 'ai-pack.instructions.md');
const APPLY_ALL = '---\napplyTo: "**"\n---\n\n';
const EXT_DIRS = ['.vscode', '.vscode-insiders', '.vscode-oss', '.cursor', '.windsurf'].map((d) => H(d, 'extensions'));
const entries = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const hasExt = (id) => () => EXT_DIRS.some((d) => entries(d).some((e) => e.toLowerCase().startsWith(`${id}-`)));
const anyOf = (...xs) => () => xs.some((x) => x());
const bin = (b) => () => which(b);
const dir = (d) => () => exists(d);

const HARNESSES = [
  { id: 'claude', name: 'Claude Code (CLI, VS Code, JetBrains, desktop)', detect: anyOf(bin('claude'), dir(H('.claude'))),
    skills: { reads: [CLAUDE_SKILLS] },
    agents: { mode: 'subdir', dir: H('.claude', 'agents', 'ai-pack') },
    rules: { mode: 'file', file: H('.claude', 'rules', 'ai-pack.md') } },
  { id: 'codex', name: 'OpenAI Codex (CLI, IDE extension, app)', detect: anyOf(bin('codex'), dir(CODEX_HOME)),
    // ~/.codex/skills is not in Codex's documented discovery list (only ~/.agents/skills is): links there are removed
    skills: { reads: [AGENTS_SKILLS, p(CODEX_HOME, 'skills')], legacy: [p(CODEX_HOME, 'skills')], dedupe: false },
    agents: { format: 'codex', dir: p(CODEX_HOME, 'agents') },
    rules: { mode: 'inline', file: p(CODEX_HOME, 'AGENTS.md'), maxBytes: 32 * 1024, fallback: 'min', shadowedBy: p(CODEX_HOME, 'AGENTS.override.md') } },
  { id: 'opencode', name: 'OpenCode', detect: anyOf(bin('opencode'), dir(p(XDG, 'opencode'))),
    skills: { reads: [AGENTS_SKILLS, CLAUDE_SKILLS, p(XDG, 'opencode', 'skills')] },
    agents: { format: 'opencode', dir: p(XDG, 'opencode', 'agents') },
    rules: { mode: 'inline', file: p(XDG, 'opencode', 'AGENTS.md'), replaces: H('.claude', 'CLAUDE.md') } },
  { id: 'kilo', name: 'Kilo Code (CLI, VS Code)', detect: anyOf(bin('kilo'), dir(p(XDG, 'kilo')), dir(H('.kilo')), dir(H('.kilocode')), hasExt('kilocode.kilo-code')),
    skills: { reads: [AGENTS_SKILLS, CLAUDE_SKILLS, H('.kilo', 'skills')] },
    agents: { format: 'opencode', dir: p(XDG, 'kilo', 'agents') },
    rules: { mode: 'manual', note: 'add the rules file to "instructions" in ~/.config/kilo/kilo.jsonc' } },
  { id: 'gemini', name: 'Gemini CLI', detect: anyOf(bin('gemini'), dir(p(GEMINI_HOME, 'settings.json'))),
    skills: { reads: [AGENTS_SKILLS, p(GEMINI_HOME, 'skills')] },
    agents: { format: 'gemini', dir: p(GEMINI_HOME, 'agents') },
    rules: { mode: 'import', file: p(GEMINI_HOME, 'GEMINI.md') } },
  { id: 'antigravity', name: 'Google Antigravity', detect: anyOf(dir(H('.gemini', 'config')), () => entries(H('.gemini')).some((e) => e.startsWith('antigravity')), dir(H('.antigravity'))),
    skills: { reads: [H('.gemini', 'config', 'skills')] },
    // same global file as the Gemini CLI, so only write it when that tool is not being served
    rules: { mode: 'import', file: p(GEMINI_HOME, 'GEMINI.md'), servedBy: ['gemini'] },
    notes: ['Antigravity CLI keeps its own `~/.gemini/antigravity-cli/{skills,rules}` - not written'] },
  { id: 'copilot', name: 'GitHub Copilot CLI', detect: anyOf(bin('copilot'), dir(p(COPILOT_HOME, 'config.json')), dir(p(COPILOT_HOME, 'session-store.db'))),
    skills: { reads: [AGENTS_SKILLS, p(COPILOT_HOME, 'skills')] },
    agents: { format: 'copilot', dir: p(COPILOT_HOME, 'agents') },
    // with Claude Code, VS Code gets the rules from ~/.claude/rules: the CLI then uses a file VS Code
    // does not read; without it both share ~/.copilot/instructions (the CLI reads both files)
    rules: { mode: 'inline', file: p(COPILOT_HOME, 'copilot-instructions.md'), onlyWith: 'claude',
      otherwise: { mode: 'file', file: COPILOT_INSTRUCTIONS, header: APPLY_ALL } } },
  { id: 'vscode-copilot', name: 'GitHub Copilot in VS Code', detect: anyOf(hasExt('github.copilot-chat'), dir(p(VSCODE_USER, 'globalStorage', 'github.copilot-chat'))),
    skills: { reads: [AGENTS_SKILLS, CLAUDE_SKILLS, p(COPILOT_HOME, 'skills')] },
    // ~/.copilot/agents is documented for the Copilot CLI only, not for VS Code: nothing written here
    rules: { mode: 'file', file: COPILOT_INSTRUCTIONS, header: APPLY_ALL, servedBy: ['claude', 'copilot'],
      note: 'VS Code reads user-level instructions in Agent Host sessions; classic Copilot Chat uses its profile settings' } },
  { id: 'cursor', name: 'Cursor (IDE, CLI)', detect: anyOf(bin('cursor'), bin('cursor-agent'), dir(H('.cursor'))),
    skills: { reads: [AGENTS_SKILLS, CLAUDE_SKILLS, H('.cursor', 'skills'), p(CODEX_HOME, 'skills')], dedupe: 'unverified' },
    agents: { format: 'cursor', dir: H('.cursor', 'agents'), servedBy: ['claude'] },
    rules: { mode: 'manual', note: 'Cursor keeps user rules in Settings > Rules only: paste rules/global-work-rules.md there once' } },
  { id: 'cline', name: 'Cline', detect: anyOf(dir(H('.cline')), bin('cline'), hasExt('saoudrizwan.claude-dev')),
    skills: { reads: [H('.cline', 'skills')] }, // Cline's docs list ~/.cline/skills, never ~/.agents/skills
    rules: { mode: 'file', file: H('.cline', 'rules', 'ai-pack.md'),
      note: 'Cline also reads ~/Documents/Cline/Rules - copy the file there if your install uses that folder' } },
  { id: 'zoo', name: 'Zoo Code / Roo Code', detect: anyOf(dir(H('.roo')), hasExt('zoocodorganization.zoo-code'), hasExt('rooveterinaryinc.roo-cline')),
    skills: { reads: [AGENTS_SKILLS, H('.roo', 'skills')] },
    rules: { mode: 'file', file: H('.roo', 'rules', 'ai-pack.md') } },
  { id: 'windsurf', name: 'Windsurf / Devin Desktop', detect: anyOf(bin('windsurf'), dir(H('.codeium', 'windsurf'))),
    skills: { reads: [AGENTS_SKILLS, H('.codeium', 'windsurf', 'skills')] },
    rules: { mode: 'inline-min', file: H('.codeium', 'windsurf', 'memories', 'global_rules.md'), maxChars: 6000 } },
  { id: 'goose', name: 'goose', detect: anyOf(bin('goose'), dir(GOOSE_CFG)),
    skills: { reads: [AGENTS_SKILLS, CLAUDE_SKILLS] }, // goose documents ~/.agents/skills and ~/.claude/skills, no dir of its own
    agents: { format: 'goose', dir: H('.agents', 'agents'), servedBy: ['claude'] },
    rules: { mode: 'import', file: p(GOOSE_CFG, '.goosehints') } },
  { id: 'pi', name: 'pi coding agent', detect: dir(PI_DIR),
    skills: { reads: [AGENTS_SKILLS, p(PI_DIR, 'skills')] },
    rules: { mode: 'inline', file: p(PI_DIR, 'AGENTS.md') } },
  { id: 'hermes', name: 'Hermes Agent', detect: anyOf(bin('hermes'), dir(HERMES_HOME)),
    skills: { reads: [p(HERMES_HOME, 'skills')] },
    notes: ['rules: Hermes has no global instructions file (SOUL.md is its persona) - left alone'] },
  { id: 'amp', name: 'Amp', detect: anyOf(bin('amp'), dir(p(XDG, 'amp'))),
    skills: { reads: [AGENTS_SKILLS, p(XDG, 'amp', 'skills'), CLAUDE_SKILLS] },
    rules: { mode: 'import', file: p(XDG, 'amp', 'AGENTS.md') } },
  { id: 'zed', name: 'Zed', detect: anyOf(bin('zed'), bin('zeditor'), dir(p(ZED_CFG, 'settings.json'))),
    skills: { reads: [AGENTS_SKILLS] },
    rules: { mode: 'inline', file: p(ZED_CFG, 'AGENTS.md') } },
  { id: 'crush', name: 'Crush', detect: anyOf(bin('crush'), dir(p(XDG, 'crush'))),
    // Crush auto-scans project folders only; a global skills dir must be named in its config, and its
    // subagent support is still an unmerged PR - so neither is wired up here
    notes: [`skills: add {"options":{"skills_paths":["${posix(p(PACK, 'skills'))}"]}} to ${posix(p(XDG, 'crush', 'crush.json'))}`],
    rules: { mode: 'inline', file: p(XDG, 'crush', 'CRUSH.md') } },
  { id: 'qwen', name: 'Qwen Code', detect: anyOf(bin('qwen'), dir(H('.qwen'))),
    skills: { reads: [H('.qwen', 'skills')] },
    agents: { format: 'qwen', dir: H('.qwen', 'agents') },
    rules: { mode: 'import', file: H('.qwen', 'QWEN.md') } },
  { id: 'kiro', name: 'Kiro (IDE, CLI)', detect: anyOf(bin('kiro'), bin('kiro-cli'), dir(H('.kiro'))),
    skills: { reads: [H('.kiro', 'skills')] },
    agents: { format: 'kiro', dir: H('.kiro', 'agents') },
    rules: { mode: 'file', file: H('.kiro', 'steering', 'ai-pack.md'), header: '---\ninclusion: always\n---\n\n' } },
  { id: 'droid', name: 'Factory Droid', detect: anyOf(bin('droid'), dir(H('.factory'))),
    skills: { reads: [AGENTS_SKILLS, H('.factory', 'skills')] },
    agents: { format: 'droid', dir: H('.factory', 'droids') },
    rules: { mode: 'inline', file: H('.factory', 'AGENTS.md') } },
  { id: 'augment', name: 'Augment / Auggie', detect: anyOf(bin('auggie'), dir(H('.augment'))),
    skills: { reads: [AGENTS_SKILLS, CLAUDE_SKILLS, H('.augment', 'skills')] },
    agents: { format: 'augment', dir: H('.augment', 'agents') },
    rules: { mode: 'file', file: H('.augment', 'rules', 'ai-pack.md') } },
  { id: 'openhands', name: 'OpenHands', detect: anyOf(bin('openhands'), dir(H('.openhands'))),
    skills: { reads: [AGENTS_SKILLS, H('.openhands', 'skills')] },
    notes: ['rules: OpenHands reads only a project AGENTS.md'] },
  { id: 'commandcode', name: 'Command Code', detect: dir(H('.commandcode')),
    skills: { reads: [AGENTS_SKILLS, H('.commandcode', 'skills')] },
    agents: { format: 'commandcode', dir: H('.commandcode', 'agents') },
    rules: { mode: 'import', file: H('.commandcode', 'AGENTS.md') } },
];
const harness = (id) => HARNESSES.find((h) => h.id === id);

function help() {
  console.log(`ai-pack - skills, agents and rules for every coding agent on this machine

usage: node install.mjs [command] [options]      (or sh install.sh / install.cmd / .\\install.ps1)

commands
  install            detect tools and connect them to this folder (default; safe to re-run).
                     The first run asks which tags you use (Enter = recommended)
  tags               show your tags;  tags ts,react,postgres = exactly these;  tags +java -vue;
                     tags recommended / tags all. Items without a chosen tag go to *-disabled/
  enable <x..>       add tags (java, vue, ...) or turn one skill/agent on (skill:<name> if a tag has its name)
  disable <x..>      remove tags or turn one skill/agent off (your per-item choice beats the tags)
  status             which tools are connected, your tags
  list [tags..]      every skill/agent with its state and tags (or only those with these tags)
  doctor             health check: links, duplicates, skill-list size, Node/git
  update             git pull (keeps your tags and choices, new items follow the tags), then re-sync
  zip [names..]      dist/<skill>.zip for upload to claude.ai or ChatGPT
  uninstall          undo everything install did (links, blocks, generated files)

options
  --tags a,b         answer the tag question without asking (install), e.g. --tags recommended
  --only a,b         only these tools (ids: ${HARNESSES.map((h) => h.id).join(', ')})
  --skip a,b         all detected tools except these
  --all              also set up tools that are not detected yet
  --no-skills --no-agents --no-rules
  --copy             copy instead of linking, for drives without links (then \`install\` again after changes)
  --force            also work through / replace links that point to another folder
  --with-git-hooks   also set git's global core.hooksPath to ./hooks (opt-in)
  --dry-run          show what would happen, change nothing
  --root <dir>       act for another pack folder with the same layout (default: this folder)
  --home <dir>       act on another home directory (testing)

Moved a skill folder between skills/ and skills-disabled/ by hand, or added your own? Run
\`node install.mjs\` again so every tool follows (a later \`tags\` or \`update\` keeps such moves).`);
}

// ------------------------------------------------------------------------------------------ args
function parseArgs(a) {
  const o = { _: [], bad: [] };
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (['-h', '--help', '-?', '/?'].includes(x)) o.help = true;
    else if (!x.startsWith('--')) o._.push(x);
    else {
      const eq = x.indexOf('=');
      const k = x.slice(2, eq < 0 ? undefined : eq);
      if (!FLAGS[k]) o.bad.push(x);
      else if (FLAGS[k] !== 'value') {
        if (eq < 0) o[k] = true;
        else o.bad.push(x);
      } else {
        const v = eq >= 0 ? x.slice(eq + 1) : a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[++i] : '';
        if (v) o[k] = v;
        else o.bad.push(`${x} (needs a value)`);
      }
    }
  }
  return o;
}

// ------------------------------------------------------------------------------------------ fs helpers
function lstat(x) {
  try {
    return fs.lstatSync(x);
  } catch {
    return null;
  }
}
const exists = (x) => Boolean(lstat(x));
const isLink = (x) => Boolean(lstat(x)?.isSymbolicLink());
function linkTarget(x) {
  try {
    return path.resolve(path.dirname(x), fs.readlinkSync(x));
  } catch {
    return null;
  }
}
function realOr(x) {
  try {
    return fs.realpathSync(x);
  } catch {
    return linkTarget(x) || x;
  }
}
function norm(s) {
  const r = path.resolve(s).replace(/[\\/]+$/, '');
  return WIN ? r.toLowerCase() : r;
}
const samePath = (a, b) => Boolean(a && b) && norm(a) === norm(b);
function inside(child, parent) {
  const r = path.relative(norm(parent), norm(child));
  return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); // a child may be named "..x"
}
const insidePack = (x) => Boolean(x) && inside(x, PACK);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const WHICH = new Map();
function which(b) {
  if (TEST_HOME) return false; // a test home must not pick up the real machine's tools
  if (!WHICH.has(b)) {
    const exts = WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    const found = (process.env.PATH || '').split(path.delimiter).some((d) => d && exts.some((e) => {
      try {
        const st = fs.statSync(p(d.replace(/^"(.*)"$/, '$1'), b + e));
        return st.isFile() && (WIN || (st.mode & 0o111) !== 0);
      } catch {
        return false;
      }
    }));
    WHICH.set(b, found);
  }
  return WHICH.get(b);
}
const CREATED = []; // dirs this run created (uninstall removes them again if empty)
function mkdirp(d) {
  if (DRY) return;
  const missing = [];
  for (let cur = path.resolve(d); !exists(cur) && inside(cur, HOME); cur = path.dirname(cur)) missing.push(cur);
  fs.mkdirSync(d, { recursive: true });
  CREATED.push(...missing);
}
function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Windows: a virus scanner or an open editor can hold a file for a moment
function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(a, b);
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(40 * (i + 1));
    }
  }
}
function writeText(f, t) {
  if (DRY) return;
  const dst = isLink(f) ? realOr(f) : f; // keep the user's link (e.g. into a dotfiles repo): write its target
  if (insidePack(dst)) throw new Error(`refusing to write ${f}: it leads into the pack folder`);
  mkdirp(path.dirname(dst));
  const tmp = `${dst}.ai-pack-tmp`;
  fs.writeFileSync(tmp, t);
  try {
    const mode = lstat(dst)?.mode;
    if (mode !== undefined && !WIN) fs.chmodSync(tmp, mode & 0o7777);
    renameRetry(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
function rmLink(x) {
  if (DRY || !isLink(x)) return false;
  try {
    fs.unlinkSync(x);
  } catch {
    fs.rmdirSync(x); // Windows junctions
  }
  return true;
}
function rmTree(x) {
  const st = lstat(x); // lstat first: a link is removed as a link, never followed
  if (!st || DRY) return;
  if (st.isSymbolicLink()) rmLink(x);
  else fs.rmSync(x, { recursive: true, force: true });
}
function makeDirLink(target, link) {
  if (DRY) return;
  mkdirp(path.dirname(link));
  try {
    fs.symlinkSync(target, link, WIN ? 'junction' : 'dir');
  } catch (e) {
    throw new Error(`cannot create a link at ${link} (${e.code}): ${WIN ? 'junctions need a local NTFS drive' : 'the file system must support symlinks'} - or use --copy`);
  }
}
// content hash of a file or folder (links followed, like the copy): tells our untouched copies from edited ones
function treeHash(x) {
  const h = crypto.createHash('sha256');
  const walk = (f, rel) => {
    const st = fs.statSync(f);
    if (!st.isDirectory()) return void h.update(`${rel}\0`).update(fs.readFileSync(f)).update('\0');
    for (const e of fs.readdirSync(f).sort()) walk(p(f, e), rel ? `${rel}/${e}` : e);
  };
  try {
    walk(x, '');
    return h.digest('hex');
  } catch {
    return null;
  }
}
function copyDir(src, dst) {
  if (DRY) return null;
  fs.cpSync(src, dst, { recursive: true, dereference: true });
  return treeHash(dst);
}
// the nearest link at `x` or above it (inside HOME), and where `x` really is through it
function throughLink(x) {
  for (let cur = path.resolve(x); inside(cur, HOME) && !samePath(cur, HOME); cur = path.dirname(cur)) {
    if (isLink(cur)) {
      const target = linkTarget(cur);
      return { at: cur, target, resolved: target && p(target, path.relative(cur, path.resolve(x))) };
    }
  }
  return null;
}
const say = (ok, msg) => {
  console.log(msg);
  return ok;
};
const short = (xs, n = 6) => (xs.length > n ? `${xs.slice(0, n).join(', ')}, +${xs.length - n} more` : xs.join(', '));

// ------------------------------------------------------------------------------------------ state
function loadState() {
  const t = readText(STATE_FILE);
  if (t === null) return { version: 1, pack: PACK, actions: [] };
  for (const x of [t, readText(`${STATE_FILE}.bak`)]) {
    try {
      const s = JSON.parse(x);
      if (Array.isArray(s?.actions)) {
        if (x !== t) console.log(`warn  ${STATE_FILE} is damaged - using ${STATE_FILE}.bak`);
        return s;
      }
    } catch {}
  }
  throw new Error(`${STATE_FILE} is damaged and has no usable backup - it lists what install changed: repair it (JSON) or delete it`);
}
function saveState(s) {
  if (DRY) return;
  mkdirp(STATE_DIR);
  if (exists(STATE_FILE)) fs.copyFileSync(STATE_FILE, `${STATE_FILE}.bak`);
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n');
  renameRetry(tmp, STATE_FILE);
}
function record(s, action) {
  s.actions = s.actions.filter((a) => !(a.type === action.type && samePath(a.path, action.path)));
  s.actions.push({ ...action, at: STAMP });
}
const recOf = (s, type, x) => s.actions.find((a) => a.type === type && samePath(a.path, x));
const ours = (s, type, x) => Boolean(recOf(s, type, x));
const KIND = { skills: ['item', 'json-entry'], agents: ['link', 'generated'], rules: ['rules-file', 'block'] };
const had = (s, hid, kind) => s.actions.some((a) => KIND[kind].includes(a.type) && (a.harness === hid || (a.harnesses || []).includes(hid)));
const connectedIds = (s) => HARNESSES.filter((h) => Object.keys(KIND).some((k) => had(s, h.id, k))).map((h) => h.id);
function loadLocal() {
  const t = readText(LOCAL_FILE);
  if (t !== null) {
    try {
      const l = JSON.parse(t);
      const tags = l.tags === 'all' || (Array.isArray(l.tags) && l.tags.every((x) => typeof x === 'string')) ? l.tags : undefined;
      if (l.tags !== undefined && tags === undefined) console.log(`warn  ${LOCAL_FILE}: "tags" is not a list - ignoring it (choose again: node install.mjs tags ...)`);
      return { ...l, tags, enabled: Array.isArray(l.enabled) ? l.enabled : [], disabled: Array.isArray(l.disabled) ? l.disabled : [] };
    } catch {
      // not fatal: the skills/ and skills-disabled/ folders still show every choice, and the next
      // tags/enable/disable/update rewrites the file from them - but say so instead of silently resetting
      console.log(`warn  ${LOCAL_FILE} is damaged - ignoring it (your on/off choices are read from the folders; tags: node install.mjs tags ...)`);
    }
  }
  return { enabled: [], disabled: [] };
}
function saveLocal(l) {
  if (DRY) return;
  fs.writeFileSync(`${LOCAL_FILE}.tmp`, JSON.stringify(l, null, 1) + '\n');
  renameRetry(`${LOCAL_FILE}.tmp`, LOCAL_FILE);
}

// ------------------------------------------------------------------------------------------ catalog
function catalog() {
  const f = p(PACK, 'catalog.json');
  if (!exists(f)) throw new Error(`${f} is missing - this command needs the pack's catalog.json`);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const it of c.items) {
    it.on = it.kind === 'skill' ? p(PACK, 'skills', it.name) : p(PACK, 'agents', `${it.name}.md`);
    it.off = it.kind === 'skill' ? p(PACK, 'skills-disabled', it.name) : p(PACK, 'agents-disabled', `${it.name}.md`);
    it.now = exists(it.on) ? 'on' : exists(it.off) ? 'off' : 'missing';
  }
  return c;
}
const enabledSkills = () => entries(p(PACK, 'skills')).filter((n) => !n.startsWith('.') && exists(p(PACK, 'skills', n, 'SKILL.md'))).sort();
const enabledAgents = () => entries(p(PACK, 'agents')).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort();

// ------------------------------------------------------------------------------------------ detection
const detected = (h) => {
  try {
    return Boolean(h.detect());
  } catch {
    return false;
  }
};
function selected() {
  const unknown = [...OPT.only, ...OPT.skip].filter((id) => !harness(id));
  if (unknown.length) throw new Error(`unknown tool id(s): ${unknown.join(', ')}`);
  return HARNESSES.filter((h) => {
    if (OPT.skip.includes(h.id)) return false;
    if (OPT.only.length) return OPT.only.includes(h.id);
    return OPT.all || detected(h);
  });
}

// Link the pack's skills into as few dirs as possible so that every tool sees them exactly once.
function planSkillRoots(hs) {
  const roots = new Map(); // dir -> { dir, harnesses: [] }
  const add = (d, h) => {
    const k = norm(d);
    if (!roots.has(k)) roots.set(k, { dir: d, harnesses: [] });
    roots.get(k).harnesses.push(h.id);
  };
  const withSkills = hs.filter((h) => h.skills);
  for (const h of withSkills) if (h.skills.reads.length === 1) add(h.skills.reads[0], h);
  for (const h of withSkills) {
    if (h.skills.reads.length === 1) continue;
    const hit = h.skills.reads.find((d) => roots.has(norm(d)));
    if (hit) roots.get(norm(hit)).harnesses.push(h.id);
    else add(h.skills.reads.includes(AGENTS_SKILLS) ? AGENTS_SKILLS : h.skills.reads[0], h);
  }
  const dupes = withSkills
    .map((h) => [h, h.skills.reads.filter((d) => roots.has(norm(d)))])
    .filter(([, ds]) => ds.length > 1);
  return { roots: [...roots.values()], dupes };
}
// a tool in `list` provides this kind already (in this run, or connected earlier and not re-run now)
const served = (list, kind, ctx) => (list || []).some((x) => ctx.provided[kind].has(x) || (!ctx.ids.has(x) && had(ctx.state, x, kind)));

// ------------------------------------------------------------------------------------------ install
async function install() {
  if (!exists(p(PACK, 'skills'))) throw new Error(`${PACK} is not a ai-pack folder (no skills/)`);
  if (inside(HOME, PACK)) throw new Error('the home folder lies inside the pack folder - use another --home');
  const state = loadState();
  if (state.pack && !samePath(state.pack, PACK) && state.actions.length) {
    if (exists(state.pack)) throw new Error(`already installed from ${state.pack} - run \`node install.mjs uninstall\` there first`);
    console.log(`note  the pack moved from ${state.pack}: relinking everything to ${PACK}`);
  }
  const interrupted = loadLocal().updating;
  if (interrupted) console.log('warn  an update was interrupted - run `node install.mjs update` again');
  state.pack = PACK;
  const hs = selected();
  if (!hs.length) {
    if (!OPT.resync) console.log(`No coding-agent tool detected. Use --only <id> or --all (ids: ${HARNESSES.map((h) => h.id).join(', ')}).`);
    return;
  }
  // before anything is linked, so the tools see only the chosen items (re-syncs keep the choice)
  if (!interrupted && !OPT.resync && (OPT.skills || OPT.agents)) await chooseTags();
  const ids = new Set(hs.map((h) => h.id));
  const ctx = { state, ids, provided: { agents: new Set(), rules: new Set() } };
  // a re-sync (enable/disable/update) refreshes what is there and never adds tools or kinds the user left out
  const wants = (h, kind) => !OPT.resync || had(state, h.id, kind);
  console.log(`${DRY ? '[dry-run] ' : ''}ai-pack -> ${PACK}\ntools: ${hs.map((h) => h.id).join(', ')}\n`);
  try {
    if (OPT.skills) installSkills(hs.filter((h) => wants(h, 'skills')), ctx);
    for (const h of hs) {
      const lines = [];
      if (h.agents && OPT.agents && wants(h, 'agents')) lines.push(...installAgents(h, ctx));
      if (h.rules && OPT.rules && wants(h, 'rules')) lines.push(...installRules(h, ctx));
      if (!OPT.resync) for (const n of h.notes || []) lines.push(`  note  ${n}`);
      if (lines.length) console.log(`${h.name}\n${lines.join('\n')}`);
    }
    if (OPT.hooks) installHooks(state);
  } finally {
    // saved even when a step failed, so uninstall and the next run know about every change made
    for (const d of CREATED) if (!ours(state, 'dir', d)) record(state, { type: 'dir', path: d });
    saveState(state);
  }
  console.log(`\n${DRY ? 'dry-run finished - nothing changed.' : 'done.'} Restart open agent sessions. \`node install.mjs doctor\` checks the result.`);
}

function installSkills(hs, ctx) {
  const { state, ids } = ctx;
  const { roots, dupes } = planSkillRoots(hs);
  if (!roots.length) return;
  console.log('skills');
  const ok = new Set();
  for (const r of roots) if (linkItems(r, state)) ok.add(norm(r.dir));
  // a folder an earlier run linked for tools that now all reach the skills elsewhere: clean it up
  const planned = new Set(roots.map((r) => norm(r.dir)));
  const old = new Map();
  for (const a of state.actions.filter((x) => x.type === 'item' && !planned.has(norm(path.dirname(x.path))))) {
    const k = norm(path.dirname(a.path));
    old.set(k, [...(old.get(k) || []), a]);
  }
  for (const acts of old.values()) {
    const users = [...new Set(acts.flatMap((a) => a.harnesses || []))];
    if (!users.length || !users.every((id) => ids.has(id))) continue;
    for (const a of acts) dropItem(a, state);
    console.log(`  fix   ${path.dirname(acts[0].path)}: links removed, ${users.join(', ')} now read the skills elsewhere`);
  }
  // drop deprecated links only when the tool demonstrably reaches the skills another way
  for (const h of hs) {
    for (const l of h.skills?.legacy || []) {
      if (roots.some((r) => r.harnesses.includes(h.id) && !samePath(r.dir, l) && ok.has(norm(r.dir)))) removeLegacyLink(l, state, h.id);
    }
  }
  for (const [h, ds] of dupes) {
    const how = h.skills.dedupe === false ? 'it lists such skills twice' : h.skills.dedupe === 'unverified' ? 'it may list such skills twice' : 'it keeps one copy per skill name';
    console.log(`  note  ${h.id} reads ${ds.length} of these dirs; ${how}`);
  }
  if (hs.some((h) => h.id === 'antigravity')) registerAntigravity(state);
}

// Antigravity reads the skill roots listed in ~/.gemini/config/skills.json, so the links alone are
// not enough. Recorded like every other change, so uninstall takes the entry back out again.
function registerAntigravity(state) {
  const file = H('.gemini', 'config', 'skills.json');
  const entry = posix(p(PACK, 'skills'));
  const had = exists(file);
  let cfg = { entries: [] };
  if (had) {
    try {
      cfg = JSON.parse(readText(file) || '{}') || {};
    } catch {
      return console.log(`  skip  ${file} is not valid JSON - add {"path": "${entry}"} to its entries by hand`);
    }
  }
  if (!Array.isArray(cfg.entries)) cfg.entries = [];
  const already = cfg.entries.some((e) => e && samePath(e.path, entry));
  if (!already) {
    cfg.entries.push({ path: entry });
    if (!DRY) {
      mkdirp(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    }
    console.log(`  ${DRY ? 'would add' : 'gen  '} skills root in ${file} (antigravity)`);
  }
  // also record an entry an earlier run left behind unrecorded - otherwise uninstall walks past it
  record(state, { type: 'json-entry', path: file, entry, harness: 'antigravity', created: !had });
}

// take our entry back out; a file we created and emptied goes away, anything else stays
function removeJsonEntry(a) {
  const t = readText(a.path);
  if (t === null) return;
  let cfg;
  try {
    cfg = JSON.parse(t);
  } catch {
    return; // the user broke or replaced it: never rewrite a file we cannot read
  }
  if (!Array.isArray(cfg?.entries)) return;
  const left = cfg.entries.filter((e) => !(e && samePath(e.path, a.entry)));
  if (left.length === cfg.entries.length || DRY) return;
  if (a.created && !left.length) return fs.rmSync(a.path, { force: true });
  cfg.entries = left;
  fs.writeFileSync(a.path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// One link per skill (or copy, with --copy). Everything else in the folder stays the user's.
function linkItems(r, state) {
  const dirPath = r.dir;
  const label = `${dirPath} (${r.harnesses.join(', ')})`;
  const skillsDir = p(PACK, 'skills');
  // an earlier version linked the whole folder; one link per skill keeps other tools' skills out of the pack
  if (isLink(dirPath) && ours(state, 'link', dirPath) && samePath(linkTarget(dirPath), skillsDir) && !state.actions.some((a) => a.type === 'backup' && samePath(a.path, dirPath))) {
    rmLink(dirPath);
    state.actions = state.actions.filter((a) => !(a.type === 'link' && samePath(a.path, dirPath)));
  }
  const via = throughLink(dirPath);
  if (via && samePath(via.resolved, skillsDir)) return say(true, `  ok    ${label}: reaches the pack via ${via.at}`);
  if (via && (insidePack(via.resolved) || !OPT.force)) return say(false, `  skip  ${label}: ${via.at} is a link to ${via.target}${insidePack(via.resolved) ? '' : ' (--force writes through it)'}`);
  const st = lstat(dirPath);
  if (st && !st.isDirectory() && !st.isSymbolicLink()) return say(false, `  skip  ${label}: exists and is not a folder`);
  mkdirp(dirPath);
  const copy = OPT.copy || (OPT.resync && itemsIn(state, dirPath).some((a) => a.copied));
  const names = enabledSkills();
  const want = new Set(names.map((n) => norm(p(dirPath, n))));
  for (const a of itemsIn(state, dirPath)) if (!want.has(norm(a.path))) dropItem(a, state);
  let added = 0;
  const skipped = [];
  for (const n of names) {
    const res = placeItem(p(skillsDir, n), p(dirPath, n), copy, state, r.harnesses);
    if (res === 'new') added++;
    else if (res !== 'ok') skipped.push(`${n} (${res})`);
  }
  if (skipped.length) console.log(`  skip  ${label}: ${short(skipped)}`);
  return say(true, `  ${added ? (copy ? 'copy' : 'link') : 'ok  '}  ${label}: ${names.length - skipped.length} skills (${added} new)`);
}
const itemsIn = (state, d) => state.actions.filter((a) => a.type === 'item' && samePath(path.dirname(a.path), d));

// returns 'new' | 'ok' | why it was left alone
function placeItem(src, dst, copy, state, harnesses) {
  const rec = recOf(state, 'item', dst);
  const note = (extra) => record(state, { type: 'item', path: dst, target: src, harnesses, ...extra });
  const st = lstat(dst);
  if (st?.isSymbolicLink()) {
    const t = linkTarget(dst);
    if (samePath(t, src) && !copy) {
      note({ copied: false }); // also adopts a link whose run crashed before saving the state
      return 'ok';
    }
    if (!samePath(t, src) && !(rec && (insidePack(t) || !exists(t) || samePath(t, rec.target)))) return 'not the pack\'s';
    rmLink(dst);
  } else if (st) {
    if (!rec?.copied) return 'your own';
    const now = treeHash(dst);
    if (copy && now === treeHash(src)) {
      note({ copied: true, hash: now });
      return 'ok';
    }
    if (!rec.hash || now !== rec.hash) return 'changed since ai-pack copied it'; // recursive delete only when provably ours
    rmTree(dst);
  }
  if (copy) note({ copied: true, hash: copyDir(src, dst) });
  else {
    makeDirLink(src, dst);
    note({ copied: false });
  }
  return 'new';
}
// remove a recorded skill link/copy - only while it is still what the pack made
function dropItem(a, state) {
  const st = lstat(a.path);
  let gone = !st;
  if (st?.isSymbolicLink()) {
    const t = linkTarget(a.path);
    if (samePath(t, a.target) || !exists(t)) gone = rmLink(a.path) || DRY;
  } else if (st && a.copied && a.hash && treeHash(a.path) === a.hash) {
    rmTree(a.path);
    gone = true;
  }
  if (!gone) console.log(`  keep  ${a.path}: changed since ai-pack made it`);
  state.actions = state.actions.filter((x) => x !== a);
}

function removeLegacyLink(l, state, hid) {
  if (!isLink(l) || !samePath(linkTarget(l), p(PACK, 'skills'))) return;
  rmLink(l);
  record(state, { type: 'legacy-unlink', path: l, target: p(PACK, 'skills'), harness: hid });
  console.log(`  fix   removed ${l}: deprecated location that made ${hid} list every skill twice`);
}

// ------------------------------------------------------------------------------------------ frontmatter
// A small YAML subset parser: `key: value` with plain, "double", 'single', [flow] and multi-line
// plain values, block scalars (| >), block lists and nested maps. Enough for SKILL.md / agent files.
function frontmatterSplit(text) {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const open = /^---[ \t]*\n/.exec(t);
  if (!open) return [{}, t];
  const rest = t.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*$/m.exec(rest);
  if (!close) return [{}, t];
  return [parseYamlMap(rest.slice(0, close.index).split('\n')), rest.slice(close.index + close[0].length).replace(/^\n/, '')];
}
function parseYamlMap(lines) {
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const cont = [];
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || !lines[i + 1].trim() || (!m[2] && /^-( |$)/.test(lines[i + 1])))) cont.push(lines[++i]);
    while (cont.length && !cont[cont.length - 1].trim()) cont.pop();
    fm[m[1]] = yamlValue((m[2] || '').trim(), cont);
  }
  return fm;
}
const DQ = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
const plain = (s) => s.replace(/(^|[ \t])#.*$/, '').trim();
function yamlScalar(s) {
  s = s.trim();
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/s.exec(s);
    const raw = m ? m[1] : s.slice(1);
    return raw.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, e) => (e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : DQ[e] ?? e));
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/s.exec(s);
    return (m ? m[1] : s.slice(1)).replace(/''/g, "'");
  }
  return plain(s);
}
function yamlValue(v, cont) {
  const bs = /^([|>])([+-]?)\d*[ \t]*(?:#.*)?$/.exec(v);
  if (bs) {
    const ind = Math.min(...cont.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length));
    const ls = cont.map((l) => (l.trim() ? l.slice(ind) : ''));
    let s = bs[1] === '|' ? ls.join('\n') : '';
    if (bs[1] === '>') {
      for (const l of ls) s += l === '' ? '\n' : s === '' || s.endsWith('\n') ? l : /^\s/.test(l) ? `\n${l}` : ` ${l}`;
    }
    s = s.replace(/\n+$/, '');
    return bs[2] === '-' ? s : `${s}\n`;
  }
  if (!v && cont.length) {
    const items = cont.filter((l) => l.trim());
    if (items.every((l) => /^[ \t]*-( |$)/.test(l))) return items.map((l) => yamlScalar(l.trim().replace(/^-\s*/, '')));
    const ind = /^[ \t]*/.exec(items[0])[0].length;
    return parseYamlMap(cont.map((l) => l.slice(ind)));
  }
  const fold = (xs) => xs.map((l) => l.trim()).reduce((acc, l) => (l === '' ? `${acc}\n` : acc === '' || acc.endsWith('\n') ? acc + l : `${acc} ${l}`), '');
  if (v.startsWith('"') || v.startsWith("'")) return yamlScalar(fold([v, ...cont]));
  if (v.startsWith('[')) {
    const inner = fold([v, ...cont]).replace(/^\[/, '').replace(/\][^\]]*$/, '');
    return (inner.match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) || []).map(yamlScalar).filter((x) => x !== '');
  }
  return fold([v, ...cont].map(plain));
}

// ------------------------------------------------------------------------------------------ agents
const toolList = (fm, key = 'tools') => (Array.isArray(fm[key]) ? fm[key] : String(fm[key] || '').replace(/[[\]"']/g, '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
function readOnly(fm) {
  const t = toolList(fm);
  const off = toolList(fm, 'disallowedTools');
  return (t.length > 0 && !t.some((x) => WRITE_TOOLS.includes(x))) || ['Write', 'Edit'].every((x) => off.includes(x));
}
const noBash = (fm) => (toolList(fm).length > 0 && !toolList(fm).includes('Bash')) || toolList(fm, 'disallowedTools').includes('Bash');
// YAML double-quoted scalar: escape everything a strict YAML 1.1/1.2 parser could stumble over
const yamlStr = (s) => `"${[...String(s ?? '')].map((ch) => {
  const c = ch.codePointAt(0);
  if (ch === '"' || ch === '\\') return `\\${ch}`;
  if (ch === '\n') return '\\n';
  if (ch === '\t') return '\\t';
  if (c >= 0xd800 && c <= 0xdfff) return '\\uFFFD';
  if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || c === 0xfffe || c === 0xffff) return `\\u${c.toString(16).padStart(4, '0')}`;
  return ch;
}).join('')}"`;
// TOML basic string / multi-line literal string (TOML 1.0)
const TOML_ESC = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r', '\b': '\\b', '\f': '\\f' };
const tomlStr = (s) => `"${[...String(s ?? '')].map((ch) => {
  const c = ch.codePointAt(0);
  if (TOML_ESC[ch]) return TOML_ESC[ch];
  if (c >= 0xd800 && c <= 0xdfff) return '\\uFFFD';
  if (c < 0x20 || c === 0x7f) return `\\u${c.toString(16).padStart(4, '0')}`;
  return ch;
}).join('')}"`;
const tomlText = (s) => (/'''|[\x00-\x08\x0b-\x1f\x7f]/.test(s) ? tomlStr(s) : `'''\n${s}'''`);
const yamlList = (xs) => `[${xs.map(yamlStr).join(', ')}]`;
const HEAD = (name) => `<!-- generated by ai-pack from agents/${name}.md - edit that file, then run install again -->\n`;
const RO_NOTE = '**Read-only:** never create, edit or delete files; report findings and proposed fixes instead.\n\n';
const md = (lines, body) => `---\n${lines.filter(Boolean).join('\n')}\n---\n\n${body}`;
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

const CONVERTERS = {
  codex(fm, body, name) {
    const text = [
      `# generated by ai-pack from agents/${name}.md - edit that file, then run install again`,
      `name = ${tomlStr(name)}`,
      `description = ${tomlStr(fm.description)}`,
      readOnly(fm) ? 'sandbox_mode = "read-only"' : '',
      `developer_instructions = ${tomlText(body)}`,
    ].filter(Boolean).join('\n');
    return { file: `${name}.toml`, text: `${text}\n` };
  },
  opencode(fm, body, name) {
    const perm = [readOnly(fm) ? '  edit: deny' : '', noBash(fm) ? '  bash: deny' : ''].filter(Boolean);
    return { file: `${name}.md`, text: md([`description: ${yamlStr(fm.description)}`, 'mode: subagent', perm.length ? `permission:\n${perm.join('\n')}` : ''], HEAD(name) + body) };
  },
  gemini(fm, body, name) {
    const ro = readOnly(fm);
    const tools = ['read_file', 'grep_search', 'glob', 'list_directory', ...(toolList(fm).includes('WebFetch') ? ['web_fetch'] : [])];
    return { file: `${name}.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`, ro ? `tools: ${yamlList(tools)}` : ''], HEAD(name) + (ro ? RO_NOTE : '') + body) };
  },
  copilot(fm, body, name) {
    const tools = toolList(fm).length ? toolList(fm) : readOnly(fm) ? ['read', 'search', 'execute', 'web'] : [];
    return { file: `${name}.agent.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`, tools.length ? `tools: ${yamlList(tools)}` : ''], HEAD(name) + body) };
  },
  cursor(fm, body, name) {
    return { file: `${name}.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`, readOnly(fm) ? 'readonly: true' : ''], HEAD(name) + body) };
  },
  kiro(fm, body, name) {
    return { file: `${name}.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`, readOnly(fm) ? 'tools: ["read"]' : '', 'resources: ["skill://~/.kiro/skills/*/SKILL.md"]'], HEAD(name) + body) };
  },
  droid(fm, body, name) {
    return { file: `${name}.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`, 'model: inherit', readOnly(fm) ? 'tools: read-only' : ''], HEAD(name) + body) };
  },
  augment(fm, body, name) {
    const off = readOnly(fm) ? 'disabled_tools: ["str-replace-editor", "save-file", "remove-files"]' : '';
    return { file: `${name}.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`, off], HEAD(name) + body) };
  },
  goose(fm, body, name) {
    return { file: `${name}.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`], HEAD(name) + (readOnly(fm) ? RO_NOTE : '') + body) };
  },
  commandcode(fm, body, name) {
    // its `tools` field has no read-only preset and its tool ids are undocumented: restrict by instruction
    return { file: `${name}.md`, text: md([`name: ${yamlStr(name)}`, `description: ${yamlStr(fm.description)}`, 'model: inherit'], HEAD(name) + (readOnly(fm) ? RO_NOTE : '') + body) };
  },
};
CONVERTERS.qwen = CONVERTERS.gemini;

// write a file the pack owns: 'written' | 'same' | 'edited' (the user changed it: kept) | 'foreign' (not ours: untouched)
function placeFile(dst, text, type, hid, state) {
  const st = lstat(dst);
  if (st && !st.isFile() && !st.isSymbolicLink()) return 'foreign';
  const prev = readText(dst);
  const rec = recOf(state, type, dst);
  if (prev !== null && prev !== text) {
    if (!rec) return 'foreign';
    if (rec.hash && sha(prev) !== rec.hash) return 'edited';
  }
  if (prev !== text) writeText(dst, text);
  record(state, { type, path: dst, harness: hid, hash: sha(text) });
  return prev === text ? 'same' : 'written';
}
// remove a generated file - only while it is unchanged
function dropFile(a, state) {
  const st = lstat(a.path);
  if (st && (st.isFile() || st.isSymbolicLink())) {
    const cur = readText(a.path);
    if (a.hash && cur !== null && sha(cur) !== a.hash) console.log(`  keep  ${a.path}: you changed it`);
    else if (!DRY) fs.unlinkSync(a.path);
  }
  state.actions = state.actions.filter((x) => x !== a);
}
const dropGenerated = (hid, state) => state.actions.filter((a) => a.type === 'generated' && a.harness === hid).forEach((a) => dropFile(a, state));

function installAgents(h, ctx) {
  const { state } = ctx;
  const a = h.agents;
  if (served(a.servedBy, 'agents', ctx)) {
    dropGenerated(h.id, state);
    return [];
  }
  // --copy (drives without links): the tool's own format, copied like the converted agents below
  const copyMode = a.mode === 'subdir' && (OPT.copy || (OPT.resync && state.actions.some((x) => x.type === 'generated' && x.harness === h.id)));
  if (a.mode === 'subdir' && !copyMode) {
    const target = p(PACK, 'agents');
    const via = throughLink(path.dirname(a.dir));
    if (via && insidePack(via.resolved)) {
      // the tool already reads the pack's agents through a link the user made: that serves tools that
      // read this folder too (Cursor, goose, VS Code read ~/.claude/agents) - don't convert for them
      ctx.provided.agents.add(h.id);
      return [`  ok    agents: already reach the pack via ${via.at}`];
    }
    if (via && !OPT.force) return [`  skip  agents: ${a.dir} lies inside ${via.at}, a link to ${via.target} (--force writes through it)`];
    if (isLink(a.dir)) {
      const t = linkTarget(a.dir);
      if (samePath(t, target)) {
        record(state, { type: 'link', path: a.dir, target, harness: h.id });
        ctx.provided.agents.add(h.id);
        return [`  ok    agents: ${a.dir}`];
      }
      if (!ours(state, 'link', a.dir)) return [`  skip  agents: ${a.dir} links to ${t} (not this pack)`];
      rmLink(a.dir); // ours, but pointing at an old pack location
    } else if (exists(a.dir)) {
      dropGenerated(h.id, state); // copies from an earlier --copy run
      if (!DRY && lstat(a.dir).isDirectory() && !entries(a.dir).length) fs.rmdirSync(a.dir);
      if (exists(a.dir) && !DRY) return [`  skip  agents: ${a.dir} exists and is not the pack's`];
    }
    makeDirLink(target, a.dir);
    record(state, { type: 'link', path: a.dir, target, harness: h.id });
    ctx.provided.agents.add(h.id);
    return [`  link  agents: ${a.dir} -> ${target} (live)`];
  }
  if (copyMode && isLink(a.dir) && ours(state, 'link', a.dir)) {
    rmLink(a.dir);
    state.actions = state.actions.filter((x) => !(x.type === 'link' && samePath(x.path, a.dir)));
  }
  const conv = copyMode ? (fm, body, name, raw) => ({ file: `${name}.md`, text: raw }) : CONVERTERS[a.format];
  if (!conv) return [];
  const out = [];
  if (isLink(a.dir)) {
    const t = linkTarget(a.dir);
    if (insidePack(t)) {
      // a link from this tool's agents dir into the pack's Markdown agents: this tool needs its own
      // format, so the link only hid them (Codex e.g. loads *.toml only). Replace it.
      rmLink(a.dir);
      record(state, { type: 'legacy-unlink', path: a.dir, target: t, harness: h.id });
      out.push(`  fix   removed ${a.dir} -> ${t}: ${h.id} cannot read Claude-format agents`);
    } else if (!OPT.force) return [`  skip  agents: ${a.dir} links to ${t} (not this pack; --force writes through it)`];
  }
  const via = throughLink(path.dirname(a.dir));
  if (via && (insidePack(via.resolved) || !OPT.force)) return [...out, `  skip  agents: ${a.dir} lies inside ${via.at}, a link to ${via.target}`];
  mkdirp(a.dir);
  const want = new Set();
  const skipped = [];
  const kept = [];
  let changed = 0;
  for (const f of enabledAgents()) {
    const name = f.replace(/\.md$/, '');
    if (!AGENT_NAME.test(name)) {
      skipped.push(`${name} (name must be lowercase letters, digits, - or _)`);
      continue;
    }
    const raw = fs.readFileSync(p(PACK, 'agents', f), 'utf8');
    const [fm, body] = frontmatterSplit(raw);
    const res = conv(fm, body, name, raw);
    const dst = p(a.dir, res.file);
    const r = placeFile(dst, res.text, 'generated', h.id, state);
    if (r === 'foreign') {
      skipped.push(`${name} (your own file has that name)`);
      continue;
    }
    want.add(norm(dst));
    if (r === 'written') changed++;
    if (r === 'edited') kept.push(name);
  }
  for (const x of state.actions.filter((y) => y.type === 'generated' && y.harness === h.id && !want.has(norm(y.path)))) dropFile(x, state);
  ctx.provided.agents.add(h.id);
  out.push(`  ${changed ? 'gen ' : 'ok  '}  agents: ${want.size} ${copyMode ? 'copied' : `converted (${a.format}`}, ${changed} changed${copyMode ? '' : ')'} in ${a.dir}`);
  if (kept.length) out.push(`  keep  agents you edited (delete them to regenerate): ${short(kept)}`);
  if (skipped.length) out.push(`  skip  agents: ${short(skipped)}`);
  return out;
}

// ------------------------------------------------------------------------------------------ rules
const block = (body) => `${BEGIN}\n${body.trim()}\n${END}`;
// [start, end] of every managed block; null when a marker is missing (then we do not touch the file)
function findBlocks(t) {
  const out = [];
  for (let i = 0; ;) {
    const b = t.indexOf(BEGIN_TAG, i);
    const e = t.indexOf(END, i);
    if (b < 0) return e < 0 ? out : null;
    if (e < b) return null;
    const nb = t.indexOf(BEGIN_TAG, b + 1);
    if (nb >= 0 && nb < e) return null;
    out.push([b, e + END.length]);
    i = e + END.length;
  }
}
// cut one block out, restoring the text around it the way withBlock() added it
function removeAt(t, s, e) {
  const before = t.slice(0, s);
  const after = t.slice(e).replace(/^\r?\n/, '');
  if (!after.trim()) return before.trim() ? before.replace(/(\r?\n)\r?\n$/, '$1') : '';
  if (!before.trim()) return after.replace(/^(\r?\n)+/, '');
  return /^\r?\n/.test(after) ? before.replace(/(\r?\n)(?:\r?\n)+$/, '$1') + after : before + after;
}
const withoutBlocks = (t) => (findBlocks(t) || []).reduceRight((acc, [s, e]) => removeAt(acc, s, e), t);
function withBlock(prev, blk) {
  const eol = prev.includes('\r\n') ? '\r\n' : '\n';
  const text = blk.replace(/\n/g, eol);
  const found = findBlocks(prev);
  if (found === null) return null;
  if (!found.length) return prev.trim() ? `${prev}${prev.endsWith('\n') ? '' : eol}${eol}${text}${eol}` : `${text}${eol}`;
  let next = prev;
  for (const [s, e] of found.slice(1).reverse()) next = removeAt(next, s, e); // duplicates from hand edits
  return next.slice(0, found[0][0]) + text + next.slice(found[0][1]);
}
function removeBlock(file, created) {
  const prev = readText(file);
  if (prev === null) return;
  const found = findBlocks(prev);
  if (found === null) return void console.log(`  warn  ${file}: the ai-pack block is damaged (a marker is missing) - remove it by hand`);
  const next = withoutBlocks(prev);
  if (next === prev) return;
  if (!next.trim() && created) {
    if (!DRY) fs.unlinkSync(file);
  } else writeText(file, next);
}
function backupOnce(file, hid, state) {
  if (!exists(file) || ours(state, 'file-backup', file) || DRY) return;
  let bak = p(STATE_DIR, 'backups', STAMP, `${hid}-${path.basename(file)}`);
  for (let i = 2; exists(bak); i++) bak = p(STATE_DIR, 'backups', STAMP, `${hid}-${i}-${path.basename(file)}`); // never overwrite a backup
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
  record(state, { type: 'file-backup', path: file, backup: bak, harness: hid });
}
// remove this tool's rules from every place but `keep` (the target changed, or another tool serves it now)
function dropRules(hid, state, keep) {
  for (const a of state.actions.filter((x) => x.harness === hid && KIND.rules.includes(x.type) && !samePath(x.path, keep))) {
    if (a.type === 'block') {
      removeBlock(a.path, a.created);
      state.actions = state.actions.filter((x) => x !== a);
    } else dropFile(a, state);
    console.log(`  fix   rules removed from ${a.path}: ${hid} gets them another way now`);
  }
}

function installRules(h, ctx) {
  const { state } = ctx;
  let r = h.rules;
  if (r.onlyWith && !served([r.onlyWith], 'rules', ctx)) r = r.otherwise;
  if (served(r.servedBy, 'rules', ctx) || r.mode === 'manual') {
    dropRules(h.id, state, null);
    return r.mode === 'manual' ? [`  todo  rules: ${r.note}`] : [];
  }
  const done = (lines) => {
    ctx.provided.rules.add(h.id);
    dropRules(h.id, state, r.file);
    return r.note ? [...lines, `  note  ${r.note}`] : lines; // e.g. a second location the tool also reads
  };
  const via = throughLink(path.dirname(r.file));
  if (via && insidePack(via.resolved)) return done([`  ok    rules: already reach the pack via ${via.at}`]);
  if (via && !OPT.force) return [`  skip  rules: ${r.file} lies inside ${via.at}, a link to ${via.target} (--force writes through it)`];
  if (isLink(r.file) && insidePack(realOr(r.file))) return done([`  ok    rules: ${r.file} links into the pack`]);
  const full = readText(RULES);
  if (full === null) return [`  skip  rules: ${RULES} missing`];
  const notes = [];
  if (r.shadowedBy && exists(r.shadowedBy)) notes.push(`  note  ${h.id} reads ${r.shadowedBy} instead of ${r.file} while that file exists`);
  if (r.replaces && !exists(r.file) && exists(r.replaces)) notes.push(`  note  ${h.id} stops falling back to ${r.replaces} once ${r.file} exists`);
  if (r.mode === 'file') {
    const res = placeFile(r.file, (r.header || '') + full, 'rules-file', h.id, state);
    if (res === 'foreign') return [...notes, `  skip  rules: ${r.file} exists and is not the pack's`];
    if (res === 'edited') return done([...notes, `  keep  rules: ${r.file} (you changed it; delete it to get the pack's version)`]);
    return done([...notes, `  ${res === 'written' ? 'copy' : 'ok  '}  rules -> ${r.file}`]);
  }
  const min = readText(RULES_MIN);
  let body = r.mode === 'inline-min' ? min : full;
  if (r.mode === 'import') {
    // @imports end at the first space (Gemini, Qwen, goose, Amp): such a path gets the text inline
    if (/\s/.test(posix(RULES))) notes.push(`  note  rules inlined: ${h.id} cannot @import a path with spaces (install again after edits)`);
    else body = `@${posix(RULES)}`;
  }
  if (body === null) return [...notes, `  skip  rules: no condensed rules file (${RULES_MIN})`];
  const prev = readText(r.file);
  const limit = r.maxBytes ? `${r.maxBytes} bytes` : `${r.maxChars} characters`;
  const tooBig = (t) => (r.maxBytes && Buffer.byteLength(t) > r.maxBytes) || (r.maxChars && [...t].length > r.maxChars);
  let next = withBlock(prev ?? '', block(body));
  if (next === null) return [...notes, `  skip  rules: ${r.file} has a damaged ai-pack block (a begin or end marker is missing) - fix it by hand`];
  if (tooBig(next) && r.fallback === 'min' && min !== null) {
    next = withBlock(prev ?? '', block(min));
    notes.push(`  note  ${r.file}: the full rules would pass ${limit} - using the condensed rules`);
  }
  if (tooBig(next)) return [...notes, `  skip  rules: ${r.file} would exceed ${limit} - shorten it, or add the rules by hand`];
  if (next !== prev) {
    backupOnce(r.file, h.id, state);
    writeText(r.file, next);
  }
  // created: uninstall may delete the file. Also true for an unrecorded file that holds nothing but our
  // block - a run that crashed before saving its state created it.
  const old = recOf(state, 'block', r.file);
  const created = old ? Boolean(old.created) : prev === null || (Boolean(findBlocks(prev)?.length) && !withoutBlocks(prev).trim());
  record(state, { type: 'block', path: r.file, harness: h.id, created });
  return done([...notes, `  ${next !== prev ? 'rules' : 'ok   '} ${r.mode} block in ${r.file}`]);
}

// ------------------------------------------------------------------------------------------ git
// a test home gets its own git config: never read or write the real one from a test
const gitEnv = () => (TEST_HOME
  ? { ...process.env, HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: H('.config'), GIT_CONFIG_GLOBAL: H('.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  : process.env);
const git = (args) => spawnSync('git', args, { encoding: 'utf8', env: gitEnv() });
// a git call whose failure must not pass silently (e.g. ~/.gitconfig locked or read-only)
function gitOk(r, what, okStatus = [0]) {
  if (r.error) throw new Error(`git could not ${what}: ${r.error.code || r.error.message} - is git installed?`);
  if (!okStatus.includes(r.status)) throw new Error(`git could not ${what} (exit ${r.status}): ${(r.stderr || '').trim()}`);
  return r;
}
const tilde = (x) => x.replace(/^~(?=$|[\\/])/, TEST_HOME ? HOME : os.homedir());
function installHooks(state) {
  const hooksDir = p(PACK, 'hooks');
  if (!exists(hooksDir)) return void console.log('git hooks: the pack has no hooks/ folder');
  const r = git(['config', '--global', '--get', 'core.hooksPath']);
  if (r.error) return void console.log('git hooks: git not found - skipped');
  const cur = (r.stdout || '').trim();
  const hooks = posix(hooksDir);
  const mine = Boolean(cur) && samePath(tilde(cur), hooksDir);
  if (cur && !mine && !OPT.force) return void console.log(`git hooks: core.hooksPath is already ${cur} - not changed (--force replaces it)`);
  if (!WIN && !DRY) for (const f of fs.readdirSync(hooksDir)) fs.chmodSync(p(hooksDir, f), 0o755);
  if (!mine && !DRY) gitOk(git(['config', '--global', 'core.hooksPath', hooks]), 'set core.hooksPath'); // throws: nothing recorded
  // keep the value from before the FIRST install: a re-run must not record our own path as "previous"
  if (!mine || !ours(state, 'hooks', 'core.hooksPath')) record(state, { type: 'hooks', path: 'core.hooksPath', hooks, previous: mine ? null : cur || null });
  console.log(`git hooks: core.hooksPath -> ${hooks}`);
}

// ------------------------------------------------------------------------------------------ uninstall
const log = (verb, x) => console.log(`${verb.padEnd(8)} ${x}`);
function restoreBackup(a) {
  // from an earlier version that moved the user's folder aside and adopted its items into the pack
  if (!exists(a.path) && exists(a.backup) && !DRY) renameRetry(a.backup, a.path);
  for (const x of a.adopted || []) {
    if (!insidePack(x) || !exists(x)) continue;
    const orig = [p(a.path, path.basename(x)), p(a.backup, path.basename(x))].find(exists);
    const h = treeHash(x);
    if (orig && h && h === treeHash(orig)) rmTree(x);
    else log('keep', `${x}: changed after install - the version from before is in ${a.path}`);
  }
}
function undo(a, state) {
  if (a.type === 'item') {
    dropItem(a, state);
    log('unlink', a.path);
  } else if (a.type === 'link') {
    const t = linkTarget(a.path);
    if (isLink(a.path) && (samePath(t, a.target) || !exists(t))) rmLink(a.path);
    log('unlink', a.path);
  } else if (a.type === 'backup') {
    restoreBackup(a);
    log('restore', a.path);
  } else if (a.type === 'generated' || a.type === 'rules-file') {
    dropFile(a, state);
    log('remove', a.path);
  } else if (a.type === 'block') {
    removeBlock(a.path, a.created);
    log('clean', a.path);
  } else if (a.type === 'json-entry') {
    removeJsonEntry(a);
    log(a.created ? 'remove' : 'clean', a.path);
  } else if (a.type === 'legacy-unlink') {
    log('keep', `${a.path} stays removed (it only duplicated skills/agents)`);
  } else if (a.type === 'hooks') {
    const got = git(['config', '--global', '--get', 'core.hooksPath']);
    if (got.error) return log('keep', `git core.hooksPath: git not found (${got.error.code}) - check core.hooksPath in ~/.gitconfig by hand`);
    // exit 1 = not set; anything else (e.g. an unreadable config) must not look like "nothing to undo"
    const cur = (gitOk(got, 'read core.hooksPath', [0, 1]).stdout || '').trim();
    if (cur && !samePath(tilde(cur), a.hooks || p(PACK, 'hooks'))) return log('keep', `git core.hooksPath (${cur}: changed since install)`);
    // a failure throws: uninstall keeps this step in the state and asks to run it again
    if (!DRY && a.previous) gitOk(git(['config', '--global', 'core.hooksPath', a.previous]), 'restore core.hooksPath');
    else if (!DRY) gitOk(git(['config', '--global', '--unset', 'core.hooksPath']), 'unset core.hooksPath', [0, 5]); // 5: already unset
    log('restore', `git core.hooksPath${a.previous ? ` -> ${a.previous}` : ' (unset)'}`);
  }
}
async function uninstall() {
  const state = loadState();
  if (!state.actions.length) return void console.log('nothing to uninstall');
  const failed = [];
  for (const a of [...state.actions].reverse()) {
    if (a.type === 'dir' || a.type === 'file-backup') continue;
    try {
      undo(a, state);
    } catch (e) {
      failed.push(a);
      console.log(`  warn  ${a.path}: ${e.message}`);
    }
  }
  // last: folders install created, deepest first, only if they are empty now
  const dirs = state.actions.filter((a) => a.type === 'dir');
  for (const d of dirs.map((a) => a.path).sort((a, b) => b.length - a.length)) {
    try {
      if (!DRY && !isLink(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    } catch {}
  }
  if (failed.length) {
    state.actions = [...failed, ...dirs];
    saveState(state);
    throw new Error(`${failed.length} step(s) failed (see above) - fix the cause and run uninstall again`);
  }
  if (!DRY) for (const f of [STATE_FILE, `${STATE_FILE}.bak`]) fs.rmSync(f, { force: true });
  console.log(`\n${DRY ? '[dry-run] ' : ''}uninstalled. Copies of edited instruction files stay in ${p(STATE_DIR, 'backups')}.`);
}

// ------------------------------------------------------------------------------------------ status / list / doctor / table
async function status() {
  const state = loadState();
  const c = tryCatalog();
  if (c) {
    const local = loadLocal();
    const on = (k) => c.items.filter((i) => i.kind === k && i.now === 'on').length;
    const all = (k) => c.items.filter((i) => i.kind === k).length;
    const own = [...local.enabled.map((x) => `+${x}`), ...local.disabled.map((x) => `-${x}`)];
    console.log(`ai-pack ${c.version} at ${PACK}\nskills on ${on('skill')}/${all('skill')}, agents on ${on('agent')}/${all('agent')}`);
    console.log(`tags: ${tagLabel(local.tags)}${own.length ? `\nyour own per-item choices: ${short(own, 10)}` : ''}\n`);
  } else console.log(`pack at ${PACK}\n`);
  const con = new Set(connectedIds(state));
  for (const h of HARNESSES) {
    const st = con.has(h.id) ? 'connected' : detected(h) ? 'detected' : 'not found';
    console.log(`${h.id.padEnd(15)} ${st.padEnd(10)} ${h.name}`);
  }
}

// `list` = every item with state and tags; `list <tag..>` = only items with one of these tags
async function list(xs) {
  const c = catalog();
  const want = tagWords(xs);
  const bad = want.filter((w) => !knownTags(c).includes(w));
  if (bad.length) throw new Error(`unknown tag(s): ${bad.join(', ')} - see \`node install.mjs tags\``);
  const items = c.items.filter((i) => !want.length || (i.tags || []).some((t) => want.includes(t)));
  for (const i of items.sort((a, b) => `${a.kind}${a.area}${a.name}`.localeCompare(`${b.kind}${b.area}${b.name}`))) {
    console.log(`${i.now === 'on' ? '[on] ' : i.now === 'off' ? '[off]' : '[?]  '} ${i.kind.padEnd(5)} ${String(i.area || '').padEnd(20)} ${i.name.padEnd(34)} ${(i.tags || []).join(' ')}`);
  }
  console.log(`\n${items.length} item(s). Tags: node install.mjs tags · one item: node install.mjs enable <name>`);
}

async function doctor() {
  let problems = 0;
  const check = (ok, msg) => {
    if (!ok) problems++;
    console.log(`${ok ? 'ok  ' : 'FIX '} ${msg}`);
  };
  check(NODE_MAJOR >= 18, `Node ${process.versions.node}`);
  check(TEST_HOME || which('git'), 'git on PATH (needed for update)');
  const state = loadState();
  const skillsDir = p(PACK, 'skills');
  const names = enabledSkills();
  for (const a of state.actions.filter((x) => x.type === 'link')) check(isLink(a.path) && samePath(linkTarget(a.path), a.target), `${a.path} -> ${a.target}`);
  const byDir = new Map();
  for (const a of state.actions.filter((x) => x.type === 'item')) byDir.set(norm(path.dirname(a.path)), [...(byDir.get(norm(path.dirname(a.path))) || []), a]);
  for (const acts of byDir.values()) {
    const d = path.dirname(acts[0].path);
    const bad = acts.filter((a) => !(a.copied ? exists(p(a.path, 'SKILL.md')) : isLink(a.path) && samePath(linkTarget(a.path), a.target) && exists(p(a.target, 'SKILL.md'))));
    const missing = names.filter((n) => !exists(p(d, n)));
    const extra = [bad.length ? `${bad.length} broken or disabled (${short(bad.map((a) => path.basename(a.path)))})` : '', missing.length ? `${missing.length} not linked yet (${short(missing)})` : ''].filter(Boolean);
    check(!extra.length, `${d}: ${acts.length} skills${extra.length ? `, ${extra.join(', ')} - run install again` : ''}`);
  }
  const lost = state.actions.filter((a) => (a.type === 'generated' || a.type === 'rules-file') && !exists(a.path));
  if (lost.length) check(false, `${lost.length} generated file(s) missing (${short(lost.map((a) => a.path), 3)}) - run install again`);
  // duplicates: a detected tool that reaches the pack's skills through two dirs
  const reaches = (d) => (isLink(d) && samePath(linkTarget(d), skillsDir)) || entries(d).some((e) => isLink(p(d, e)) && inside(linkTarget(p(d, e)) || '', skillsDir));
  for (const h of HARNESSES.filter((x) => x.skills && detected(x))) {
    const hits = h.skills.reads.filter(reaches);
    if (hits.length < 2) continue;
    if (h.skills.dedupe === false) check(false, `${h.id} lists each skill twice: it reads ${hits.join(' + ')} - remove the pack's links from all but one`);
    else console.log(`note ${h.id} reaches the skills via ${hits.join(' + ')} (${h.skills.dedupe === 'unverified' ? 'it may list them twice' : 'it keeps one per name'})`);
  }
  let chars = 0;
  for (const s of names) {
    const [fm] = frontmatterSplit(readText(p(skillsDir, s, 'SKILL.md')) || '');
    chars += s.length + 2 + String(fm.description || '').length;
  }
  // Codex budgets the catalogue at 2% of the context window, 10,000 tokens at most
  check(chars < 24000, `enabled skill list ~${Math.round(chars / 4)} tokens for ${names.length} skills (Codex shortens past 2% of its context: pick only your tags - node install.mjs tags)`);
  if (loadLocal().updating) check(false, 'an update was interrupted - run `node install.mjs update` again');
  console.log(problems ? `\n${problems} problem(s).` : '\nall good.');
  if (problems) process.exitCode = 1;
}

// markdown table of the registry for the README (used by the pack build)
async function table() {
  const rel = (x) => (x ? posix(x).replace(posix(HOME), '~') : '—');
  const names = (ids) => ids.map((id) => harness(id).name.split(' (')[0]).join(' / ');
  const only = (x) => (x?.servedBy ? `, only without ${names(x.servedBy)}` : '');
  const skillsOf = (h) => (!h.skills ? '—' : h.skills.reads.includes(AGENTS_SKILLS) ? '`~/.agents/skills`' : `\`${rel(h.skills.reads[0])}\``);
  const agentsOf = (h) => (!h.agents ? '—' : h.agents.mode === 'subdir' ? `\`${rel(h.agents.dir)}\` (live link)` : `\`${rel(h.agents.dir)}\` (converted${only(h.agents)})`);
  const rulesOf = (h) => {
    const r = h.rules;
    if (!r) return '—';
    if (r.mode === 'manual') return 'manual step';
    if (r.onlyWith) return `\`${rel(r.file)}\` (without ${names([r.onlyWith])}: \`${rel(r.otherwise.file)}\`)`;
    return `\`${rel(r.file)}\`${r.servedBy ? ` (${only(r).slice(2)})` : ''}`;
  };
  console.log('| Tool | Skills | Agents | Rules |\n|---|---|---|---|');
  for (const h of HARNESSES) console.log(`| ${h.name} | ${skillsOf(h)} | ${agentsOf(h)} | ${rulesOf(h)} |`);
}

// ------------------------------------------------------------------------------------------ tags / enable / disable
// Every item in catalog.json has tags. The user picks tags (first install, `tags`, `enable <tag>`,
// `--tags`) and every item without one of them moves to skills-disabled/ or agents-disabled/.
// `core` is always on. A per-item choice (`enable <name>`, `disable <name>`, or a hand move that a
// later `tags` / `update` finds in the folders) beats the tags until it matches them again.
const tryCatalog = () => (exists(p(PACK, 'catalog.json')) ? catalog() : null);
const knownTags = (c) => [...new Set(Object.values(c.tag_groups || {}).flat())];
const tagWords = (xs) => xs.flatMap((s) => String(s).split(/[\s,]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);
// what the tag choice alone says (no per-item choices)
function tagDefault(it, sel) {
  if (sel === undefined) return it.enabled === false ? 'off' : 'on'; // nothing chosen yet: as shipped
  const tags = it.tags || [];
  if (sel === 'all' || !tags.length || tags.includes('core')) return 'on';
  return tags.some((t) => sel.includes(t)) ? 'on' : 'off';
}
const wantOf = (it, local) => (local.enabled.includes(it.name) ? 'on' : local.disabled.includes(it.name) ? 'off' : tagDefault(it, local.tags));
const tagLabel = (sel) => (sel === undefined ? 'not chosen yet (everything on, as shipped)' : sel === 'all' ? 'all' : sel.length ? sel.join(', ') : '(only core)');
// "js,ts react" = exactly these · "+java -vue" = change the current choice · presets (recommended, all) expand
function parseTags(xs, current, c) {
  const known = knownTags(c);
  const presets = c.presets || {};
  const ws = tagWords(xs);
  if (!ws.length) throw new Error('no tags given - see `node install.mjs tags`');
  const expand = (w) => (w === 'all' ? known : presets[w] || (known.includes(w) ? [w] : null));
  const bad = ws.filter((w) => !expand(w.replace(/^[+-]/, '')));
  if (bad.length) throw new Error(`unknown tag(s): ${bad.join(', ')}\n  tags: ${known.join(', ')}\n  presets: all, ${Object.keys(presets).join(', ')}`);
  if (ws.includes('-core')) throw new Error('core is always on - turn single items off by name: node install.mjs disable <name>');
  const abs = ws.filter((w) => !/^[+-]/.test(w));
  const everything = current === undefined || current === 'all';
  let all = abs.includes('all') || (!abs.length && everything);
  const sel = new Set(abs.length ? abs.flatMap(expand) : everything ? known : current);
  for (const w of ws.filter((x) => /^[+-]/.test(x))) {
    const ts = expand(w.slice(1));
    if (w[0] === '+') {
      if (w === '+all') all = true;
      for (const t of ts) sel.add(t);
    } else {
      all = false;
      for (const t of ts) sel.delete(t);
    }
  }
  sel.delete('core');
  return all ? 'all' : known.filter((t) => sel.has(t));
}
// move one item between skills/ and skills-disabled/ (agents/ and agents-disabled/); never overwrites
function moveItem(it, to) {
  const [from, dst] = to === 'on' ? [it.off, it.on] : [it.on, it.off];
  if (exists(dst)) throw new Error(`both ${from} and ${dst} exist - keep one of them, then try again`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  renameRetry(from, dst);
}
// the folders are the truth: an item that is not where the tags put it was moved by the user - keep
// that as their choice; one that is back where the tags put it follows the tags again
function reconcile(local, items) {
  for (const it of items.filter((i) => i.now !== 'missing')) {
    local.enabled = local.enabled.filter((n) => n !== it.name);
    local.disabled = local.disabled.filter((n) => n !== it.name);
    if (it.now !== tagDefault(it, local.tags)) (it.now === 'on' ? local.enabled : local.disabled).push(it.name);
  }
}
// move every item to where the tags and per-item choices want it; returns { on, off, failed }
function applySelection(local, c) {
  const res = { on: [], off: [], failed: 0 };
  for (const it of c.items) {
    const to = wantOf(it, local);
    if (it.now === 'missing' || it.now === to) continue;
    try {
      moveItem(it, to);
      res[to].push(it.name);
    } catch (e) {
      res.failed++;
      console.log(`  warn  ${it.name}: ${e.message}`);
    }
  }
  return res;
}
// set a new tag choice: keep hand moves as per-item choices, move the rest, save, report
function selectTags(c, local, next) {
  if (local.updating) throw new Error('an update was interrupted - run `node install.mjs update` first');
  // with an earlier choice, anything not where it put things was moved by hand: keep it. The first
  // choice (or one after a damaged .ai-pack-local.json) has no such baseline and decides alone.
  if (local.tags !== undefined) reconcile(local, c.items);
  local.tags = next;
  const r = applySelection(local, c);
  saveLocal(local);
  const n = (k) => c.items.filter((i) => i.kind === k && wantOf(i, local) === 'on').length;
  console.log(`${DRY ? '[dry-run] ' : ''}tags: ${tagLabel(next)}`);
  console.log(`  ${n('skill')}/${c.items.filter((i) => i.kind === 'skill').length} skills and ${n('agent')}/${c.items.filter((i) => i.kind === 'agent').length} agents on`
    + `${r.off.length ? ` · ${DRY ? 'would move' : 'moved'} ${r.off.length} to *-disabled/ (${short(r.off)})` : ''}`
    + `${r.on.length ? ` · ${r.on.length} back on (${short(r.on)})` : ''}`);
  const own = [...local.enabled.map((x) => `+${x}`), ...local.disabled.map((x) => `-${x}`)];
  if (own.length) console.log(`  your own per-item choices beat the tags: ${short(own, 10)}`);
  if (r.failed) process.exitCode = 1;
  return r;
}
// first install: ask once (Enter = recommended); --tags answers it without a question
async function chooseTags() {
  const c = tryCatalog();
  if (!c?.tag_groups) {
    // a folder without catalog.json (e.g. --root <own folder>): the folders are the whole truth
    if (ARGS.tags) throw new Error(`--tags needs the pack's catalog.json, which ${PACK} does not have`);
    return;
  }
  const local = loadLocal();
  if (ARGS.tags) return void selectTags(c, local, parseTags([ARGS.tags], local.tags, c));
  if (local.tags !== undefined) return;
  // AI_PACK_ASK=1 asks on piped input too (scripts, tests)
  const interactive = process.env.AI_PACK_ASK === '1' || (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
  if (DRY || !interactive) {
    console.log(`note  no tags chosen - everything stays on. Choose any time: node install.mjs tags recommended  (or: tags ts,react,postgres,github ...)\n`);
    return;
  }
  selectTags(c, local, await promptTags(c));
  console.log('');
}
async function promptTags(c) {
  const count = (t) => c.items.filter((i) => (i.tags || []).includes(t)).length;
  const onFor = (sel) => {
    const on = c.items.filter((i) => tagDefault(i, sel) === 'on');
    return `${on.filter((i) => i.kind === 'skill').length} skills + ${on.filter((i) => i.kind === 'agent').length} agents`;
  };
  const rec = c.presets?.recommended;
  const groups = Object.entries(c.tag_groups).filter(([, ts]) => !(ts.length === 1 && ts[0] === 'core'));
  console.log(`Which tags do you work with? Skills and agents without one of them go to skills-disabled/ and
agents-disabled/ (nothing is deleted; change it any time: node install.mjs tags ...).
core (${count('core')} items: planning, debugging, reviews, shipping) is always on.

${groups.map(([g, ts]) => `  ${g.padEnd(10)} ${ts.map((t) => `${t}(${count(t)})`).join(' ')}`).join('\n')}

  Enter      ${rec ? `recommended - ${rec.join(', ')} (${onFor(rec)})` : `everything (${onFor('all')})`}
  all        everything (${onFor('all')})
  a list     e.g.  ts,react,next,postgres,github   or   recommended +java -python
`);
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    console.log('\ncancelled - nothing changed.');
    process.exit(130);
  });
  // lines are queued: piped input can deliver several answers before the next question is asked
  const lines = [];
  let waiting = null;
  let closed = false;
  const noAnswer = () => new Error('no answer (input closed) - nothing changed; choose later: node install.mjs tags ...');
  rl.on('line', (l) => (waiting ? (waiting.resolve(l), (waiting = null)) : lines.push(l)));
  rl.on('close', () => {
    closed = true;
    waiting?.reject(noAnswer());
    waiting = null;
  });
  const ask = (q) => {
    rl.setPrompt(q);
    rl.prompt();
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.reject(noAnswer());
    return new Promise((resolve, reject) => (waiting = { resolve, reject }));
  };
  try {
    for (;;) {
      const a = (await ask('tags> ')).trim() || (rec ? 'recommended' : 'all');
      try {
        return parseTags([a], undefined, c);
      } catch (e) {
        console.log(e.message);
      }
    }
  } finally {
    rl.close();
  }
}
// `tags` shows the choice; `tags <list|+x -y|recommended|all>` changes it
async function tags(xs) {
  const c = catalog();
  const local = loadLocal();
  if (!xs.length) {
    const on = (t) => local.tags === 'all' || local.tags === undefined || t === 'core' || local.tags.includes(t);
    const count = (t) => c.items.filter((i) => (i.tags || []).includes(t)).length;
    console.log(`tags: ${tagLabel(local.tags)}\n`);
    for (const [g, ts] of Object.entries(c.tag_groups || {})) console.log(`  ${g.padEnd(10)} ${ts.map((t) => `${on(t) ? '*' : ' '}${t}(${count(t)})`).join(' ')}`);
    const own = [...local.enabled.map((x) => `+${x}`), ...local.disabled.map((x) => `-${x}`)];
    console.log(`\n  * = on${own.length ? `\n  your own per-item choices: ${own.join(' ')}` : ''}
  presets: all, ${Object.keys(c.presets || {}).join(', ')}
change: node install.mjs tags ts,react,postgres   ·   tags +java -vue   ·   tags recommended   ·   tags all`);
    return;
  }
  selectTags(c, local, parseTags(xs, local.tags, c));
  await resync();
}
// enable/disable take tags (added to / removed from the choice) and item names (a per-item choice)
function splitArgs(xs, c) {
  const known = knownTags(c);
  const tagsOut = [];
  const items = [];
  for (const w of tagWords(xs)) {
    const m = /^(skill|agent):(.+)$/.exec(w);
    const byName = m ? c.items.filter((i) => i.kind === m[1] && i.name === m[2]) : c.items.filter((i) => i.name === w);
    if (!m && (w === 'all' || known.includes(w) || c.presets?.[w])) tagsOut.push(w); // a tag wins over an item of the same name (skill:<name> for the item)
    else if (byName.length) items.push(...byName);
    else throw new Error(`unknown tag or item "${w}" - see \`node install.mjs tags\` and \`node install.mjs list\``);
  }
  return { tags: tagsOut, items };
}
function move(items, to) {
  const local = loadLocal();
  let failed = 0;
  for (const it of items) {
    if (it.now === 'missing') {
      console.log(`missing  ${it.kind} ${it.name}: neither in ${path.dirname(it.on)} nor ${path.dirname(it.off)}`);
      continue;
    }
    if (it.now !== to) {
      try {
        moveItem(it, to);
      } catch (e) {
        failed++;
        console.log(`conflict ${it.kind} ${it.name}: ${e.message}`);
        continue;
      }
    }
    local.enabled = local.enabled.filter((n) => n !== it.name);
    local.disabled = local.disabled.filter((n) => n !== it.name);
    if (to !== tagDefault(it, local.tags)) (to === 'on' ? local.enabled : local.disabled).push(it.name);
    console.log(`${it.now === to ? `already ${to === 'on' ? 'on ' : 'off'}` : to === 'on' ? 'enabled ' : 'disabled'} ${it.kind} ${it.name}`);
  }
  saveLocal(local);
  if (failed) process.exitCode = 1;
}
async function toggle(xs, to) {
  if (!xs.length) throw new Error(`usage: node install.mjs ${to === 'on' ? 'enable' : 'disable'} <tag|name> ...`);
  let c = catalog();
  const { tags: ts, items } = splitArgs(xs, c);
  if (ts.length) {
    const local = loadLocal();
    selectTags(c, local, parseTags(ts.map((t) => (to === 'on' ? '+' : '-') + t), local.tags, c));
    c = catalog(); // folders changed
  }
  if (items.length) move(items.map((it) => c.items.find((i) => i.kind === it.kind && i.name === it.name)), to);
  await resync();
}
const enable = (xs) => toggle(xs, 'on');
const disable = (xs) => toggle(xs, 'off');
// refresh the tools connected so far: same tools, same kinds (skills/agents/rules), same link/copy mode
async function resync() {
  const state = loadState();
  const ids = connectedIds(state);
  if (!ids.length) return void console.log('\nno tool connected yet - run `node install.mjs` to connect them');
  Object.assign(OPT, { resync: true, only: ids, skip: [], all: false });
  console.log('\nre-syncing connected tools...');
  await install();
}

// ------------------------------------------------------------------------------------------ update
async function update() {
  if (!exists(p(PACK, '.git'))) throw new Error('this folder is not a git clone - download the new version instead');
  const c = catalog();
  const local = loadLocal();
  if (!local.updating) reconcile(local, c.items); // after an interrupted update the folders are half-moved: trust the file
  local.updating = true;
  saveLocal(local);
  let r = null;
  let res = { failed: 1 };
  try {
    // 1. put every moved tracked item back where git has it (as shipped)
    for (const it of c.items) {
      const shipped = it.enabled === false ? 'off' : 'on';
      if (it.now !== 'missing' && it.now !== shipped) moveItem(it, shipped);
    }
    // 2. pull (mode bits from `--with-git-hooks` are not local changes)
    r = DRY ? { status: 0, stdout: '(dry-run: git pull --ff-only)' } : git(['-C', PACK, '-c', 'core.fileMode=false', 'pull', '--ff-only']);
    console.log(((r.stdout || '') + (r.stderr || '')).trim());
  } finally {
    // 3. re-apply tags and per-item choices to the new catalog (new items follow the tags) - also when a step above failed
    try {
      const nc = catalog();
      res = applySelection(local, nc);
      const fresh = knownTags(nc).filter((t) => !knownTags(c).includes(t));
      if (fresh.length && Array.isArray(local.tags)) console.log(`new tags: ${fresh.join(', ')} - add with: node install.mjs tags +${fresh.join(' +')}`);
    } catch (e) {
      console.log(`  warn  ${e.message}`);
    }
    if (!res.failed) delete local.updating;
    saveLocal(local);
  }
  if (r.error) throw new Error(`git failed to start (${r.error.code}) - is git installed? Your tags and choices are unchanged.`);
  if (r.status !== 0) throw new Error('git pull failed - your tags and choices were re-applied; resolve it, then run update again');
  await resync();
}

// ------------------------------------------------------------------------------------------ zip (claude.ai / ChatGPT upload)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
// claude.ai rejects Claude-Code-only frontmatter keys: keep the Agent Skills spec fields only
const SPEC_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
function sanitizeSkillMd(text, name) {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const open = /^---[ \t]*\n/.exec(t);
  if (!open) return t;
  const rest = t.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return t;
  const blocks = [];
  for (const line of rest.slice(0, close.index).split('\n')) {
    const m = /^([A-Za-z_][\w.-]*)[ \t]*:/.exec(line);
    if (m) blocks.push({ key: m[1], lines: [line] });
    else if (blocks.length && (/^[ \t-]/.test(line) || !line.trim())) blocks[blocks.length - 1].lines.push(line);
  }
  // metadata must be a map of strings: drop it when it holds lists or nested maps
  const flatMap = (b) => b.lines.slice(1).every((l) => !l.trim() || /^[ \t]+[\w.-]+:[ \t]+\S/.test(l));
  const keep = blocks.filter((b) => SPEC_KEYS.includes(b.key) && (b.key !== 'metadata' || flatMap(b)));
  if (!keep.some((b) => b.key === 'name')) keep.unshift({ key: 'name', lines: [`name: ${name}`] });
  return `---\n${keep.flatMap((b) => b.lines).join('\n').replace(/\n+$/, '')}\n---${rest.slice(close.index + close[0].length)}`;
}
function zipFolder(dirPath, rootName, out) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d).sort()) {
      const full = p(d, e);
      const r = rel ? `${rel}/${e}` : e;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else files.push([full, `${rootName}/${r}`, r]);
    }
  };
  walk(dirPath, '');
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01: a valid date keeps strict unzip tools quiet
  for (const [full, name, rel] of files) {
    let data = fs.readFileSync(full);
    if (rel === 'SKILL.md') data = Buffer.from(sanitizeSkillMd(data.toString('utf8'), rootName), 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = CRC(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...chunks, cd, end]));
}
async function zip(names) {
  const pick = names.length ? names.flatMap((n) => n.split(',')).filter(Boolean) : enabledSkills();
  const dist = p(PACK, 'dist');
  if (!DRY) fs.mkdirSync(dist, { recursive: true });
  let n = 0;
  for (const name of pick) {
    const d = [p(PACK, 'skills', name), p(PACK, 'skills-disabled', name)].find((x) => exists(p(x, 'SKILL.md')));
    if (!d || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      console.log(`skip ${name}: ${d ? 'not a valid skill name (a-z, 0-9, -)' : 'no such skill'}`);
      continue;
    }
    if (!DRY) zipFolder(d, name, p(dist, `${name}.zip`));
    n++;
  }
  console.log(`${DRY ? '[dry-run] would write' : 'wrote'} ${n} zip(s) to ${dist}
claude.ai: Customize > Skills > + > Upload a skill      ChatGPT: Skills > Create > Upload
(a skill uploaded to claude.ai AND installed locally shows up twice in Claude Code)`);
}

// ------------------------------------------------------------------------------------------ cli (last: everything above is initialized)
const COMMANDS = { install, uninstall, status, doctor, tags, enable, disable, update, zip, list, help, table };
if (NODE_MAJOR < 18) {
  console.error(`ai-pack needs Node.js 18+ (found ${process.versions.node})`);
  process.exit(1);
}
if (ARGS.bad.length) {
  console.error(`unknown or incomplete option(s): ${ARGS.bad.join(' ')} - run: node install.mjs help`);
  process.exit(2);
}
if (ARGS.tags && CMD !== 'install') {
  console.error(`--tags belongs to install - to change your tags run: node install.mjs tags ${ARGS.tags}`);
  process.exit(2);
}
if (!COMMAND_NAMES.includes(CMD)) {
  console.error(`unknown command "${CMD}" - run: node install.mjs help`);
  process.exit(2);
}
try {
  await COMMANDS[CMD](ARGS._.slice(1));
} catch (e) {
  console.error(`\n[error] ${e.message}`);
  if (process.env.AI_PACK_DEBUG) console.error(e.stack);
  process.exit(1);
}
