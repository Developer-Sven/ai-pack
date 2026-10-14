// End-to-end tests of install.mjs. Every run uses a throw-away HOME (--home) and, except for the
// read-only real-pack test, a small fixture pack (--root) - the real home and this checkout are
// never changed. Run: node --test test/install.test.mjs      (Windows, macOS, Linux; Node >= 18)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(PACK, 'install.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pack-test-')));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const WIN = process.platform === 'win32';
let seq = 0;
const tmp = (name) => {
  const d = path.join(TMP, `${++seq} ${name}`); // spaces and unicode in every path on purpose
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const J = path.join;
const write = (f, t) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (x) => {
  try {
    fs.lstatSync(x);
    return true;
  } catch {
    return false;
  }
};
const isLink = (x) => {
  try {
    return fs.lstatSync(x).isSymbolicLink();
  } catch {
    return false;
  }
};
function run(args, home, root, { status = 0, env = {}, input = '' } = {}) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args, '--home', home, ...(root ? ['--root', root] : [])],
    { encoding: 'utf8', input, env: { ...process.env, AI_PACK_ASK: '', ...env } });
  if (status !== null) assert.equal(r.status, status, `install.mjs ${args.join(' ')} -> ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}
const out = (...a) => run(...a).stdout;
// every file (size + hash) and link below root; empty dirs only when withDirs
function tree(root, withDirs = true) {
  const rows = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = J(d, e.name);
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (rel === '.ai-pack') continue;
      if (e.isSymbolicLink()) rows.push(`${rel} -> link`);
      else if (e.isDirectory()) {
        if (withDirs) rows.push(`${rel}/`);
        walk(f);
      } else rows.push(`${rel} ${crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10)}`);
    }
  };
  walk(root);
  return rows.join('\n');
}
function makeHome(dirs = [], files = {}) {
  const home = tmp('home ü');
  for (const d of dirs) fs.mkdirSync(J(home, d), { recursive: true });
  for (const [f, t] of Object.entries(files)) write(J(home, f), t);
  return home;
}
const state = (home) => JSON.parse(read(J(home, '.ai-pack', 'state.json')));
const git = (cwd, ...args) => {
  const env = { ...process.env, HOME: TMP, USERPROFILE: TMP, GIT_CONFIG_GLOBAL: J(TMP, 'no.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const HAS_GIT = spawnSync('git', ['--version']).status === 0;

// ------------------------------------------------------------------ strict validators (TOML 1.0 / YAML subset we emit)
function parseToml(src) {
  const outp = {};
  let i = 0;
  const fail = (m) => {
    throw new Error(`TOML: ${m} near ${JSON.stringify(src.slice(i, i + 40))}`);
  };
  const ctrl = (c, ml) => (c < 0x20 && c !== 0x09 && !(ml && c === 0x0a)) || c === 0x7f;
  while (i < src.length) {
    if (src[i] === '\n') {
      i++;
      continue;
    }
    if (src[i] === '#') {
      const e = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
      for (const ch of src.slice(i, e)) if (ctrl(ch.codePointAt(0))) fail('control char in comment');
      i = e;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(src.slice(i));
    if (!m) fail('expected key = value');
    if (m[1] in outp) fail('duplicate key');
    i += m[0].length;
    let val;
    if (src.startsWith("'''", i)) {
      i += 3;
      if (src[i] === '\n') i++;
      const e = src.indexOf("'''", i);
      if (e < 0) fail('unclosed literal');
      let end = e;
      while (src[end + 3] === "'" && end - e < 2) end++; // up to two quotes before the delimiter are content
      val = src.slice(i, end);
      for (const ch of val) if (ctrl(ch.codePointAt(0), true)) fail('control char in literal');
      i = end + 3;
    } else if (src[i] === '"') {
      i++;
      val = '';
      const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      for (;;) {
        if (i >= src.length || src[i] === '\n') fail('unclosed string');
        if (src[i] === '"') {
          i++;
          break;
        }
        if (src[i] === '\\') {
          const e = src[i + 1];
          if (e in simple) {
            val += simple[e];
            i += 2;
          } else if (e === 'u' || e === 'U') {
            const hex = src.slice(i + 2, i + 2 + (e === 'u' ? 4 : 8));
            if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== (e === 'u' ? 4 : 8)) fail('bad \\u escape');
            const cp = parseInt(hex, 16);
            if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('escape is not a Unicode scalar value');
            val += String.fromCodePoint(cp);
            i += 2 + hex.length;
          } else fail(`bad escape \\${e}`);
        } else {
          const cp = src.codePointAt(i);
          if (ctrl(cp)) fail('raw control char in string');
          val += String.fromCodePoint(cp);
          i += cp > 0xffff ? 2 : 1;
        }
      }
    } else if (/^(true|false)\b/.test(src.slice(i))) {
      val = src.startsWith('true', i);
      i += val ? 4 : 5;
    } else fail('unsupported value');
    const rest = /^[ \t]*(#[^\n]*)?(\n|$)/.exec(src.slice(i));
    if (!rest) fail('junk after value');
    i += rest[0].length;
    outp[m[1]] = val;
  }
  return outp;
}
const YAML_ESC = { 0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
const printable = (c) => c === 9 || (c >= 0x20 && c <= 0x7e) || c === 0x85 || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff) || (c >= 0x10000 && c <= 0x10ffff);
function yamlDq(v) {
  let i = 1;
  let s = '';
  for (;;) {
    if (i >= v.length) throw new Error(`YAML: unclosed string ${v}`);
    const cp = v.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (ch === '"') break;
    if (ch === '\\') {
      const e = v[i + 1];
      const n = { x: 2, u: 4, U: 8 }[e];
      if (n) {
        const hex = v.slice(i + 2, i + 2 + n);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== n) throw new Error('YAML: bad hex escape');
        const c = parseInt(hex, 16);
        if (c >= 0xd800 && c <= 0xdfff) throw new Error('YAML: surrogate escape');
        s += String.fromCodePoint(c);
        i += 2 + n;
      } else if (e in YAML_ESC) {
        s += YAML_ESC[e];
        i += 2;
      } else throw new Error(`YAML: bad escape \\${e}`);
      continue;
    }
    if (!printable(cp)) throw new Error(`YAML: raw non-printable U+${cp.toString(16)}`);
    s += ch;
    i += ch.length;
  }
  if (v.slice(i + 1).trim()) throw new Error(`YAML: junk after string: ${v}`);
  return s;
}
function yamlVal(v) {
  if (v.startsWith('"')) return yamlDq(v);
  if (v.startsWith('[')) {
    const items = [];
    let rest = v.slice(1);
    while (!rest.startsWith(']')) {
      const m = /^"(?:[^"\\]|\\.)*"/.exec(rest);
      if (!m) throw new Error(`YAML: flow item ${rest}`);
      items.push(yamlDq(m[0]));
      rest = rest.slice(m[0].length).replace(/^, /, '');
    }
    if (rest !== ']') throw new Error(`YAML: junk after list ${v}`);
    return items;
  }
  if (!/^[A-Za-z0-9][\w.-]*$/.test(v)) throw new Error(`YAML: unsafe plain scalar ${JSON.stringify(v)}`);
  return v === 'true' ? true : v === 'false' ? false : v;
}
function parseFrontmatter(text) {
  assert.ok(text.startsWith('---\n'), 'frontmatter at byte 0');
  const end = text.indexOf('\n---\n', 3);
  assert.ok(end > 0, 'frontmatter closed');
  const top = {};
  let map = null;
  for (const line of text.slice(4, end).split('\n')) {
    let m = /^ {2}([a-z_]+): (\S.*)$/.exec(line);
    if (m && map) {
      map[m[1]] = yamlVal(m[2]);
      continue;
    }
    m = /^([A-Za-z_][\w-]*):(?: (.+))?$/.exec(line);
    if (!m) throw new Error(`YAML: unexpected line ${JSON.stringify(line)}`);
    if (m[1] in top) throw new Error(`YAML: duplicate key ${m[1]}`);
    if (m[2] === undefined) map = top[m[1]] = {};
    else {
      map = null;
      top[m[1]] = yamlVal(m[2]);
    }
  }
  return top;
}
// optional second opinion from real parsers (tomllib + PyYAML) when python has them
const PY = (() => {
  const exe = WIN ? 'python' : 'python3';
  const r = spawnSync(exe, ['-c', 'import tomllib, yaml'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? exe : null;
})();
const PY_LOAD = `import json, sys, tomllib, yaml
out = {}
for f in sys.argv[1:]:
    t = open(f, encoding='utf-8').read()
    out[f] = tomllib.loads(t) if f.endswith('.toml') else yaml.safe_load(t[4:t.index('\\n---\\n', 3)])
print(json.dumps(out))`;
const pyLoad = (files) => {
  const r = spawnSync(PY, ['-c', PY_LOAD, ...files], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// ------------------------------------------------------------------ fixture pack
const RULES_FULL = `# Rules\n\nThe full rule set.\n\n${'- a rule line that makes the full text longer than the condensed one.\n'.repeat(40)}`;
const RULES_MIN = '# Rules (condensed)\n\nThe short rule set.\n';
const NASTY_DESC = `Quotes " and 'single', colon: yes, hash # kept, backslash \\ tab\there, unicode é ü 日本 😀, dollar \${x}, triple ''' and """, ctl\x7f\x85﻿ end`;
const NASTY_SRC = `description: "${NASTY_DESC.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\x7f/g, '\\x7f').replace(/\x85/g, '\\x85').replace(/﻿/g, '\\ufeff')}"`;
const NASTY_BODY = 'Body with \'\'\' triple quotes, """ doubles, a backslash \\ and a trailing quote\'\n';
const AGENTS = {
  nasty: { src: `---\nname: nasty\n${NASTY_SRC}\ntools: [Read, Grep, "Glob"]\n---\n${NASTY_BODY}`, description: NASTY_DESC, body: NASTY_BODY, ro: true },
  folded: {
    src: '---\nname: folded\ndescription: >-\n  Folded description: with a colon,\n  a "quote" and a # hash\n  over three lines.\ntools:\n  - Read\n  - Write\n---\nFolded body.\n',
    description: 'Folded description: with a colon, a "quote" and a # hash over three lines.', body: 'Folded body.\n', ro: false,
  },
  plain: { src: '---\nname: plain\ndescription: Reviews code (read-only), finds bugs #1 is a YAML comment\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nPlain body.\n', description: 'Reviews code (read-only), finds bugs', body: 'Plain body.\n', ro: true },
  lit: { src: "---\r\nname: lit\r\ndescription: 'It''s single-quoted: fine'\r\n---\r\nends with quotes''", description: "It's single-quoted: fine", body: "ends with quotes''", ro: false },
  esc: { src: '---\nname: esc\ndescription: "Has an escape \\e char"\n---\nbody with ESC \x1b here\n', description: 'Has an escape \x1b char', body: 'body with ESC \x1b here\n', ro: false },
  'extra-agent': { src: '---\nname: extra-agent\ndescription: Extra agent.\n---\nextra\n', description: 'Extra agent.', body: 'extra\n', ro: false },
};
// tags of the fixture items (like the real catalog: everything ships enabled, the user picks tags)
const TAGS = { alpha: ['core'], beta: ['web'], delta: ['web', 'data'], gamma: ['extra'],
  nasty: ['core'], folded: ['web'], plain: ['data'], lit: ['core'], esc: ['core'], 'extra-agent': ['extra'] };
function makePack() {
  const root = tmp('pack ü x');
  const w = (rel, t) => write(J(root, rel), t);
  w('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha skill.\nmetadata:\n  origin: test\n---\nalpha body\n');
  w('skills/beta/SKILL.md', '---\nname: beta\ndescription: >\n  Beta: folded, with "quotes"\n  and a second line.\nmodel: sonnet\ndisable-model-invocation: true\nmetadata:\n  author:\n    - ki\n---\nbeta body\n');
  w('skills/beta/references/notes.md', 'notes\n');
  w('skills/delta/SKILL.md', '---\nname: delta\ndescription: Delta skill.\n---\ndelta\n');
  w('skills/gamma/SKILL.md', '---\nname: gamma\ndescription: Gamma skill.\n---\ngamma\n');
  w('skills-disabled/.gitkeep', ''); // like the real pack: the folders exist, empty
  w('agents-disabled/.gitkeep', '');
  for (const [n, a] of Object.entries(AGENTS)) w(`agents/${n}.md`, a.src);
  w('agents/Bad_Name.md', '---\nname: Bad_Name\ndescription: invalid name\n---\nx\n');
  w('rules/global-work-rules.md', RULES_FULL);
  w('rules/global-work-rules.min.md', RULES_MIN);
  w('hooks/pre-commit', '#!/bin/sh\nexit 0\n');
  w('.gitignore', '.ai-pack-local.json\ndist/\n');
  w('catalog.json', catalogJson(['alpha', 'beta', 'delta', 'gamma']));
  return root;
}

function catalogJson(skills, extraTags = {}) {
  const tags = { ...TAGS, ...extraTags };
  const item = (name, kind) => ({ name, kind, enabled: true, area: 'Test', tags: tags[name], description: name });
  return JSON.stringify({ name: 'test-pack', version: '0.0.0', tag_groups: { core: ['core'], stack: ['web', 'data', 'extra'] },
    presets: { recommended: ['web', 'data'] }, items: [...skills.map((n) => item(n, 'skill')), ...Object.keys(AGENTS).map((n) => item(n, 'agent'))] }, null, 1);
}

// ------------------------------------------------------------------ the real pack, read-only
const packList = () => ['skills', 'skills-disabled', 'agents', 'agents-disabled', 'dist', '.ai-pack-local.json'].map((d) => `${d}: ${exists(J(PACK, d)) ? (fs.statSync(J(PACK, d)).isDirectory() ? fs.readdirSync(J(PACK, d)).sort().join(',') : read(J(PACK, d))) : '-'}`).join('\n');
const packBefore = packList();
const REAL = makeHome(['.claude/skills/my-own-skill', '.claude/skills/ship', '.codex', '.config/opencode', '.gemini', '.copilot', '.codeium/windsurf', '.kiro', '.qwen'], {
  '.claude/skills/my-own-skill/SKILL.md': '---\nname: my-own-skill\ndescription: "mine"\n---\nbody\n',
  '.claude/skills/ship/SKILL.md': '---\nname: ship\ndescription: "user version"\n---\nuser ship\n',
  '.gemini/settings.json': '{}\n',
  '.copilot/config.json': '{}\n',
  '.codex/AGENTS.md': '# my notes\nkeep me\n',
});
const realBefore = tree(REAL);
const firstSkill = fs.readdirSync(J(PACK, 'skills')).sort().find((s) => exists(J(PACK, 'skills', s, 'SKILL.md')));
const firstAgent = fs.readdirSync(J(PACK, 'agents')).sort().find((f) => f.endsWith('.md')).replace(/\.md$/, '');

test('real pack: dry-run changes nothing', () => {
  run(['--dry-run'], REAL);
  assert.equal(tree(REAL), realBefore);
});

test('real pack: install connects every detected tool and leaves the user\'s skills alone', () => {
  assert.match(out([], REAL), /no tags chosen - everything stays on/, 'no terminal: no question, nothing moved');
  const h = (...x) => J(REAL, ...x);
  assert.ok(!isLink(h('.claude/skills')) && isLink(h('.claude/skills', firstSkill)), 'one link per skill in the existing folder');
  assert.ok(exists(h('.claude/skills', firstSkill, 'SKILL.md')));
  assert.ok(isLink(h('.agents/skills', firstSkill)), 'shared ~/.agents/skills');
  assert.equal(read(h('.claude/skills/my-own-skill/SKILL.md')), '---\nname: my-own-skill\ndescription: "mine"\n---\nbody\n', 'own skill untouched');
  assert.ok(!isLink(h('.claude/skills/ship')) && read(h('.claude/skills/ship/SKILL.md')).includes('user ship'), 'same-named user skill wins');
  assert.ok(exists(h('.claude/agents/ai-pack', `${firstAgent}.md`)), 'claude agents live link');
  assert.ok(exists(h('.claude/rules/ai-pack.md')));
  assert.ok(exists(h('.codex/agents', `${firstAgent}.toml`)), 'codex toml agents');
  const codexMd = read(h('.codex/AGENTS.md'));
  assert.ok(codexMd.startsWith('# my notes\nkeep me\n') && codexMd.split('ai-pack:begin').length === 2, 'own text kept, one block added');
  assert.match(read(h('.config/opencode/agents', `${firstAgent}.md`)), /mode: subagent/);
  const gem = read(h('.gemini/GEMINI.md'));
  if (/\s/.test(PACK)) assert.ok(!/^@/m.test(gem), 'path with spaces: inlined');
  else assert.match(gem, /^@.*global-work-rules\.md$/m);
  assert.ok(exists(h('.copilot/agents', `${firstAgent}.agent.md`)));
  assert.match(read(h('.copilot/copilot-instructions.md')), /ai-pack:begin/, 'with Claude Code: rules in the file VS Code does not read');
  assert.ok(!exists(h('.copilot/instructions')), 'no second copy for VS Code');
  assert.ok([...read(h('.codeium/windsurf/memories/global_rules.md'))].length <= 6000);
  assert.match(read(h('.kiro/steering/ai-pack.md')), /inclusion: always/);
  assert.ok(isLink(h('.kiro/skills', firstSkill)) && isLink(h('.qwen/skills', firstSkill)), 'item links for tools with own dirs');
});

test('real pack: a second install changes nothing', () => {
  const o = out([], REAL);
  assert.doesNotMatch(o, /^ {2}(link|gen |rules|copy|fix |keep|skip  rules)/m, o);
});

test('real pack: every converted agent is valid TOML / YAML', () => {
  const files = state(REAL).actions.filter((a) => a.type === 'generated').map((a) => a.path);
  assert.ok(files.length > 50);
  const parsed = {};
  for (const f of files) {
    const text = read(f);
    parsed[f] = f.endsWith('.toml') ? parseToml(text) : parseFrontmatter(text);
    assert.ok(String(parsed[f].description || '').trim(), `${f}: description`);
    if (f.endsWith('.toml')) assert.ok(parsed[f].name && parsed[f].developer_instructions, f);
  }
  if (PY) {
    const py = pyLoad(files);
    const src = pyLoad(fs.readdirSync(J(PACK, 'agents')).filter((f) => f.endsWith('.md')).map((f) => J(PACK, 'agents', f)));
    const want = Object.fromEntries(Object.entries(src).map(([f, fm]) => [path.basename(f, '.md'), fm.description]));
    for (const f of files) {
      const name = path.basename(f).replace(/\.(agent\.md|md|toml)$/, '');
      assert.equal(py[f].description, want[name], `${f}: description differs from the source (PyYAML)`);
      assert.equal(parsed[f].description, want[name], `${f}: our validator disagrees with tomllib/PyYAML`);
    }
  }
});

test('real pack: uninstall restores the home exactly and never touched the pack', () => {
  run(['uninstall'], REAL);
  assert.equal(tree(REAL), realBefore);
  assert.equal(packList(), packBefore, 'pack folder unchanged');
});

// ------------------------------------------------------------------ fixture pack
test('converters: nasty descriptions and bodies give valid TOML / YAML that round-trips', () => {
  const root = makePack();
  const home = makeHome();
  const before = tree(home);
  const o = out(['--all', '--skip', 'claude'], home, root);
  assert.match(o, /Bad_Name \(name must be/, 'invalid agent name reported');
  const files = state(home).actions.filter((a) => a.type === 'generated').map((a) => a.path);
  assert.ok(!files.some((f) => /Bad_Name/.test(f)));
  const formats = new Set();
  for (const f of files) {
    const name = path.basename(f).replace(/\.(agent\.md|md|toml)$/, '');
    const a = AGENTS[name];
    const text = read(f);
    if (f.endsWith('.toml')) {
      const t = parseToml(text);
      assert.equal(t.name, name);
      assert.equal(t.description, a.description, f);
      assert.equal(t.developer_instructions, a.body, `${f}: body round-trip`);
      assert.equal(t.sandbox_mode === 'read-only', a.ro, `${f}: read-only`);
      formats.add('codex');
    } else {
      const fm = parseFrontmatter(text);
      assert.equal(fm.description, a.description, f);
      if ('name' in fm) assert.equal(fm.name, name);
      if (f.includes(`${path.sep}.config${path.sep}opencode`)) assert.equal(fm.permission?.edit === 'deny', a.ro, `${f}: opencode edit`);
      if (f.includes(`${path.sep}.cursor${path.sep}`)) assert.equal(fm.readonly === true, a.ro, `${f}: cursor readonly`);
      if (f.includes(`${path.sep}.factory${path.sep}`)) assert.equal(fm.tools === 'read-only', a.ro, `${f}: droid tools`);
      formats.add(path.relative(home, f).split(path.sep)[0]);
    }
  }
  assert.ok(formats.size >= 9, `all converters ran: ${[...formats]}`);
  if (PY) {
    const py = pyLoad(files);
    for (const f of files) {
      const name = path.basename(f).replace(/\.(agent\.md|md|toml)$/, '');
      assert.equal(py[f].description, AGENTS[name].description, `${f} (python)`);
      if (f.endsWith('.toml')) assert.equal(py[f].developer_instructions, AGENTS[name].body, `${f} (tomllib)`);
    }
  }
  // the fixture path has a space: tools that @import get the rules inline instead
  const gem = read(J(home, '.gemini', 'GEMINI.md'));
  assert.ok(gem.includes('The full rule set.') && !/^@/m.test(gem));
  // without Claude Code, Copilot CLI and VS Code share one instructions file
  assert.ok(exists(J(home, '.copilot', 'instructions', 'ai-pack.instructions.md')) && !exists(J(home, '.copilot', 'copilot-instructions.md')));
  run(['uninstall'], home, root);
  assert.equal(tree(home), before);
});

test('rules blocks: updated in place, user text around them kept, damaged blocks left alone', () => {
  const root = makePack();
  const mine = 'intro\n\n## mine\ntext\n';
  const home = makeHome(['.codex', '.factory'], { '.codex/AGENTS.md': mine, '.factory/AGENTS.md': 'a\r\nb\r\n' });
  run(['--only', 'codex,droid'], home, root);
  const f = J(home, '.codex', 'AGENTS.md');
  fs.appendFileSync(f, '\n## after\nmore\n');
  write(J(root, 'rules', 'global-work-rules.md'), '# Rules v2\n\nchanged text\n');
  run(['--only', 'codex,droid'], home, root);
  let t = read(f);
  assert.equal(t.split('ai-pack:begin').length, 2, 'exactly one block');
  assert.ok(t.startsWith(mine) && t.endsWith('\n## after\nmore\n') && t.includes('changed text') && !t.includes('full rule set'));
  // a hand-duplicated block collapses back into one
  const blockText = t.slice(t.indexOf('<!-- ai-pack:begin'), t.indexOf('<!-- ai-pack:end -->') + 20);
  write(f, `${t}\n${blockText}\n`);
  run(['--only', 'codex'], home, root);
  assert.equal(read(f).split('ai-pack:begin').length, 2, 'duplicate removed');
  const crlf = read(J(home, '.factory', 'AGENTS.md'));
  assert.ok(crlf.startsWith('a\r\nb\r\n') && !/[^\r]\n/.test(crlf), 'CRLF file stays CRLF');
  run(['uninstall'], home, root);
  assert.equal(read(f), `${mine}\n## after\nmore\n`);
  assert.equal(read(J(home, '.factory', 'AGENTS.md')), 'a\r\nb\r\n');
  // a block whose end marker the user deleted: nothing is written, nothing is lost
  const broken = 'top\n<!-- ai-pack:begin (managed) -->\nold\nuser text below\n';
  write(f, broken);
  const o = out(['--only', 'codex'], home, root);
  assert.match(o, /damaged ai-pack block/);
  assert.equal(read(f), broken);
  run(['uninstall'], home, root);
  assert.equal(read(f), broken);
});

test('size caps: Codex falls back to the condensed rules, Windsurf and Codex skip when nothing fits', () => {
  const root = makePack();
  const big = `${'x'.repeat(99)}\n`.repeat(315); // 31,500 bytes
  const home = makeHome(['.codex', '.codeium/windsurf/memories'], { '.codex/AGENTS.md': big, '.codeium/windsurf/memories/global_rules.md': 'w'.repeat(5900) });
  const o = out(['--only', 'codex,windsurf'], home, root);
  const codex = read(J(home, '.codex', 'AGENTS.md'));
  assert.ok(codex.includes('The short rule set.') && !codex.includes('The full rule set.') && Buffer.byteLength(codex) <= 32768, 'condensed rules');
  assert.match(o, /would exceed 6000 characters/);
  assert.equal(read(J(home, '.codeium/windsurf/memories/global_rules.md')), 'w'.repeat(5900), 'windsurf untouched');
  const home2 = makeHome(['.codex'], { '.codex/AGENTS.md': 'y'.repeat(32700) });
  assert.match(out(['--only', 'codex'], home2, root), /would exceed 32768 bytes/);
  assert.equal(read(J(home2, '.codex', 'AGENTS.md')), 'y'.repeat(32700));
});

test('drift: skills disabled / removed / renamed by hand and removed agents are cleaned up', () => {
  const root = makePack();
  const home = makeHome(['.claude', '.codex', '.qwen', '.kiro']);
  const before = tree(home);
  run([], home, root);
  const dirs = ['.agents/skills', '.claude/skills', '.qwen/skills', '.kiro/skills'].map((d) => J(home, d));
  for (const d of dirs) assert.ok(isLink(J(d, 'alpha')) && isLink(J(d, 'delta')), d);
  fs.renameSync(J(root, 'skills', 'alpha'), J(root, 'skills-disabled', 'alpha'));
  fs.rmSync(J(root, 'skills', 'delta'), { recursive: true });
  fs.renameSync(J(root, 'skills', 'beta'), J(root, 'skills', 'beta-two'));
  fs.rmSync(J(root, 'agents', 'plain.md'));
  const doc = run(['doctor'], home, root, { status: 1 }).stdout;
  assert.match(doc, /not linked yet/);
  assert.match(doc, /broken or disabled/);
  run([], home, root);
  for (const d of dirs) {
    assert.ok(!exists(J(d, 'alpha')) && !exists(J(d, 'delta')) && !exists(J(d, 'beta')), `${d}: stale links removed`);
    assert.ok(isLink(J(d, 'beta-two')), `${d}: renamed skill linked`);
  }
  assert.ok(!exists(J(home, '.codex/agents/plain.toml')) && !exists(J(home, '.kiro/agents/plain.md')) && !exists(J(home, '.qwen/agents/plain.md')));
  assert.ok(exists(J(home, '.codex/agents/nasty.toml')));
  run(['doctor'], home, root);
  run(['uninstall'], home, root);
  assert.equal(tree(home), before);
});

test('user changes are never overwritten or deleted: edited generated files, own skills, changed copies', () => {
  const root = makePack();
  const home = makeHome(['.codex', '.agents/skills/mine', '.agents/skills/alpha', '.qwen'], {
    '.agents/skills/mine/SKILL.md': 'my skill\n',
    '.agents/skills/alpha/SKILL.md': 'my alpha\n',
  });
  const beforeFiles = tree(home, false);
  const o = out(['--only', 'codex'], home, root);
  assert.match(o, /alpha \(your own\)/);
  assert.equal(read(J(home, '.agents/skills/alpha/SKILL.md')), 'my alpha\n');
  assert.ok(isLink(J(home, '.agents/skills/beta')) && !isLink(J(home, '.agents/skills')));
  // an edited generated agent survives a re-run with a changed source, and uninstall
  const toml = J(home, '.codex/agents/nasty.toml');
  fs.appendFileSync(toml, '# my tweak\n');
  write(J(root, 'agents', 'nasty.md'), AGENTS.nasty.src.replace('Body with', 'Changed body with'));
  assert.match(out(['--only', 'codex'], home, root), /keep {2}agents you edited/);
  assert.ok(read(toml).endsWith('# my tweak\n'));
  // --copy: a copy the user changed is kept when the skill goes away, and on uninstall
  run(['--only', 'qwen', '--copy'], home, root);
  const copy = J(home, '.qwen/skills/alpha');
  assert.ok(!isLink(copy) && exists(J(copy, 'SKILL.md')));
  fs.appendFileSync(J(copy, 'SKILL.md'), 'my change\n');
  fs.renameSync(J(root, 'skills', 'alpha'), J(root, 'skills-disabled', 'alpha'));
  assert.match(out(['--only', 'qwen', '--copy'], home, root), /keep {2}.*alpha: changed since ai-pack made it/);
  run(['uninstall'], home, root);
  assert.ok(read(J(copy, 'SKILL.md')).endsWith('my change\n'), 'changed copy kept');
  assert.ok(!exists(J(home, '.qwen/skills/beta')), 'unchanged copy removed');
  assert.ok(read(toml).endsWith('# my tweak\n'), 'edited agent kept');
  assert.equal(read(J(home, '.agents/skills/mine/SKILL.md')), 'my skill\n');
  assert.ok(!exists(J(home, '.agents/skills/beta')));
  fs.rmSync(copy, { recursive: true });
  fs.rmSync(toml);
  assert.equal(tree(home, false), beforeFiles, 'nothing else left behind');
});

test('--copy: skills and Claude agents are copied, re-syncs stay copies, a later link install replaces them', () => {
  const root = makePack();
  const home = makeHome(['.claude']);
  const before = tree(home);
  run(['--copy', '--tags', 'web'], home, root);
  const agents = J(home, '.claude/agents/ai-pack');
  assert.ok(!isLink(agents) && read(J(agents, 'nasty.md')) === AGENTS.nasty.src, 'agent copied verbatim');
  assert.ok(!isLink(J(home, '.claude/skills/alpha')) && exists(J(home, '.claude/skills/alpha/SKILL.md')));
  run(['enable', 'extra'], home, root);
  assert.ok(!isLink(J(home, '.claude/skills/gamma')) && exists(J(agents, 'extra-agent.md')), 're-sync keeps copy mode');
  run(['disable', 'extra'], home, root);
  assert.ok(!exists(J(home, '.claude/skills/gamma')) && !exists(J(agents, 'extra-agent.md')));
  run([], home, root);
  assert.ok(isLink(agents) && isLink(J(home, '.claude/skills/alpha')), 'back to links');
  run(['uninstall'], home, root);
  assert.equal(tree(home), before);
});

test('interrupted run: a lost state file is rebuilt on the next install, uninstall still cleans up', () => {
  const root = makePack();
  const home = makeHome(['.claude', '.codex', '.qwen'], { '.gemini/settings.json': '{}\n' });
  const before = tree(home, false);
  run([], home, root);
  fs.rmSync(J(home, '.ai-pack'), { recursive: true }); // crash before the state was saved
  const o = out([], home, root);
  assert.doesNotMatch(o, /not the pack's|exists and is not/, o);
  run(['uninstall'], home, root);
  assert.equal(tree(home, false), before, 'no link, generated file or block left behind');
});

test('a damaged state file stops install instead of forgetting what it did', () => {
  const root = makePack();
  const home = makeHome(['.codex']);
  run([], home, root);
  const f = J(home, '.ai-pack', 'state.json');
  fs.rmSync(`${f}.bak`, { force: true });
  write(f, '{ broken');
  assert.match(run([], home, root, { status: 1 }).stderr, /damaged/);
  assert.match(run(['uninstall'], home, root, { status: 1 }).stderr, /damaged/);
});

test('enable / disable: every connected tool follows, excluded tools stay untouched, no overwrites', () => {
  const root = makePack();
  const home = makeHome(['.claude', '.codex', '.qwen', '.kiro']);
  run(['--only', 'claude,qwen', '--tags', 'recommended'], home, root);
  assert.ok(exists(J(root, 'skills-disabled', 'gamma')) && !exists(J(home, '.qwen/skills/gamma')));
  run(['enable', 'extra'], home, root);
  assert.ok(exists(J(root, 'skills', 'gamma')) && exists(J(root, 'agents', 'extra-agent.md')));
  assert.ok(isLink(J(home, '.claude/skills/gamma')) && isLink(J(home, '.qwen/skills/gamma')));
  assert.ok(exists(J(home, '.qwen/agents/extra-agent.md')), 'converted agent added');
  assert.ok(!exists(J(home, '.agents')) && !exists(J(home, '.codex/agents')) && !exists(J(home, '.kiro/skills')), 'excluded tools untouched');
  run(['disable', 'gamma,extra-agent'], home, root);
  assert.ok(!exists(J(home, '.qwen/skills/gamma')) && !exists(J(home, '.qwen/agents/extra-agent.md')));
  assert.deepEqual(JSON.parse(read(J(root, '.ai-pack-local.json'))), { tags: ['web', 'data', 'extra'], enabled: [], disabled: ['gamma', 'extra-agent'] });
  const st = out(['status'], home, root);
  assert.match(st, /^claude +connected/m);
  assert.match(st, /^codex +detected/m);
  // both copies exist: disable refuses instead of overwriting one with the other
  fs.cpSync(J(root, 'skills-disabled', 'gamma'), J(root, 'skills', 'gamma'), { recursive: true });
  write(J(root, 'skills', 'gamma', 'SKILL.md'), 'mine\n');
  assert.match(run(['disable', 'gamma'], home, root, { status: 1 }).stdout, /conflict/);
  assert.equal(read(J(root, 'skills', 'gamma', 'SKILL.md')), 'mine\n');
  assert.ok(exists(J(root, 'skills-disabled', 'gamma', 'SKILL.md')));
});

test('copilot: CLI and VS Code share one rules file without Claude Code; with it the CLI moves to its own', () => {
  const root = makePack();
  const home = makeHome(['.vscode/extensions/github.copilot-chat-1.2.3'], { '.copilot/config.json': '{}\n' });
  const before = tree(home);
  run([], home, root);
  const instr = J(home, '.copilot/instructions/ai-pack.instructions.md');
  assert.match(read(instr), /^---\napplyTo: "\*\*"/);
  assert.ok(!exists(J(home, '.copilot/copilot-instructions.md')));
  fs.mkdirSync(J(home, '.claude'));
  const o = out([], home, root);
  assert.match(o, /rules removed from/);
  assert.ok(!exists(instr) && read(J(home, '.copilot/copilot-instructions.md')).includes('ai-pack:begin'));
  assert.ok(exists(J(home, '.claude/rules/ai-pack.md')));
  run(['uninstall'], home, root);
  fs.rmdirSync(J(home, '.claude'));
  assert.equal(tree(home), before);
});

test('options: typos and --help never install anything', () => {
  const root = makePack();
  const home = makeHome(['.codex']);
  const before = tree(home);
  assert.match(run(['--dryrun'], home, root, { status: 2 }).stderr, /unknown or incomplete option/);
  assert.match(run(['install', '--only'], home, root, { status: 2 }).stderr, /needs a value/);
  assert.match(run(['--help'], home, root).stdout, /^usage:/m);
  assert.match(run(['bogus'], home, root, { status: 2 }).stderr, /unknown command/);
  assert.equal(tree(home), before);
});

test('zip: uploadable archive with spec-only frontmatter', () => {
  const root = makePack();
  run(['zip', 'beta,alpha'], makeHome(), root);
  const unzip = (file) => {
    const z = fs.readFileSync(file);
    const entries = {};
    for (let o = 0; z.readUInt32LE(o) === 0x04034b50;) {
      const size = z.readUInt32LE(o + 18);
      const nameLen = z.readUInt16LE(o + 26);
      const start = o + 30 + nameLen + z.readUInt16LE(o + 28);
      const data = zlib.inflateRawSync(z.subarray(start, start + size));
      assert.equal(data.length, z.readUInt32LE(o + 22));
      assert.equal(z.readUInt32LE(o + 14), crc32(data), 'crc');
      entries[z.toString('utf8', o + 30, o + 30 + nameLen)] = data.toString('utf8');
      o = start + size;
    }
    return entries;
  };
  const entries = unzip(J(root, 'dist', 'beta.zip'));
  assert.deepEqual(Object.keys(entries).sort(), ['beta/SKILL.md', 'beta/references/notes.md']);
  const skill = entries['beta/SKILL.md'];
  assert.ok(skill.startsWith('---\nname: beta\ndescription: >\n  Beta: folded'), skill);
  assert.doesNotMatch(skill, /^(model|disable-model-invocation|metadata):/m, 'Claude-only keys and list metadata dropped');
  assert.ok(skill.endsWith('---\nbeta body\n'));
  assert.match(unzip(J(root, 'dist', 'alpha.zip'))['alpha/SKILL.md'], /metadata:\n {2}origin: test/, 'string-map metadata kept');
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

test('update: pulls, keeps tags and choices (also hand moves), new items follow the tags, recovers from a failed pull', { skip: !HAS_GIT && 'git not installed' }, () => {
  const upstream = makePack();
  git(upstream, 'init', '-q');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'v1');
  const root = J(tmp('clone ü'), 'pack');
  git(TMP, 'clone', '-q', upstream, root);
  const home = makeHome(['.claude', '.qwen']);
  run(['--tags', 'recommended'], home, root);
  run(['disable', 'alpha'], home, root);
  fs.renameSync(J(root, 'skills-disabled', 'gamma'), J(root, 'skills', 'gamma')); // enabled by hand
  write(J(upstream, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta v2.\n---\nv2\n');
  write(J(upstream, 'skills', 'epsilon', 'SKILL.md'), '---\nname: epsilon\ndescription: New, tagged web.\n---\ne\n');
  write(J(upstream, 'skills', 'zeta', 'SKILL.md'), '---\nname: zeta\ndescription: New, tagged extra.\n---\nz\n');
  write(J(upstream, 'catalog.json'), catalogJson(['alpha', 'beta', 'delta', 'gamma', 'epsilon', 'zeta'], { epsilon: ['web'], zeta: ['extra'] }));
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'v2');
  run(['update'], home, root);
  assert.match(read(J(root, 'skills', 'beta', 'SKILL.md')), /v2/, 'pulled');
  assert.ok(exists(J(root, 'skills-disabled', 'alpha')) && exists(J(root, 'skills', 'gamma')), 'choices kept');
  assert.ok(exists(J(root, 'skills', 'epsilon')) && exists(J(root, 'skills-disabled', 'zeta')), 'new items follow the tags');
  assert.ok(isLink(J(home, '.qwen/skills/gamma')) && isLink(J(home, '.qwen/skills/epsilon')) && !exists(J(home, '.qwen/skills/alpha')) && !exists(J(home, '.qwen/skills/zeta')), 'tools re-synced');
  assert.deepEqual(JSON.parse(read(J(root, '.ai-pack-local.json'))), { tags: ['web', 'data'], enabled: ['gamma'], disabled: ['alpha'] });
  // a local edit that collides with upstream: pull fails, the tree stays as the user had it
  write(J(upstream, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta v3.\n---\nv3\n');
  git(upstream, 'commit', '-q', '-am', 'v3');
  write(J(root, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: my beta.\n---\nmine\n');
  assert.match(run(['update'], home, root, { status: 1 }).stderr, /git pull failed/);
  assert.match(read(J(root, 'skills', 'beta', 'SKILL.md')), /mine/);
  assert.ok(exists(J(root, 'skills-disabled', 'alpha')) && exists(J(root, 'skills', 'gamma')));
  assert.ok(!('updating' in JSON.parse(read(J(root, '.ai-pack-local.json')))));
});

test('git hooks: opt-in, never records its own path as the previous one, uninstall restores it', { skip: !HAS_GIT && 'git not installed' }, () => {
  const root = makePack();
  const home = makeHome(['.claude']);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: J(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const cfg = (...a) => spawnSync('git', ['config', '--global', ...a], { encoding: 'utf8', env }).stdout.trim();
  cfg('core.hooksPath', '/prev/hooks');
  assert.match(out(['--with-git-hooks'], home, root), /already \/prev\/hooks - not changed/);
  run(['--with-git-hooks', '--force'], home, root);
  assert.equal(cfg('--get', 'core.hooksPath'), J(root, 'hooks').split(path.sep).join('/'));
  run(['--with-git-hooks'], home, root);
  run(['uninstall'], home, root);
  assert.equal(cfg('--get', 'core.hooksPath'), '/prev/hooks');
});

test('git hooks: a git config that cannot be written fails loudly, is not recorded, and uninstall retries it', { skip: !HAS_GIT && 'git not installed' }, () => {
  const root = makePack();
  const home = makeHome(['.claude']);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: J(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const cfg = (...a) => spawnSync('git', ['config', '--global', ...a], { encoding: 'utf8', env }).stdout.trim();
  const lock = J(home, '.gitconfig.lock'); // git refuses to write a config while its lock file exists
  write(lock, '');
  assert.match(run(['--with-git-hooks'], home, root, { status: 1 }).stderr, /git could not set core\.hooksPath/);
  assert.ok(!state(home).actions.some((a) => a.type === 'hooks'), 'a change that did not happen is not recorded');
  assert.ok(state(home).actions.some((a) => a.type === 'item'), 'everything else the run did is recorded');
  fs.rmSync(lock);
  run(['--with-git-hooks'], home, root);
  assert.equal(cfg('--get', 'core.hooksPath'), J(root, 'hooks').split(path.sep).join('/'));
  write(lock, '');
  assert.match(run(['uninstall'], home, root, { status: 1 }).stdout, /git could not unset core\.hooksPath/);
  assert.ok(state(home).actions.some((a) => a.type === 'hooks'), 'the failed step stays for the next run');
  fs.rmSync(lock);
  run(['uninstall'], home, root);
  assert.equal(cfg('--get', 'core.hooksPath'), '', 'unset in the end');
});

test('a damaged .ai-pack-local.json is reported and rewritten from the folders', () => {
  const root = makePack();
  const home = makeHome(['.claude']);
  run(['--tags', 'web'], home, root);
  write(J(root, '.ai-pack-local.json'), '{ broken');
  assert.match(out(['enable', 'gamma'], home, root), /\.ai-pack-local\.json is damaged/);
  assert.deepEqual(JSON.parse(read(J(root, '.ai-pack-local.json'))), { enabled: [], disabled: [] });
  assert.ok(isLink(J(home, '.claude/skills/gamma')));
  // the lost tag choice is simply made again - the first choice decides alone
  run(['tags', 'web'], home, root);
  assert.ok(exists(J(root, 'skills-disabled', 'gamma')) && !exists(J(home, '.claude/skills/gamma')));
  assert.deepEqual(JSON.parse(read(J(root, '.ai-pack-local.json'))), { tags: ['web'], enabled: [], disabled: [] });
});

test('a home folder inside the pack is refused, also when its name starts with ".."', () => {
  const root = makePack();
  const home = J(root, '..home');
  fs.mkdirSync(J(home, '.claude'), { recursive: true });
  assert.match(run([], home, root, { status: 1 }).stderr, /home folder lies inside the pack folder/);
  assert.deepEqual(fs.readdirSync(home), ['.claude'], 'nothing written');
});

test('served through a user-made link: tools that read ~/.claude/agents get no converted duplicates', () => {
  const root = makePack();
  const home = makeHome(['.claude', '.cursor']);
  // the user linked ~/.claude/agents to the pack's agents folder by hand (e.g. an older setup)
  fs.symlinkSync(J(root, 'agents'), J(home, '.claude', 'agents'), WIN ? 'junction' : 'dir');
  const o = out(['--only', 'claude,cursor', '--no-rules'], home, root);
  assert.match(o, /agents: already reach the pack via/);
  assert.ok(!exists(J(home, '.cursor', 'agents')), `cursor got converted agents although it reads ~/.claude/agents:\n${o}`);
  run(['uninstall'], home, root);
  assert.ok(isLink(J(home, '.claude', 'agents')), 'the user-made link is left alone');
});

test('tags: the choice moves items and every tool follows; +/-, presets, per-item choices and hand moves', () => {
  const root = makePack();
  const home = makeHome(['.claude', '.qwen']);
  const before = tree(home);
  const on = (x) => exists(J(root, x));
  const local = () => JSON.parse(read(J(root, '.ai-pack-local.json')));
  run(['--tags', 'web'], home, root);
  assert.ok(['skills/alpha', 'skills/beta', 'skills/delta', 'skills-disabled/gamma'].every(on), 'core + web on, the rest off');
  assert.ok(['agents/nasty.md', 'agents/folded.md', 'agents-disabled/plain.md', 'agents-disabled/extra-agent.md'].every(on));
  assert.ok(isLink(J(home, '.qwen/skills/beta')) && !exists(J(home, '.qwen/skills/gamma')) && !exists(J(home, '.qwen/agents/plain.md')));
  assert.ok(!exists(J(home, '.claude/agents/ai-pack/plain.md')), 'claude sees only enabled agents');
  assert.deepEqual(local(), { tags: ['web'], enabled: [], disabled: [] });
  assert.match(out(['tags'], home, root), /\*web\(3\) {2}data\(2\) {2}extra\(2\)/);
  run(['tags', '+extra'], home, root);
  assert.ok(on('skills/gamma') && isLink(J(home, '.qwen/skills/gamma')) && exists(J(home, '.qwen/agents/extra-agent.md')));
  // a hand move is kept as the user's own choice when the tags change again
  fs.renameSync(J(root, 'skills', 'beta'), J(root, 'skills-disabled', 'beta'));
  run(['tags', '-extra'], home, root);
  assert.ok(on('skills-disabled/beta') && on('skills-disabled/gamma'));
  assert.deepEqual(local(), { tags: ['web'], enabled: [], disabled: ['beta'] });
  run(['enable', 'beta'], home, root); // back where the tags put it: follows the tags again
  assert.deepEqual(local(), { tags: ['web'], enabled: [], disabled: [] });
  run(['enable', 'plain'], home, root); // one item without its tag
  assert.deepEqual(local(), { tags: ['web'], enabled: ['plain'], disabled: [] });
  assert.ok(exists(J(home, '.qwen/agents/plain.md')));
  run(['tags', 'recommended'], home, root);
  assert.deepEqual(local().tags, ['web', 'data']);
  run(['tags', 'all'], home, root);
  assert.ok(['skills/gamma', 'skills/beta', 'agents/extra-agent.md'].every(on));
  assert.equal(local().tags, 'all');
  run(['disable', 'web'], home, root); // from all: every tag but web
  assert.deepEqual(local().tags, ['data', 'extra']);
  assert.ok(on('skills-disabled/beta') && on('skills/delta') && on('agents-disabled/folded.md'), 'an item with another chosen tag stays on');
  assert.match(out(['status'], home, root), /^tags: data, extra$/m);
  const ls = out(['list', 'extra'], home, root);
  assert.match(ls, /\bgamma\b/);
  assert.match(ls, /\bextra-agent\b/);
  assert.doesNotMatch(ls, /\bbeta\b/);
  assert.match(run(['tags', 'bogus'], home, root, { status: 1 }).stderr, /unknown tag\(s\): bogus/);
  assert.match(run(['disable', 'core'], home, root, { status: 1 }).stderr, /core is always on/);
  assert.match(run(['enable', 'nope'], home, root, { status: 1 }).stderr, /unknown tag or item "nope"/);
  run(['uninstall'], home, root);
  assert.equal(tree(home), before);
});

test('first install asks for tags (Enter = recommended), asks again after a typo, and only once', () => {
  const root = makePack();
  const home = makeHome(['.claude']);
  const r = run([], home, root, { env: { AI_PACK_ASK: '1' }, input: 'bogus\n\n' });
  assert.match(r.stdout, /Which tags do you work with\?/);
  assert.match(r.stdout, /unknown tag\(s\): bogus/);
  assert.deepEqual(JSON.parse(read(J(root, '.ai-pack-local.json'))).tags, ['web', 'data']);
  assert.ok(exists(J(root, 'skills-disabled', 'gamma')) && !exists(J(home, '.claude/skills/gamma')) && isLink(J(home, '.claude/skills/beta')));
  assert.doesNotMatch(run([], home, root, { env: { AI_PACK_ASK: '1' } }).stdout, /Which tags/, 'chosen once: not asked again');
  // input closed without an answer: nothing is installed or moved
  const root2 = makePack();
  const home2 = makeHome(['.claude']);
  assert.match(run([], home2, root2, { env: { AI_PACK_ASK: '1' }, status: 1 }).stderr, /no answer/);
  assert.ok(!exists(J(home2, '.ai-pack')) && !exists(J(root2, '.ai-pack-local.json')) && exists(J(root2, 'skills', 'gamma')));
});

test('agent mode: one line after the rules in every delivery form, replaced in place, gone again, nothing for the default', () => {
  const root = makePack();
  const home = makeHome(['.claude', '.codex', '.gemini', '.codeium/windsurf/memories'], { '.gemini/settings.json': '{}\n' });
  const before = tree(home);
  const files = { claude: J(home, '.claude/rules/ai-pack.md'), codex: J(home, '.codex/AGENTS.md'), gemini: J(home, '.gemini/GEMINI.md'), windsurf: J(home, '.codeium/windsurf/memories/global_rules.md') };
  const lines = (f) => read(f).split('Agent mode:').length - 1;
  run(['--tags', 'web'], home, root);
  for (const f of Object.values(files)) assert.equal(lines(f), 0, `${f}: the default mode adds no line`);
  assert.match(out(['status'], home, root), /^agent mode: balanced \(up to 5 agents per task/m);

  assert.match(out(['mode', 'lean'], home, root), /agent mode: lean \(up to 3 agents per task\)/);
  for (const [name, f] of Object.entries(files)) {
    const t = read(f);
    assert.equal(lines(f), 1, `${name}: exactly one line`);
    assert.ok(t.trimEnd().endsWith('Agent mode: lean') || t.includes('Agent mode: lean\n<!-- ai-pack:end -->'), `${name}: it closes the rules`);
  }
  const claude = read(files.claude);
  assert.ok(claude.indexOf('Agent mode: lean') > claude.indexOf('The full rule set.'), 'after the rules text, so it overrides the default');
  assert.ok(read(files.windsurf).includes('The short rule set.'), 'the condensed rules carry it too');

  run(['mode', 'wide'], home, root); // replaced, not stacked
  for (const f of Object.values(files)) assert.ok(read(f).includes('Agent mode: wide') && !read(f).includes('Agent mode: lean') && lines(f) === 1, f);
  const menu = out(['mode'], home, root);
  assert.match(menu, /^ {2}wide +8 .*<- now$/m);
  assert.match(menu, /^ {2}solo +0 /m);

  run(['mode', 'balanced'], home, root);
  for (const f of Object.values(files)) assert.equal(lines(f), 0, `${f}: back to the default`);
  assert.equal(JSON.parse(read(J(root, '.ai-pack-local.json'))).agentMode, 'balanced');

  assert.match(run(['mode', 'turbo'], home, root, { status: 1 }).stderr, /unknown agent mode "turbo"/);
  assert.match(run(['mode', 'lean', 'wide'], home, root, { status: 1 }).stderr, /usage: node install\.mjs mode/);
  assert.match(run(['status', '--agent-mode', 'lean'], home, root, { status: 2 }).stderr, /--agent-mode belongs to install/);
  run(['mode', 'solo'], home, root);
  run(['uninstall'], home, root);
  assert.equal(tree(home), before, 'uninstall takes the line with the rest');
});

test('first install asks for the agent mode after the tags (Enter = balanced) and takes --agent-mode without asking', () => {
  const root = makePack();
  const home = makeHome(['.claude']);
  const r = run([], home, root, { env: { AI_PACK_ASK: '1' }, input: 'recommended\nlean\n' });
  assert.match(r.stdout, /Agent mode - how many subagents may one task use\?/);
  assert.equal(JSON.parse(read(J(root, '.ai-pack-local.json'))).agentMode, 'lean');
  assert.match(read(J(home, '.claude/rules/ai-pack.md')), /\n\nAgent mode: lean\n$/);
  assert.doesNotMatch(run([], home, root, { env: { AI_PACK_ASK: '1' } }).stdout, /Agent mode - how many/, 'asked once');

  // a bad answer asks again; input that ends after the tags keeps the default instead of aborting
  const root2 = makePack();
  const home2 = makeHome(['.claude']);
  const r2 = run([], home2, root2, { env: { AI_PACK_ASK: '1' }, input: 'recommended\nturbo\n' });
  assert.match(r2.stdout, /unknown mode "turbo"/);
  assert.equal(JSON.parse(read(J(root2, '.ai-pack-local.json'))).agentMode, 'balanced');
  assert.doesNotMatch(read(J(home2, '.claude/rules/ai-pack.md')), /Agent mode:/);
  const home3 = makeHome(['.claude']);
  const root3 = makePack();
  run([], home3, root3, { env: { AI_PACK_ASK: '1' }, input: 'recommended\n' });
  assert.equal(JSON.parse(read(J(root3, '.ai-pack-local.json'))).agentMode, 'balanced');

  // scripts answer it with the flag
  const root4 = makePack();
  const home4 = makeHome(['.claude']);
  run(['--tags', 'web', '--agent-mode', 'wide'], home4, root4);
  assert.match(read(J(home4, '.claude/rules/ai-pack.md')), /Agent mode: wide/);
  assert.match(run(['--agent-mode', 'turbo'], makeHome(['.claude']), makePack(), { status: 1 }).stderr, /unknown agent mode/);
});

test('the agent modes say the same numbers in the installer and in the rules text', () => {
  const caps = { solo: 0, lean: 3, balanced: 5, wide: 8 };
  const rules = read(J(PACK, 'rules', 'global-work-rules.md'));
  const menu = out(['mode'], makeHome()); // the pack's own installer, read-only
  for (const [m, n] of Object.entries(caps)) {
    assert.match(rules, new RegExp(`\\|\\s*\`${m}\`[^|]*\\|\\s*${n}\\s*\\|`), `${m} = ${n} in the rules table`);
    assert.match(menu, new RegExp(`^ {2}${m} +${n} `, 'm'), `${m} = ${n} in the installer`);
  }
  assert.match(read(J(PACK, 'rules', 'global-work-rules.min.md')), /solo 0, lean 3, balanced 5/);
  assert.match(rules, /The default mode is `balanced`/);
});
