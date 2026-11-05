import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadBrowserScript(rel, extra = {}) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  const store = {};
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    Blob: class {},
    ReadableStream,
    Response,
    ...extra,
  };
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.__store = store;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const modelBox = loadBrowserScript('public/model.js');
const previewBox = loadBrowserScript('public/preview.js');
const Model = modelBox.Model;
const Preview = previewBox.Preview;

assert.ok(Model, 'Model yüklendi');
assert.ok(Preview, 'Preview yüklendi');
assert.strictEqual(Model.DEFAULT_MODEL, 'gemini-3.8-flash');

// --- parseFiles ---
{
  const text = `
Açıklama
\`\`\`html file=index.html
<!DOCTYPE html><html><body>Hi</body></html>
\`\`\`
\`\`\`css file=style.css
body{color:red}
\`\`\`
\`\`\`javascript
// script.js
console.log(1)
\`\`\`
`;
  const files = Model.parseFiles(text);
  assert.ok(files['index.html'].includes('Hi'), 'index.html');
  assert.strictEqual(files['style.css'], 'body{color:red}');
  assert.ok(files['script.js'].includes('console.log(1)'), 'script.js first-line');
}

{
  const lone = '```html\n<html><body>Lone</body></html>\n```';
  const f = Model.parseFiles(lone);
  assert.strictEqual(f['index.html'], '<html><body>Lone</body></html>');
}

{
  const slash = '```\n// app.js\nexport default 1\n```';
  const f = Model.parseFiles(slash);
  assert.ok(f['app.js'] && f['app.js'].includes('export default 1'));
}

// --- Preview inlining ---
{
  const files = {
    'index.html':
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head>' +
      '<body><h1>X</h1><script src="script.js"></script></body></html>',
    'style.css': 'h1{color:blue}',
    'script.js': 'console.log("ok")',
  };
  const doc = Preview.buildSrcdoc(files);
  assert.ok(doc.includes('data-inlined-from="style.css"'));
  assert.ok(doc.includes('h1{color:blue}'));
  assert.ok(doc.includes('data-inlined-from="script.js"'));
  assert.ok(doc.includes('console.log("ok")'));
  assert.ok(!/<link[^>]*href=["']style\.css["']/.test(doc));
  assert.ok(doc.includes('kod-asistani-preview'));
}

{
  const files = {
    'index.html': '<!DOCTYPE html><html><head></head><body><p>y</p></body></html>',
    'style.css': '.a{}',
    'script.js': 'var a=1',
  };
  const doc = Preview.buildSrcdoc(files);
  assert.ok(doc.includes('data-inlined-from="style.css"'));
  assert.ok(doc.includes('data-inlined-from="script.js"'));
}

{
  const zip = Preview.buildZip({ 'a.txt': 'hello', 'b/c.txt': 'world' });
  assert.ok(zip instanceof Uint8Array);
  assert.ok(zip.length > 30);
  assert.strictEqual(zip[0], 0x50);
  assert.strictEqual(zip[1], 0x4b);
  assert.strictEqual(zip[2], 0x03);
  assert.strictEqual(zip[3], 0x04);
}

// --- chat with mocked fetch (SSE) ---
{
  const chunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Merhaba "}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"dünya"}]}}]}\n\n',
  ];
  let i = 0;
  const encoder = new TextEncoder();
  modelBox.fetch = async () => {
    const stream = new ReadableStream({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i++]));
      },
    });
    return new Response(stream, { status: 200 });
  };

  Model.setKey('test-key');
  assert.strictEqual(Model.getKey(), 'test-key');

  const seen = [];
  const full = await Model.chat([{ role: 'user', content: 'hi' }], (soFar, delta) => {
    seen.push([soFar, delta]);
  });
  assert.strictEqual(full, 'Merhaba dünya');
  assert.ok(seen.length >= 2);
  assert.strictEqual(seen[seen.length - 1][0], 'Merhaba dünya');
}

// no key
{
  Model.setKey('');
  let threw = null;
  try {
    await Model.chat([{ role: 'user', content: 'x' }]);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw);
  assert.strictEqual(threw.code, 'no_key');
  assert.ok(/anahtar/i.test(threw.message));
}

// 429
{
  Model.setKey('k');
  modelBox.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
  let threw = null;
  try {
    await Model.chat([{ role: 'user', content: 'x' }]);
  } catch (e) {
    threw = e;
  }
  assert.strictEqual(threw.code, 'quota');
  assert.ok(threw.message.includes('Günlük/dakikalık ücretsiz kota doldu'));
}

// 403
{
  Model.setKey('bad');
  modelBox.fetch = async () => new Response('denied', { status: 403 });
  let threw = null;
  try {
    await Model.chat([{ role: 'user', content: 'x' }]);
  } catch (e) {
    threw = e;
  }
  assert.strictEqual(threw.code, 'invalid_key');
}

console.log('UNIT OK: parseFiles, Preview inlining/zip, Model.chat mock SSE');
