import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const plain = (x) => JSON.parse(JSON.stringify(x));

function createBox(initial = {}) {
  const store = { ...initial };
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    Blob: class {},
    ReadableStream,
    Response,
    AbortController,
    JSON,
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
  for (const f of ['model.js', 'generate.js', 'workspace.js', 'tools.js', 'agent.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'public', f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

const enc = new TextEncoder();
function sse(events) {
  const chunks = events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n');
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i >= chunks.length) return c.close();
        c.enqueue(enc.encode(chunks[i++]));
      },
    }),
    { status: 200 }
  );
}
const cand = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, ...extra }] });

// ---------- Workspace ----------
{
  const b = createBox();
  const W = b.Workspace;
  assert.deepStrictEqual(plain(W.list()), []);
  W.set('index.html', '<p>x</p>');
  W.set('./css/style.css', 'a{}');
  assert.deepStrictEqual(plain(W.list()), ['css/style.css', 'index.html']);
  assert.throws(() => W.set('../etc/passwd', 'x'), /Geçersiz/);
  assert.throws(() => W.set('', 'x'), /Geçersiz/);
  assert.throws(() => W.set('a//b/../c', 'x'), /Geçersiz/);
  assert.strictEqual(W.get('index.html'), '<p>x</p>');
  assert.strictEqual(W.get('yok.txt'), null);
  assert.ok(W.remove('index.html'));
  assert.ok(!W.remove('index.html'));
  // kalıcılık: aynı depoyu paylaşan yeni kutu dosyaları geri okur
  const b2 = createBox({ 'kodasistan.files': JSON.stringify({ 'x.txt': 'kalıcı' }) });
  assert.strictEqual(b2.Workspace.get('x.txt'), 'kalıcı');
  // bozuk depo → boş başlar, çökmez
  assert.deepStrictEqual(plain(createBox({ 'kodasistan.files': '{bozuk' }).Workspace.list()), []);
  // eski tek-editör sürümünden geçiş
  const b3 = createBox({ 'kodasistan.code': '<h1>eski</h1>' });
  assert.strictEqual(b3.Workspace.get('index.html'), '<h1>eski</h1>');
}

// ---------- Tools ----------
{
  const b = createBox();
  const T = b.Tools;
  assert.strictEqual(T.run('write_file', { path: 'index.html', content: 'merhaba dünya' }).ok, true);
  assert.strictEqual(T.run('read_file', { path: 'index.html' }).content, 'merhaba dünya');
  assert.strictEqual(T.run('read_file', { path: 'yok.html' }).ok, false);
  // edit_file
  assert.strictEqual(T.run('edit_file', { path: 'index.html', old_text: 'dünya', new_text: 'Türkiye' }).ok, true);
  assert.strictEqual(b.Workspace.get('index.html'), 'merhaba Türkiye');
  assert.ok(/bulunamadı/.test(T.run('edit_file', { path: 'index.html', old_text: 'yoktur', new_text: 'x' }).error));
  T.run('write_file', { path: 'a.txt', content: 'x x' });
  assert.ok(/2 kez/.test(T.run('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' }).error));
  assert.strictEqual(T.run('edit_file', { path: 'a.txt', old_text: '', new_text: 'y' }).ok, false);
  // hatalı argüman fırlatmaz
  assert.strictEqual(T.run('write_file', { path: 5, content: 'x' }).ok, false);
  assert.strictEqual(T.run('write_file', {}).ok, false);
  assert.strictEqual(T.run('bilinmeyen', {}).ok, false);
  assert.strictEqual(T.run('write_file', { path: '../x', content: 'y' }).ok, false);
  // uzun dosya kısaltılarak okunur
  T.run('write_file', { path: 'big.txt', content: 'a'.repeat(30000) });
  const big = T.run('read_file', { path: 'big.txt' });
  assert.strictEqual(big.truncated, true);
  assert.strictEqual(big.content.length, 12000);
  assert.strictEqual(big.total_chars, 30000);
  // list / delete
  assert.strictEqual(T.run('list_files', {}).count, 3);
  assert.strictEqual(T.run('delete_file', { path: 'big.txt' }).ok, true);
  assert.strictEqual(T.run('delete_file', { path: 'big.txt' }).ok, false);
  // konsol
  T.pushConsole({ level: 'error', message: 'ReferenceError: x is not defined' });
  const con = T.run('get_console', {});
  assert.strictEqual(con.count, 1);
  assert.strictEqual(con.entries[0].level, 'error');
  // hafıza
  assert.strictEqual(T.run('remember', { note: 'Koyu tema sever' }).ok, true);
  T.run('remember', { note: 'Koyu tema sever' });
  assert.deepStrictEqual(plain(T.getMemory()), ['Koyu tema sever']);
  T.removeMemory(0);
  assert.deepStrictEqual(plain(T.getMemory()), []);
  // bildirimler şemaya uygun
  for (const d of T.declarations) {
    assert.ok(d.name && d.description && d.parameters.type === 'object', d.name);
  }
}

// ---------- Model.generate: akış, birleştirme, imza ----------
{
  const b = createBox();
  b.Model.setKey('k');
  b.fetch = async () =>
    sse([
      cand([{ text: 'Mer' }]),
      cand([{ text: 'haba', thoughtSignature: 'SIG1' }]),
      cand([{ functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'SIG2' }], { finishReason: 'STOP' }),
    ]);
  const seen = [];
  const r = await b.Model.generate([{ role: 'user', parts: [{ text: 'x' }] }], {
    onParts: (p) => seen.push(p.length),
  });
  assert.strictEqual(r.text, 'Merhaba');
  assert.strictEqual(r.parts.length, 2);
  assert.strictEqual(r.parts[0].thoughtSignature, 'SIG1');
  assert.strictEqual(r.parts[1].thoughtSignature, 'SIG2');
  assert.strictEqual(r.parts[1].functionCall.name, 'list_files');
  assert.ok(seen.length >= 3);
}

// ---------- Model.generate: hata kodları ----------
{
  const b = createBox();
  b.Model.setKey('k');
  const tools = b.Tools.declarations;
  const msgs = [{ role: 'user', parts: [{ text: 'x' }] }];

  b.fetch = async () => new Response('{"error":{"message":"API key not valid"}}', { status: 400 });
  await assert.rejects(() => b.Model.generate(msgs, { tools }), (e) => e.code === 'invalid_key');

  b.fetch = async () => new Response('{"error":{"message":"Invalid function declaration schema"}}', { status: 400 });
  await assert.rejects(() => b.Model.generate(msgs, { tools }), (e) => e.code === 'tools_unsupported');

  // 503 → sıradaki modele düşer
  const urls = [];
  b.fetch = async (url) => {
    urls.push(url);
    return urls.length < 3 ? new Response('busy', { status: 503 }) : sse([cand([{ text: 'ok' }])]);
  };
  const r = await b.Model.generate(msgs, {});
  assert.strictEqual(r.text, 'ok');
  assert.strictEqual(urls.length, 3);
  assert.notStrictEqual(urls[0], urls[2]);

  // güvenlik filtresi
  b.fetch = async () => sse([{ promptFeedback: { blockReason: 'SAFETY' } }]);
  await assert.rejects(() => b.Model.generate(msgs, {}), (e) => e.code === 'blocked');

  b.Model.setKey('');
  await assert.rejects(() => b.Model.generate(msgs, {}), (e) => e.code === 'no_key');
}

// ---------- Agent: araç döngüsü ----------
{
  const b = createBox();
  b.Model.setKey('k');
  const requests = [];
  const script = [
    // 1. tur: dosya yaz
    () =>
      sse([
        cand([{ text: 'Sayfayı yazıyorum.' }]),
        cand([
          {
            functionCall: { name: 'write_file', args: { path: 'index.html', content: '<h1>Merhaba</h1>' } },
            thoughtSignature: 'SIGX',
          },
        ]),
      ]),
    // 2. tur: konsolu kontrol et
    () => sse([cand([{ functionCall: { name: 'get_console', args: {} } }])]),
    // 3. tur: bitir
    () => sse([cand([{ text: 'Hazır: index.html oluşturuldu.' }])]),
  ];
  b.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return script[requests.length - 1]();
  };

  const contents = [{ role: 'user', parts: [{ text: 'Merhaba sayfası yap' }] }];
  let turns = 0;
  const lives = [];
  await b.Agent.run(contents, { onTurn: () => turns++, onLive: (p) => lives.push(p) });

  assert.strictEqual(b.Workspace.get('index.html'), '<h1>Merhaba</h1>');
  assert.strictEqual(requests.length, 3);
  assert.deepStrictEqual(
    contents.map((c) => c.role),
    ['user', 'model', 'user', 'model', 'user', 'model']
  );
  // araç sonucu doğru biçimde geri gönderildi
  const fr = contents[2].parts[0].functionResponse;
  assert.strictEqual(fr.name, 'write_file');
  assert.strictEqual(fr.response.ok, true);
  // imza ikinci istekte olduğu gibi geri gitti
  const sentModelTurn = requests[1].contents.find((c) => c.role === 'model');
  assert.ok(sentModelTurn.parts.some((p) => p.thoughtSignature === 'SIGX'), 'thoughtSignature korunmalı');
  // istekte sistem talimatı + araçlar var
  assert.ok(requests[0].systemInstruction.parts[0].text.includes('KodAsistan'));
  assert.ok(requests[0].tools[0].functionDeclarations.length >= 6);
  // son tur metin
  assert.ok(contents[5].parts[0].text.includes('Hazır'));
  assert.strictEqual(turns, 5);
  assert.strictEqual(lives[lives.length - 1], null);
}

// ---------- Agent: sistem talimatına özel talimat + hafıza + dosyalar girer ----------
{
  const b = createBox();
  b.Agent.setInstructions('Hep kısa yaz.');
  b.Tools.setMemory(['Mavi renk sever']);
  b.Workspace.set('a.html', 'x');
  const sys = b.Agent.buildSystem(true);
  assert.ok(sys.includes('Hep kısa yaz.'));
  assert.ok(sys.includes('Mavi renk sever'));
  assert.ok(sys.includes('a.html'));
  assert.ok(!b.Agent.buildSystem(false).includes('PROJE DOSYALARI'));
}

// ---------- Agent: araç desteklenmiyorsa metin moduna düşer ----------
{
  const b = createBox();
  b.Model.setKey('k');
  let n = 0;
  const notices = [];
  b.fetch = async (url, init) => {
    n++;
    const body = JSON.parse(init.body);
    if (body.tools) return new Response('{"error":{"message":"function calling is not supported"}}', { status: 400 });
    return sse([cand([{ text: 'Al:\n```html\n<p>metin modu</p>\n```' }])]);
  };
  const contents = [{ role: 'user', parts: [{ text: 'yap' }] }];
  await b.Agent.run(contents, { onNotice: (m) => notices.push(m) });
  assert.strictEqual(n, 2);
  assert.strictEqual(b.Workspace.get('index.html'), '<p>metin modu</p>');
  assert.ok(notices[0].includes('metin moduna'));
  assert.strictEqual(contents.length, 2);
}

// ---------- Agent: iptal + repair ----------
{
  const b = createBox();
  b.Model.setKey('k');
  const ctrl = new AbortController();
  ctrl.abort();
  const contents = [{ role: 'user', parts: [{ text: 'x' }] }];
  await assert.rejects(() => b.Agent.run(contents, { signal: ctrl.signal }), (e) => e.name === 'AbortError');

  const dangling = [
    { role: 'user', parts: [{ text: 'x' }] },
    { role: 'model', parts: [{ functionCall: { name: 'list_files', args: {} } }] },
  ];
  assert.ok(b.Agent.repair(dangling));
  assert.strictEqual(dangling[2].parts[0].functionResponse.name, 'list_files');
  assert.strictEqual(b.Agent.repair(dangling), false);
}

// ---------- Agent: adım sınırı ----------
{
  const b = createBox();
  b.Model.setKey('k');
  let n = 0;
  b.fetch = async () => {
    n++;
    return sse([cand([{ functionCall: { name: 'list_files', args: {} } }])]);
  };
  const notices = [];
  await b.Agent.run([{ role: 'user', parts: [{ text: 'sonsuz' }] }], { onNotice: (m) => notices.push(m) });
  assert.strictEqual(n, b.Agent.MAX_STEPS);
  assert.ok(notices[0].includes('Adım sınırı'));
}

// ---------- windowContents: yetim functionResponse bırakmaz ----------
{
  const b = createBox();
  const list = [];
  for (let i = 0; i < 30; i++) {
    list.push({ role: 'user', parts: [{ text: 'soru ' + i }] });
    list.push({ role: 'model', parts: [{ functionCall: { name: 'list_files', args: {} } }] });
    list.push({ role: 'user', parts: [{ functionResponse: { name: 'list_files', response: { ok: true } } }] });
    list.push({ role: 'model', parts: [{ text: 'cevap ' + i }] });
  }
  const w = b.Agent.windowContents(list);
  assert.ok(w.length <= 40);
  assert.strictEqual(w[0].role, 'user');
  assert.ok(typeof w[0].parts[0].text === 'string', 'pencere kullanıcı metniyle başlamalı');
}

// ---------- app.js DOM duman testi: Ayarlar aç/kaydet + mesaj gönder ----------
{
  function makeEl(id = '') {
    const listeners = {};
    const attrs = {};
    const classes = new Set();
    return {
      id,
      value: '',
      checked: true,
      disabled: false,
      hidden: false,
      innerHTML: '',
      textContent: '',
      placeholder: '',
      srcdoc: '',
      scrollTop: 0,
      scrollHeight: 100,
      style: {},
      children: [],
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, f) => {
          if (f === undefined) f = !classes.has(c);
          f ? classes.add(c) : classes.delete(c);
          return f;
        },
        contains: (c) => classes.has(c),
      },
      setAttribute: (k, v) => {
        attrs[k] = String(v);
      },
      getAttribute: (k) => attrs[k] || null,
      removeAttribute: (k) => {
        delete attrs[k];
      },
      appendChild(ch) {
        this.children.push(ch);
        return ch;
      },
      remove() {},
      focus() {},
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
      querySelectorAll: () => [],
      addEventListener(ev, fn) {
        (listeners[ev] = listeners[ev] || []).push(fn);
      },
      dispatch(ev, e = {}) {
        (listeners[ev] || []).forEach((fn) => fn({ preventDefault() {}, target: this, ...e }));
      },
    };
  }

  const els = {};
  const getEl = (sel) => {
    const k = sel.replace(/^#/, '');
    return (els[k] = els[k] || makeEl(k));
  };
  const store = {};
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    AbortController,
    ReadableStream,
    Response,
    setTimeout,
    prompt: () => 'test.html',
    confirm: () => true,
    alert: () => {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
    document: {
      activeElement: null,
      querySelector: (s) => getEl(s),
      querySelectorAll: () => [makeEl('tab1'), makeEl('tab2')],
      createElement: (tag) => makeEl(tag),
      body: makeEl('body'),
    },
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const f of ['model.js', 'generate.js', 'preview.js', 'workspace.js', 'tools.js', 'agent.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'public', f), 'utf8'), sandbox, { filename: f });
  }

  els['btn-settings'].dispatch('click');
  assert.strictEqual(els['settings-dialog'].open, true, 'Ayarlar açılmalı');

  els['api-key-input'].value = 'AIzaTestKey123';
  els['settings-form'].dispatch('submit');
  assert.strictEqual(sandbox.Model.getKey(), 'AIzaTestKey123', 'Anahtar kaydedilmeli');
  assert.strictEqual(els['settings-dialog'].open, false, 'Ayarlar kapanmalı');

  sandbox.fetch = async () => sse([cand([{ text: 'Selam!' }])]);
  els['chat-input'].value = 'Merhaba';
  els['chat-form'].dispatch('submit');
  await new Promise((r) => setTimeout(r, 30));
  const saved = JSON.parse(store['kodasistan.contents'] || '[]');
  assert.strictEqual(saved.length, 2, 'Kullanıcı ve model mesajı kaydedilmeli');
  assert.strictEqual(saved[0].parts[0].text, 'Merhaba');
  assert.strictEqual(saved[1].parts[0].text, 'Selam!');
}

console.log('UNIT OK: Workspace, Tools, Model.generate, Agent döngüsü/iptal/yedek/pencere, app.js DOM');
