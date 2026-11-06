import { spawn } from 'child_process';
import assert from 'assert';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const TARGET_URL = process.argv[2] || 'https://kod-asistani.onrender.com/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET_URL)}`, { method: 'PUT' });
      if (r.ok) {
        const j = await r.json();
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('Chrome CDP portuna bağlanılamadı');
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\ka-chrome-e2e-${Date.now()}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

try {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let idSeq = 1;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  };

  function send(method, params = {}) {
    const id = idSeq++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  }

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('Eval exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: TARGET_URL });

  // Sayfa yüklenmesini bekle
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate('document.readyState === "complete" && !!window.Agent && !!window.Workspace');
    if (ready) break;
    await sleep(150);
  }

  assert.strictEqual(exceptions.length, 0, 'Sayfa açılışında JS hatası olmamalı: ' + JSON.stringify(exceptions));

  // 1) Ayarlar butonu dialogu açmalı
  const dialogOpened = await evaluate(`(() => {
    document.querySelector('#btn-settings').click();
    return document.querySelector('#settings-dialog').open === true;
  })()`);
  assert.strictEqual(dialogOpened, true, '#btn-settings tıklanınca dialog açılmalı');

  // 2) İptal butonu dialogu kapatmalı
  const dialogClosedByCancel = await evaluate(`(() => {
    document.querySelector('#btn-cancel-settings').click();
    return document.querySelector('#settings-dialog').open === false;
  })()`);
  assert.strictEqual(dialogClosedByCancel, true, '#btn-cancel-settings tıklanınca dialog kapanmalı');

  // 3) Boş durumdaki "Ayarlar'ı aç" butonu dialogu açmalı ve Kaydet anahtarı kaydetmeli
  const keySaved = await evaluate(`(() => {
    const emptyBtn = document.querySelector('#btn-empty-key');
    if (emptyBtn) emptyBtn.click();
    else document.querySelector('#btn-settings').click();
    const inp = document.querySelector('#api-key-input');
    inp.value = 'AIzaSyTestKeyE2E';
    document.querySelector('#instructions-input').value = 'Kısa yanıt ver.';
    document.querySelector('#btn-save-settings').click();
    return {
      open: document.querySelector('#settings-dialog').open,
      key: window.Model.getKey(),
      instr: window.Agent.getInstructions(),
    };
  })()`);
  assert.strictEqual(keySaved.open, false, 'Kaydet sonrası dialog kapanmalı');
  assert.strictEqual(keySaved.key, 'AIzaSyTestKeyE2E', 'Anahtar localStorage içine kaydedilmeli');
  assert.strictEqual(keySaved.instr, 'Kısa yanıt ver.', 'Özel talimat kaydedilmeli');

  // 4) Sahte SSE ile mesaj gönderimi + araç çağrısı (write_file) + önizleme ve dosya sekmesi
  const chatResult = await evaluate(`(async () => {
    let callCount = 0;
    const enc = new TextEncoder();
    function makeSse(events) {
      const chunks = events.map(e => 'data: ' + JSON.stringify(e) + '\\n\\n');
      let i = 0;
      return new Response(new ReadableStream({
        pull(c) {
          if (i >= chunks.length) return c.close();
          c.enqueue(enc.encode(chunks[i++]));
        }
      }), { status: 200 });
    }
    window.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return makeSse([
          { candidates: [{ content: { role: 'model', parts: [
            { text: 'Sayfayı oluşturuyorum.' },
            { functionCall: { name: 'write_file', args: { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>Test Başarılı</h1></body></html>' } } }
          ] } }] }
        ]);
      }
      return makeSse([
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Hazır, index.html oluşturuldu.' }] } }] }
      ]);
    };

    const input = document.querySelector('#chat-input');
    input.value = 'Bana bir test sayfası yap';
    document.querySelector('#btn-send').click();

    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (document.querySelector('#btn-send').hidden === false && callCount >= 2) break;
    }

    return {
      callCount,
      userBubbles: document.querySelectorAll('.msg-user .bubble').length,
      toolCards: document.querySelectorAll('.tool.ok').length,
      sideOpen: document.querySelector('#layout').classList.contains('side-open'),
      fileCount: document.querySelector('#file-count').textContent,
      srcdocHasTitle: document.querySelector('#preview-frame').srcdoc.includes('Test Başarılı'),
      assistantText: document.querySelector('#chat-messages').innerText,
    };
  })()`);

  assert.strictEqual(chatResult.callCount, 2, 'Model 2 tur çağrılmalı (araç + yanıt)');
  assert.strictEqual(chatResult.userBubbles, 1, 'Kullanıcı mesaj balonu görünmeli');
  assert.strictEqual(chatResult.toolCards, 1, 'Tamamlanan araç kartı görünmeli');
  assert.strictEqual(chatResult.sideOpen, true, 'Dosya yazılınca yan panel otomatik açılmalı');
  assert.strictEqual(chatResult.fileCount, '1', 'Dosya sayısı 1 olmalı');
  assert.strictEqual(chatResult.srcdocHasTitle, true, 'Önizleme iframe srcdoc güncellenmeli');
  assert.ok(chatResult.assistantText.includes('Hazır, index.html oluşturuldu.'), 'Asistan yanıtı ekranda görünmeli');
  assert.strictEqual(exceptions.length, 0, 'Akış boyunca hiçbir JS hatası olmamalı: ' + JSON.stringify(exceptions));
  assert.strictEqual(consoleErrors.length, 0, 'Konsol hatası olmamalı: ' + JSON.stringify(consoleErrors));

  console.log('CHROME E2E OK (' + TARGET_URL + '):', JSON.stringify({
    dialogOpened,
    dialogClosedByCancel,
    keySaved: keySaved.key === 'AIzaSyTestKeyE2E',
    toolCards: chatResult.toolCards,
    sideOpen: chatResult.sideOpen,
    fileCount: chatResult.fileCount,
    srcdocHasTitle: chatResult.srcdocHasTitle,
    exceptions: exceptions.length,
    consoleErrors: consoleErrors.length,
  }));
  ws.close();
} finally {
  try {
    chrome.kill();
  } catch (_) {}
}
