/**
 * KodAsistan — arayüz iskeleti
 * Model (model.js) ve Preview (preview.js) REİS tarafından yazılır.
 * Yoksa aşağıdaki stub'lar UI'nin kırılmasını engeller.
 */
(function () {
  'use strict';

  const KEY_STORAGE = 'gemini_key'; // Model.setKey ile aynı (REİS sözleşmesi)
  const HISTORY_KEY = 'kodasistan.chatHistory';
  const CODE_KEY = 'kodasistan.code';
  const LANG_KEY = 'kodasistan.lang';

  // —— Graceful stubs (REİS dosyaları gelene kadar) ——
  if (typeof window.Model === 'undefined') {
    window.Model = {
      setKey(key) {
        try {
          if (key) localStorage.setItem(KEY_STORAGE, key);
          else localStorage.removeItem(KEY_STORAGE);
        } catch (_) {}
      },
      getKey() {
        try {
          return localStorage.getItem(KEY_STORAGE) || '';
        } catch (_) {
          return '';
        }
      },
      async chat(_messages, onChunk, _opts) {
        const stub =
          'Model henüz bağlı değil. REİS model.js ekleyince Gemini yanıtları burada akacak.\n\n' +
          '```html\n<!DOCTYPE html>\n<html>\n<head><title>Merhaba</title></head>\n<body>\n  <h1>KodAsistan hazır</h1>\n</body>\n</html>\n```';
        if (typeof onChunk === 'function') onChunk(stub, stub);
        return stub;
      },
      parseFiles(metin) {
        const files = {};
        const re = /```(\w+)?\n([\s\S]*?)```/g;
        let m;
        let i = 0;
        while ((m = re.exec(metin)) !== null) {
          const lang = (m[1] || 'txt').toLowerCase();
          const name =
            lang === 'html' || lang === 'htm'
              ? 'index.html'
              : lang === 'css'
                ? 'style.css'
                : lang === 'js' || lang === 'javascript'
                  ? 'app.js'
                  : `file${i++}.${lang}`;
          files[name] = m[2];
        }
        if (!Object.keys(files).length && metin && metin.trim()) {
          files['index.html'] = metin;
        }
        return files;
      },
    };
    console.info('[KodAsistan] Model stub aktif — public/model.js bekleniyor');
  }

  if (typeof window.Preview === 'undefined') {
    window.Preview = {
      render(dosyalar, iframe) {
        if (!iframe) return;
        const html =
          dosyalar['index.html'] ||
          dosyalar['index.htm'] ||
          Object.values(dosyalar || {})[0] ||
          '<p style="font-family:sans-serif;color:#666">Önizlenecek içerik yok</p>';
        iframe.srcdoc = html;
      },
      onConsole(_cb) {},
      download(dosyalar) {
        const name = Object.keys(dosyalar || {})[0] || 'kod.html';
        const blob = new Blob([dosyalar[name] || ''], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
      },
    };
    console.info('[KodAsistan] Preview stub aktif — public/preview.js bekleniyor');
  }

  // —— DOM ——
  const $ = (sel) => document.querySelector(sel);
  const chatMessagesEl = $('#chat-messages');
  const chatForm = $('#chat-form');
  const chatInput = $('#chat-input');
  const btnSend = $('#btn-send');
  const btnClear = $('#btn-clear-chat');
  const codeEditor = $('#code-editor');
  const langSelect = $('#lang-select');
  const editorLangLabel = $('#editor-lang-label');
  const previewFrame = $('#preview-frame');
  const previewPlaceholder = $('#preview-placeholder');
  const btnRefresh = $('#btn-refresh-preview');
  const btnDownload = $('#btn-download');
  const btnSettings = $('#btn-settings');
  const settingsDialog = $('#settings-dialog');
  const settingsForm = $('#settings-form');
  const apiKeyInput = $('#api-key-input');
  const consoleLog = $('#console-log');

  /** @type {{role: string, content: string}[]} */
  let history = [];
  let abortController = null;
  let streaming = false;

  // —— Helpers ——
  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (_) {}
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) history = JSON.parse(raw) || [];
    } catch (_) {
      history = [];
    }
  }

  function appendMessage(role, content, { replaceLast } = {}) {
    if (replaceLast && chatMessagesEl.lastElementChild) {
      chatMessagesEl.lastElementChild.remove();
      if (history.length && history[history.length - 1].role === role) {
        history.pop();
      }
    }
    history.push({ role, content });
    saveHistory();

    const el = document.createElement('div');
    el.className = `msg msg-${role}`;
    const roleLabel =
      role === 'user' ? 'Sen' : role === 'assistant' ? 'Asistan' : role === 'error' ? 'Hata' : 'Sistem';
    el.innerHTML = `<span class="msg-role">${roleLabel}</span>`;
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = content;
    el.appendChild(body);
    chatMessagesEl.appendChild(el);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    return body;
  }

  function renderHistory() {
    chatMessagesEl.innerHTML = '';
    if (!history.length) {
      appendMessage(
        'system',
        'Merhaba! Ne kodlamak istediğini yaz. API anahtarını Ayarlar’dan kaydet.'
      );
      // system mesajını geçmişe yazmayalım — pop
      history.pop();
      saveHistory();
      return;
    }
    const snapshot = [...history];
    history = [];
    snapshot.forEach((m) => appendMessage(m.role, m.content));
  }

  function syncKeyFromStorage() {
    // Model kendi localStorage anahtarını (gemini_key) yönetir.
    // Stub durumunda getKey/setKey zaten KEY_STORAGE kullanır.
    if (typeof Model.getKey === 'function' && typeof Model.setKey === 'function') {
      const key = Model.getKey();
      if (key) Model.setKey(key);
    }
  }

  function setPlaceholderVisible(visible) {
    if (!previewPlaceholder) return;
    previewPlaceholder.classList.toggle('hidden', !visible);
  }

  function applyFilesToEditor(files) {
    if (!files || !Object.keys(files).length) return;
    const preferred =
      files['index.html'] ||
      files['style.css'] ||
      files['app.js'] ||
      files[Object.keys(files)[0]];
    codeEditor.value = preferred || '';
    try {
      localStorage.setItem(CODE_KEY, codeEditor.value);
    } catch (_) {}
  }

  function refreshPreviewFromEditor() {
    const lang = langSelect.value;
    const code = codeEditor.value;
    const files =
      lang === 'css'
        ? { 'style.css': code, 'index.html': `<!DOCTYPE html><html><head><style>${code}</style></head><body><p>CSS önizleme</p></body></html>` }
        : lang === 'js'
          ? {
              'app.js': code,
              'index.html': `<!DOCTYPE html><html><body><script>${code}<\/script></body></html>`,
            }
          : { 'index.html': code || '<p></p>' };

    if (typeof Preview.render === 'function') {
      Preview.render(files, previewFrame);
      setPlaceholderVisible(false);
    }
  }

  // —— Chat submit ——
  async function handleSend(text) {
    const prompt = (text || '').trim();
    if (!prompt || streaming) return;

    appendMessage('user', prompt);
    chatInput.value = '';
    streaming = true;
    btnSend.disabled = true;

    const messages = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let assistantBody = appendMessage('assistant', '…');
    let fullText = '';

    try {
      fullText = await Model.chat(
        messages,
        (all, _chunk) => {
          fullText = all;
          assistantBody.textContent = all || '…';
          chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
          if (history.length && history[history.length - 1].role === 'assistant') {
            history[history.length - 1].content = all;
          }
        },
        { signal: abortController ? abortController.signal : undefined }
      );

      if (history.length && history[history.length - 1].role === 'assistant') {
        history[history.length - 1].content = fullText;
        saveHistory();
      }
      assistantBody.textContent = fullText;

      const files = Model.parseFiles(fullText);
      applyFilesToEditor(files);
      if (typeof Preview.render === 'function') {
        Preview.render(files, previewFrame);
        setPlaceholderVisible(!Object.keys(files).length);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        assistantBody.textContent = (fullText || '') + '\n\n[iptal edildi]';
      } else {
        const msg = (err && err.message) || String(err);
        // son asistan balonunu hata ile değiştir
        if (chatMessagesEl.lastElementChild) chatMessagesEl.lastElementChild.remove();
        if (history.length && history[history.length - 1].role === 'assistant') history.pop();
        appendMessage('error', msg);
      }
    } finally {
      streaming = false;
      btnSend.disabled = false;
      abortController = null;
      chatInput.focus();
    }
  }

  // —— Events ——
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend(chatInput.value);
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(chatInput.value);
    }
  });

  btnClear.addEventListener('click', () => {
    if (streaming) return;
    history = [];
    saveHistory();
    renderHistory();
  });

  codeEditor.addEventListener('input', () => {
    try {
      localStorage.setItem(CODE_KEY, codeEditor.value);
    } catch (_) {}
  });

  langSelect.addEventListener('change', () => {
    const labels = { html: 'HTML', css: 'CSS', js: 'JavaScript', single: 'Tek dosya' };
    editorLangLabel.textContent = labels[langSelect.value] || langSelect.value;
    try {
      localStorage.setItem(LANG_KEY, langSelect.value);
    } catch (_) {}
  });

  btnRefresh.addEventListener('click', () => {
    refreshPreviewFromEditor();
  });

  btnDownload.addEventListener('click', () => {
    const code = codeEditor.value;
    const files = { 'index.html': code };
    if (typeof Preview.download === 'function') Preview.download(files);
  });

  btnSettings.addEventListener('click', () => {
    // değeri göstermeden maskele — sadece kayıtlı mı diye belirt
    const existing = typeof Model.getKey === 'function' ? Model.getKey() : '';
    apiKeyInput.value = '';
    apiKeyInput.placeholder = existing
      ? '••••••••  (kayıtlı — değiştirmek için yeni anahtar yaz)'
      : 'AIza… (değer maskelenir)';
    if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
    else settingsDialog.setAttribute('open', '');
  });

  settingsForm.addEventListener('submit', (e) => {
    const submitter = e.submitter;
    const value = submitter && submitter.value;
    if (value === 'save') {
      const key = apiKeyInput.value.trim();
      // Boş bırakılırsa mevcut anahtarı koru; yalnızca yeni değer yazıldığında Model.setKey
      if (key && typeof Model.setKey === 'function') {
        Model.setKey(key);
      }
    }
    apiKeyInput.value = '';
  });

  if (typeof Preview.onConsole === 'function') {
    Preview.onConsole((line) => {
      if (!consoleLog) return;
      consoleLog.hidden = false;
      const row = document.createElement('div');
      row.textContent = typeof line === 'string' ? line : JSON.stringify(line);
      consoleLog.appendChild(row);
      consoleLog.scrollTop = consoleLog.scrollHeight;
    });
  }

  // —— Init ——
  syncKeyFromStorage();
  loadHistory();
  renderHistory();

  try {
    const savedCode = localStorage.getItem(CODE_KEY);
    if (savedCode) codeEditor.value = savedCode;
    const savedLang = localStorage.getItem(LANG_KEY);
    if (savedLang) {
      langSelect.value = savedLang;
      langSelect.dispatchEvent(new Event('change'));
    }
  } catch (_) {}

  if (!codeEditor.value) {
    setPlaceholderVisible(true);
  } else {
    refreshPreviewFromEditor();
  }
})();
