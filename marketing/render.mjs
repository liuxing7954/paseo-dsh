#!/usr/bin/env node
/**
 * Render the marketing cards with headless Chrome.
 *
 *   node marketing/render.mjs                 # all cards + README hero
 *   node marketing/render.mjs --only cover    # one card (repeatable)
 *   node marketing/render.mjs --list          # list scene ids
 *
 * Outputs:
 *   docs/assets/social/<nn>-<scene>.png   1080x1440 (3:4, Xiaohongshu)
 *   docs/assets/hero.png                  1600x900  (README)
 *
 * No dependencies beyond Chrome. On macOS Chrome is found by default; elsewhere
 * point CHROME_PATH at the binary.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const poster = join(here, 'poster.html');
const outDir = join(repo, 'docs', 'assets', 'social');
const heroPath = join(repo, 'docs', 'assets', 'hero.png');

const SOCIAL = [
  ['01', 'cover', '封面：DeepSeek Harness 接进 Paseo'],
  ['02', 'questions', '原生提问卡片'],
  ['03', 'plan', 'Build / Plan 模式'],
  ['04', 'streaming', '流式输出'],
  ['05', 'attachments', '附件与图片'],
  ['06', 'thinking', '真实思考档位'],
  ['07', 'expert', 'DSH standard 专家模式'],
  ['08', 'doctor', 'doctor 自检'],
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      'Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.',
    );
  }
  return hit;
}

function run(bin, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${bin} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function render(scene, width, height, out) {
  const chrome = findChrome();
  const url = `${pathToFileURL(poster).href}?scene=${scene}`;
  const profile = join(here, '.chrome-profile');
  await mkdir(profile, { recursive: true });
  await mkdir(dirname(out), { recursive: true });
  await rm(out, { force: true });

  await run(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--virtual-time-budget=1500',
    `--screenshot=${out}`,
    url,
  ]);

  const size = pngSize(await readFile(out));
  if (!size || size.width !== width || size.height !== height) {
    throw new Error(
      `unexpected size for ${scene}: ${size ? `${size.width}x${size.height}` : 'not a png'} (wanted ${width}x${height})`,
    );
  }
  return size;
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [no, scene, label] of SOCIAL) console.log(`${no}  ${scene.padEnd(12)} ${label}`);
  console.log('--  hero         1600x900 README hero');
  process.exit(0);
}

const only = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--only') only.push(args[++i]);
}
const wanted = (scene) => only.length === 0 || only.includes(scene);

await mkdir(outDir, { recursive: true });
let n = 0;
for (const [no, scene, label] of SOCIAL) {
  if (!wanted(scene)) continue;
  const out = join(outDir, `${no}-${scene}.png`);
  const size = await render(scene, 1080, 1440, out);
  console.log(`✓ ${label}  ${size.width}x${size.height}  ${out}`);
  n += 1;
}
if (wanted('hero')) {
  const size = await render('hero', 1600, 900, heroPath);
  console.log(`✓ README hero  ${size.width}x${size.height}  ${heroPath}`);
  n += 1;
}
console.log(`\n${n} image(s) rendered.`);
