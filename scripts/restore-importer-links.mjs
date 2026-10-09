#!/usr/bin/env node
/**
 * One-off repair: restore packages/<pkg>/node_modules symlinks from pnpm-lock.yaml
 * importers section after an interrupted `pnpm install` (EPERM on locked
 * better-sqlite3 held by the running API server).
 *
 * The .pnpm virtual store is intact; only the importer link layer was wiped.
 * This script rebuilds that layer from the lockfile. Fully idempotent and
 * superseded by a normal `pnpm install` at the next service-restart window.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/SourceCode/clowder-ai';
const lines = fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n').split('\n');

// --- Parse importers section -------------------------------------------------
const importers = {}; // { 'packages/api': { dependencies: { name: {specifier, version} }, devDependencies: {...} } }
{
  let curImporter = null;
  let curSection = null;
  let curDep = null;
  let inImporters = false;
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) { inImporters = true; continue; }
    if (inImporters && /^\S/.test(line)) break; // next top-level key (packages:)
    if (!inImporters) continue;
    let m;
    if ((m = line.match(/^  ('[^']+'|[^:\s]+):\s*$/))) {
      curImporter = m[1].replace(/^'|'$/g, '');
      importers[curImporter] = {};
      curSection = null; curDep = null;
    } else if (curImporter && (m = line.match(/^    (dependencies|devDependencies|optionalDependencies):\s*$/))) {
      curSection = m[1];
      importers[curImporter][curSection] = {};
      curDep = null;
    } else if (curSection && (m = line.match(/^      ('[^']+'|[^:\s]+):\s*$/))) {
      curDep = m[1].replace(/^'|'$/g, '');
      importers[curImporter][curSection][curDep] = {};
    } else if (curDep && (m = line.match(/^        (specifier|version): (.+)$/))) {
      let v = m[2].trim();
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      importers[curImporter][curSection][curDep][m[1]] = v;
    }
  }
}

// --- Parse packages section (name@version -> .pnpm dir candidate list) ------
const packageKeys = [];
{
  let inPkgs = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPkgs = true; continue; }
    if (inPkgs && /^\S/.test(line)) break;
    if (!inPkgs) continue;
    const m = line.match(/^  ('[^']+'|[^:\s][^:]*):\s*$/);
    if (m) packageKeys.push(m[1].replace(/^'|'$/g, ''));
  }
}

// Map: base name@version -> dir names in .pnpm
const PNPM_DIR = path.join(ROOT, 'node_modules/.pnpm');
const dirList = fs.readdirSync(PNPM_DIR).filter((d) => !d.startsWith('.'));
const baseToDirs = new Map();
for (const d of dirList) {
  // dir like @scope+name@1.2.3 or @scope+name@1.2.3_peer@1.0.0 — find the
  // first '@' that starts the version (after the final '/'→'+' name segment).
  // Robust approach: strip trailing peer suffix by scanning from the right
  // for '_<name>@<ver>' segments is fragile; instead index full dir names and
  // match with prefix generated from package keys.
  // (handled below via packageKeys)
  void d;
}
function keyToDirBase(key) {
  // '@scope/name@1.2.3(peer@1)' -> '@scope+name@1.2.3' (peer suffix appended separately)
  const parenAt = key.indexOf('(');
  let base = parenAt >= 0 ? key.slice(0, parenAt) : key;
  let peer = parenAt >= 0 ? key.slice(parenAt + 1, -1) : '';
  base = base.replace(/\//g, '+');
  peer = peer.replace(/\//g, '+').replace(/,/g, '_');
  return peer ? `${base}_${peer}` : base;
}
for (const key of packageKeys) {
  const dir = keyToDirBase(key);
  const at = dir.lastIndexOf('@');
  if (at <= 0) continue;
  const base = dir.slice(0, at);
  const ver = dir.slice(at + 1);
  const k = `${base}@${ver}`;
  if (!baseToDirs.has(k)) baseToDirs.set(k, []);
  baseToDirs.get(k).push(dir);
}

// --- Rebuild links ------------------------------------------------------------
const created = { links: 0, skipped: 0, missing: [], wsLinks: 0 };
function symlinkForce(target, linkPath) {
  try { fs.lstatSync(linkPath); created.skipped++; return true; } catch { /* absent — proceed */ }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(target, linkPath, 'junction');
    created.links++;
    return true;
  } catch (err) {
    created.missing.push(`${linkPath} -> ${target} (${err.code})`);
    return false;
  }
}

for (const [importerPath, sections] of Object.entries(importers)) {
  const importerNodeModules = path.join(ROOT, importerPath, 'node_modules');
  for (const [section, deps] of Object.entries(sections)) {
    for (const [name, info] of Object.entries(deps)) {
      if (!info?.version) continue;
      const linkPath = path.join(importerNodeModules, ...name.split('/'));
      if (info.version.startsWith('link:')) {
        // workspace link, target relative to importer's node_modules
        const targetRel = path.relative(path.dirname(linkPath), path.join(ROOT, importerPath, info.version.slice(5)));
        symlinkForce(targetRel, linkPath) && (created.wsLinks++);
        continue;
      }
      // registry dep: name@version -> .pnpm dir
      // version may carry a peer suffix like '2.6.1(@opentelemetry/api@1.9.1)' — strip it
      const versionBase = info.version.replace(/\(.*\)$/, '');
      const dirBase = `${name.replace(/\//g, '+')}@${versionBase}`;
      let dirs = baseToDirs.get(dirBase) ?? [];
      if (dirs.length === 0) {
        // fallback: prefix scan (peer-suffixed variants)
        dirs = dirList.filter((d) => d.startsWith(dirBase));
      }
      if (dirs.length === 0) { created.missing.push(`${importerPath} :: ${name}@${info.version} — no .pnpm dir`); continue; }
      // prefer the shortest (least peer-suffixed) variant that actually has content
      const ordered = dirs.sort((a, b) => a.length - b.length);
      let dir = null;
      let realDir = null;
      for (const cand of ordered) {
        const rd = path.join(PNPM_DIR, cand, 'node_modules', ...name.split('/'));
        if (fs.existsSync(rd)) { dir = cand; realDir = rd; break; }
      }
      if (!realDir) {
        // fall back to the shortest for the missing-report
        dir = ordered[0];
        realDir = path.join(PNPM_DIR, dir, 'node_modules', ...name.split('/'));
        created.missing.push(`${importerPath} :: ${name} — store target absent: ${realDir}`);
        continue;
      }
      const targetRel = path.relative(path.dirname(linkPath), realDir);
      symlinkForce(targetRel, linkPath);
    }
  }
}

console.log(JSON.stringify({
  importers: Object.keys(importers).length,
  packageKeys: packageKeys.length,
  ...created,
  missingCount: created.missing.length,
}, null, 2));
if (created.missing.length) console.log('MISSING SAMPLE:\n' + created.missing.slice(0, 30).join('\n'));
