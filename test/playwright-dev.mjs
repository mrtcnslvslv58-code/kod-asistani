import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/dev.html';
      const filePath = path.join(publicDir, urlPath.replace(/^\//, ''));
      if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, pid: process.pid });
    });
  });
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
console.log('SERVER', base, 'pid', process.pid);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (msg) => consoleLines.push(msg.text()));

await page.goto(`${base}/dev.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.Model && window.Preview);

const result = await page.evaluate(async () => {
  const files = {
    'index.html':
      '<!DOCTYPE html><html><head><meta charset="utf-8"/><link rel="stylesheet" href="style.css"/></head>' +
      '<body><h1 id="n">0</h1><button id="b">Artır</button><script src="script.js"></script></body></html>',
    'style.css': 'body{font-family:sans-serif}#n{color:green}',
    'script.js':
      'var n=0;document.getElementById("b").onclick=function(){n++;document.getElementById("n").textContent=String(n);console.log("sayac",n)};console.log("hazir");',
  };

  // parseFiles round-trip
  const fenced =
    '```html file=index.html\n' +
    files['index.html'] +
    '\n```\n```css file=style.css\n' +
    files['style.css'] +
    '\n```\n```js file=script.js\n' +
    files['script.js'] +
    '\n```';
  const parsed = Model.parseFiles(fenced);
  if (!parsed['index.html'] || !parsed['style.css'] || !parsed['script.js']) {
    return { ok: false, error: 'parseFiles eksik', keys: Object.keys(parsed) };
  }

  Preview.render(parsed, document.getElementById('frame'));
  document.getElementById('answer').textContent = fenced;

  // wait for iframe srcdoc load + console
  await new Promise((r) => setTimeout(r, 500));

  const frame = document.getElementById('frame');
  const srcdoc = frame.srcdoc || '';
  const inlined =
    srcdoc.includes('data-inlined-from="style.css"') &&
    srcdoc.includes('data-inlined-from="script.js"') &&
    srcdoc.includes('color:green');

  const sandbox = frame.getAttribute('sandbox') || '';
  const sandboxOk =
    sandbox.includes('allow-scripts') &&
    sandbox.includes('allow-forms') &&
    sandbox.includes('allow-modals') &&
    !sandbox.includes('allow-same-origin');

  return {
    ok: inlined && sandboxOk,
    inlined,
    sandbox,
    sandboxOk,
    srcdocLen: srcdoc.length,
  };
});

if (!result.ok) {
  console.error('PLAYWRIGHT FAIL', result);
  await browser.close();
  server.close();
  process.exit(1);
}

// Interact inside iframe via frame locator — srcdoc iframe may need contentFrame
const frameEl = page.frameLocator('#frame');
await frameEl.locator('#b').click();
await page.waitForTimeout(300);
const countText = await frameEl.locator('#n').innerText();

// console panel should have received postMessage
const consoleText = await page.locator('#consoleOut').innerText();

const pass = countText.trim() === '1' && /hazir|sayac/i.test(consoleText);
console.log('IFRAME_COUNT', countText);
console.log('CONSOLE_PANEL', JSON.stringify(consoleText));
console.log(pass ? 'PLAYWRIGHT OK' : 'PLAYWRIGHT PARTIAL');

await browser.close();
server.close();
process.exit(pass ? 0 : 1);
