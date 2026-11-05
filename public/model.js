/**
 * Gemini API istemcisi — tarayıcıdan doğrudan çağrı (CORS destekli).
 * Varsayılan model: gemini-3.8-flash (ücretsiz katman).
 * Endpoint: .../v1beta/models/{model}:streamGenerateContent?alt=sse
 */
(function (global) {
  'use strict';

  var KEY_STORAGE = 'gemini_key';
  var MODEL_STORAGE = 'gemini_model';
  var DEFAULT_MODEL = 'gemini-3.8-flash';
  var API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  var SYSTEM_PROMPT =
    'Sen uzman bir yazılım asistanısın. Yanıtlarını her zaman Türkçe ver. ' +
    'Kullanıcı bir web uygulaması istediğinde, eksiksiz ve çalışır dosyaları ' +
    'fence\'li kod blokları olarak üret; her blokta dosya adını belirt. ' +
    'Örnek: ```html file=index.html\\n...\\n``` veya blokun ilk satırında ' +
    '`// index.html` / `/* style.css */` / `// script.js`. ' +
    'Tek bir HTML sayfası üretirken dosya adı yoksa index.html kabul edilir. ' +
    'Gerekirse style.css ve script.js dosyalarını da ayrı bloklarda ver. ' +
    'Açıklamaları kısa tut; asıl çıktı kod olsun.';

  function getKey() {
    try {
      return localStorage.getItem(KEY_STORAGE) || '';
    } catch (e) {
      return '';
    }
  }

  function setKey(k) {
    try {
      if (k == null || String(k).trim() === '') {
        localStorage.removeItem(KEY_STORAGE);
      } else {
        localStorage.setItem(KEY_STORAGE, String(k).trim());
      }
    } catch (e) {
      /* ignore quota / private mode */
    }
  }

  function getModel() {
    try {
      return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
    } catch (e) {
      return DEFAULT_MODEL;
    }
  }

  function setModel(name) {
    try {
      if (name == null || String(name).trim() === '') {
        localStorage.removeItem(MODEL_STORAGE);
      } else {
        localStorage.setItem(MODEL_STORAGE, String(name).trim());
      }
    } catch (e) {
      /* ignore */
    }
  }

  function turkishError(status, bodyText, networkErr) {
    if (networkErr) {
      var msg = (networkErr && networkErr.message) || String(networkErr);
      if (networkErr.name === 'AbortError') {
        var abortErr = new Error('İstek iptal edildi.');
        abortErr.code = 'aborted';
        abortErr.cause = networkErr;
        return abortErr;
      }
      var net = new Error('Ağ hatası: Gemini API\'ye ulaşılamadı. Bağlantını kontrol et.');
      net.code = 'network';
      net.cause = networkErr;
      net.detail = msg;
      return net;
    }
    if (status === 400 || status === 403) {
      var inv = new Error(
        'API anahtarı geçersiz veya yetkisiz (HTTP ' + status + '). Anahtarı Ayarlar\'dan kontrol et.'
      );
      inv.code = 'invalid_key';
      inv.status = status;
      inv.detail = bodyText;
      return inv;
    }
    if (status === 429) {
      var quota = new Error(
        'Günlük/dakikalık ücretsiz kota doldu, biraz sonra tekrar dene'
      );
      quota.code = 'quota';
      quota.status = 429;
      quota.detail = bodyText;
      return quota;
    }
    var generic = new Error(
      'Gemini API hatası (HTTP ' + status + ').' +
        (bodyText ? ' ' + String(bodyText).slice(0, 200) : '')
    );
    generic.code = 'api';
    generic.status = status;
    generic.detail = bodyText;
    return generic;
  }

  function toGeminiContents(messages) {
    var contents = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!m || m.content == null) continue;
      var role = m.role === 'assistant' || m.role === 'model' ? 'model' : 'user';
      contents.push({
        role: role,
        parts: [{ text: String(m.content) }],
      });
    }
    return contents;
  }

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @param {function(string, string): void} [onChunk] textSoFar, delta
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  async function chat(messages, onChunk, opts) {
    opts = opts || {};
    var key = getKey();
    if (!key) {
      var noKey = new Error(
        'API anahtarı yok. Ayarlar\'dan Gemini API anahtarını gir.'
      );
      noKey.code = 'no_key';
      throw noKey;
    }

    var model = getModel();
    var url =
      API_BASE +
      '/' +
      encodeURIComponent(model) +
      ':streamGenerateContent?alt=sse';

    var body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: toGeminiContents(messages || []),
      generationConfig: {
        temperature: 0.4,
      },
    };

    var response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      throw turkishError(0, '', err);
    }

    if (!response.ok) {
      var errText = '';
      try {
        errText = await response.text();
      } catch (e) {
        errText = '';
      }
      throw turkishError(response.status, errText, null);
    }

    if (!response.body || !response.body.getReader) {
      throw turkishError(0, '', new Error('Streaming desteklenmiyor'));
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var fullText = '';

    while (true) {
      var chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw turkishError(0, '', err);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      var parts = buffer.split('\n');
      buffer = parts.pop() || '';

      for (var i = 0; i < parts.length; i++) {
        var line = parts[i].replace(/\r$/, '');
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        var json;
        try {
          json = JSON.parse(payload);
        } catch (e) {
          continue;
        }
        var delta = extractTextDelta(json);
        if (delta) {
          fullText += delta;
          if (typeof onChunk === 'function') {
            try {
              onChunk(fullText, delta);
            } catch (cbErr) {
              /* callback hatalarını yutma — üst katmana bırakma */
            }
          }
        }
        if (json && json.error) {
          var st = (json.error.code || json.error.status || 400);
          if (typeof st === 'string') st = 400;
          throw turkishError(st, JSON.stringify(json.error), null);
        }
      }
    }

    // kalan buffer
    if (buffer) {
      var last = buffer.replace(/\r$/, '');
      if (last.indexOf('data:') === 0) {
        try {
          var j2 = JSON.parse(last.slice(5).trim());
          var d2 = extractTextDelta(j2);
          if (d2) {
            fullText += d2;
            if (typeof onChunk === 'function') onChunk(fullText, d2);
          }
        } catch (e) {
          /* ignore */
        }
      }
    }

    return fullText;
  }

  function extractTextDelta(json) {
    if (!json || !json.candidates || !json.candidates.length) return '';
    var cand = json.candidates[0];
    if (!cand || !cand.content || !cand.content.parts) return '';
    var out = '';
    for (var i = 0; i < cand.content.parts.length; i++) {
      var p = cand.content.parts[i];
      if (p && typeof p.text === 'string') out += p.text;
    }
    return out;
  }

  /**
   * Fence'li kod bloklarından dosya haritası üretir.
   * Destek: ```lang file=name, ```lang:name, ilk satır // name | /* name *\/
   * Tek başına html bloğu → index.html
   * @param {string} text
   * @returns {Object.<string, string>}
   */
  function parseFiles(text) {
    var files = {};
    if (!text) return files;
    var src = String(text);
    // ```lang attrs\ncode\n```
    var re = /```([^\n`]*)\n([\s\S]*?)```/g;
    var match;
    var htmlBlocks = [];

    while ((match = re.exec(src)) !== null) {
      var header = (match[1] || '').trim();
      var code = match[2] || '';
      // trim trailing newline commonly left before closing fence
      if (code.endsWith('\n')) code = code.slice(0, -1);

      var filename = null;
      var fileEq = header.match(/(?:^|\s)file\s*=\s*([^\s]+)/i);
      if (fileEq) {
        filename = fileEq[1].replace(/^["']|["']$/g, '');
      } else {
        // lang:filename or just filename in header after lang
        var colon = header.match(/^[a-zA-Z0-9_+-]+\s*:\s*([^\s]+)$/);
        if (colon) filename = colon[1];
        else {
          var onlyName = header.match(/^(?:[a-zA-Z0-9_+-]+\s+)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)$/);
          if (onlyName && onlyName[1].indexOf('.') !== -1) filename = onlyName[1];
        }
      }

      // first-line filename styles
      if (!filename) {
        var firstLineMatch = code.match(
          /^\s*(?:\/\/\s*|\/\*\s*|#\s*|<!--\s*)([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)(?:\s*\*\/|\s*-->)?\s*\n/
        );
        if (firstLineMatch) {
          filename = firstLineMatch[1];
          code = code.slice(firstLineMatch[0].length);
        }
      }

      var lang = (header.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z0-9_+-]/g, '');

      if (!filename) {
        if (lang === 'html' || lang === 'htm') {
          htmlBlocks.push(code);
          continue;
        }
        if (lang === 'css') filename = 'style.css';
        else if (lang === 'javascript' || lang === 'js') filename = 'script.js';
        else continue;
      }

      filename = filename.replace(/^\.\//, '');
      files[filename] = code;
    }

    if (htmlBlocks.length) {
      if (!files['index.html']) {
        files['index.html'] = htmlBlocks[0];
      } else {
        // extra unnamed html blocks get index-N.html only if needed; prefer merge skip
        for (var h = 0; h < htmlBlocks.length; h++) {
          if (h === 0 && files['index.html'] === htmlBlocks[0]) continue;
          if (!files['index.html']) files['index.html'] = htmlBlocks[h];
        }
      }
    }

    return files;
  }

  var Model = {
    getKey: getKey,
    setKey: setKey,
    getModel: getModel,
    setModel: setModel,
    chat: chat,
    parseFiles: parseFiles,
    DEFAULT_MODEL: DEFAULT_MODEL,
    API_BASE: API_BASE,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
  };

  global.Model = Model;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
