// Bundles index.html + src/*.js + src/styles.css into one self-contained
// page fragment (dist/silicon-transit.html) for publishing as an artifact.
// Each ES module becomes a function scope; imports become destructuring.
// Run: node tools/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const modules = new Map();
const order = [];

function modId(file) {
  return '__m_' + basename(file, '.js').replace(/[^A-Za-z0-9_]/g, '_');
}

function load(file) {
  if (modules.has(file)) return;
  const src = readFileSync(file, 'utf8');
  const imports = [];
  const body = src.replace(/import\s*\{([^}]*)\}\s*from\s*['"](.+?)['"];?/gs, (_, names, from) => {
    const dep = resolve(dirname(file), from);
    imports.push(dep);
    const binds = names
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => {
        const m = n.match(/^(\w+)\s+as\s+(\w+)$/);
        return m ? `${m[1]}: ${m[2]}` : n;
      });
    return `const { ${binds.join(', ')} } = ${modId(dep)};`;
  });
  if (/^\s*import\s/m.test(body)) throw new Error(`Unsupported import form in ${file}`);
  const exports = new Set();
  let out = body.replace(/^export\s+(async\s+function|function|class|const|let)\s+(\w+)/gm, (_, kind, name) => {
    exports.add(name);
    return `${kind} ${name}`;
  });
  out = out.replace(/^export\s*\{([^}]*)\};?/gm, (_, names) => {
    for (const n of names.split(',').map((x) => x.trim()).filter(Boolean)) exports.add(n);
    return '';
  });
  if (/^export\s/m.test(out)) throw new Error(`Unsupported export form in ${file}`);
  modules.set(file, { imports, out, exports: [...exports] });
  for (const dep of imports) load(dep);
  order.push(file);
}

const entry = resolve(root, 'src/main.js');
load(entry);
// `order` is a post-order walk: every module appears after its imports.
const seen = new Set();
const sorted = [];
for (const f of order) {
  if (!seen.has(f)) {
    seen.add(f);
    sorted.push(f);
  }
}
let bundle = '"use strict";\n';
for (const f of sorted) {
  const m = modules.get(f);
  bundle += `\n// ---- ${basename(f)}\nconst ${modId(f)} = (() => {\n${m.out.trim()}\n${m.exports.length ? `return { ${m.exports.join(', ')} };` : ''}\n})();\n`;
}
bundle = `(() => {\n${bundle}\n})();`;
if (bundle.includes('</script')) throw new Error('bundle contains </script');

const html = read('index.html');
const part = (name) => {
  const a = html.indexOf(`<!-- ${name}:START -->`);
  const b = html.indexOf(`<!-- ${name}:END -->`);
  if (a < 0 || b < 0) throw new Error(`missing ${name} markers`);
  return html.slice(a + `<!-- ${name}:START -->`.length, b).trim();
};
const css = read('src/styles.css');
let head = part('HEAD').replace('<link rel="stylesheet" href="src/styles.css">', () => `<style>\n${css}\n</style>`);
let body = part('BODY').replace('<script type="module" src="src/main.js"></script>', () => `<script>\n${bundle}\n</script>`);
if (head.includes('src/styles.css') || body.includes('src/main.js')) throw new Error('asset replacement failed');

mkdirSync(join(root, 'dist'), { recursive: true });
const fragment = `${head}\n${body}\n`;
writeFileSync(join(root, 'dist/silicon-transit.html'), fragment);
// A standalone copy that opens directly in a browser.
writeFileSync(
  join(root, 'dist/standalone.html'),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
);
console.log(`dist/silicon-transit.html  ${(fragment.length / 1024).toFixed(1)} KB, ${sorted.length} modules`);
