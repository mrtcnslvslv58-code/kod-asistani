/**
 * Ajan araçları: Gemini function calling bildirimleri + yerel uygulamaları.
 * Tüm araçlar tarayıcıdaki sanal proje klasöründe çalışır; ağa/sunucuya erişmez.
 */
(function (global) {
  'use strict';

  var MEMORY_KEY = 'kodasistan.memory';
  var MAX_READ_CHARS = 12000;
  var MAX_CONSOLE = 60;
  var MAX_MEMORY = 30;

  var consoleBuffer = [];

  function ws() {
    return global.Workspace;
  }

  // —— Hafıza ——
  function getMemory() {
    try {
      var arr = JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (e) {
      return [];
    }
  }

  function setMemory(arr) {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(arr.slice(-MAX_MEMORY)));
    } catch (e) {
      /* yok say */
    }
  }

  function pushConsole(entry) {
    if (!entry) return;
    consoleBuffer.push({
      level: entry.level || 'log',
      message: String(entry.message == null ? '' : entry.message).slice(0, 500),
    });
    if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
  }

  // —— Bildirimler (Gemini functionDeclarations) ——
  var declarations = [
    {
      name: 'list_files',
      description: 'Proje klasöründeki tüm dosyaları ve boyutlarını listeler.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'read_file',
      description: 'Bir dosyanın içeriğini okur. Düzenlemeden önce mevcut içeriği görmek için kullan.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Dosya yolu, örn. index.html' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description:
        'Dosyayı oluşturur veya TAMAMEN yeniden yazar. Yeni dosya ya da büyük değişiklik için kullan; ' +
        'küçük değişikliklerde edit_file tercih et. Her zaman dosyanın TAM içeriğini ver.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dosya yolu, örn. index.html, style.css, script.js' },
          content: { type: 'string', description: 'Dosyanın tam içeriği' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description:
        'Mevcut bir dosyada tek bir metin parçasını değiştirir. old_text dosyada TAM OLARAK bir kez ' +
        'geçmeli (boşluklar dahil); birden çok yer eşleşirse daha fazla bağlam ekle.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dosya yolu' },
          old_text: { type: 'string', description: 'Değiştirilecek mevcut metin (tam eşleşme)' },
          new_text: { type: 'string', description: 'Yerine yazılacak yeni metin' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    {
      name: 'delete_file',
      description: 'Bir dosyayı siler.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Dosya yolu' } },
        required: ['path'],
      },
    },
    {
      name: 'get_console',
      description:
        'Canlı önizlemedeki son konsol çıktılarını ve JavaScript hatalarını döndürür. ' +
        'Kodu yazdıktan sonra çalışıp çalışmadığını doğrulamak için kullan.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'remember',
      description:
        'Kullanıcının kalıcı tercihini veya proje hakkında ileride lazım olacak önemli bir bilgiyi ' +
        'hafızaya kaydeder (kısa ve net tek cümle). Sadece gerçekten kalıcı bilgiler için kullan.',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: 'Kaydedilecek not' } },
        required: ['note'],
      },
    },
  ];

  function requireString(args, key) {
    var v = args ? args[key] : undefined;
    if (typeof v !== 'string') throw new Error('"' + key + '" metin olmalı.');
    return v;
  }

  function countOccurrences(hay, needle) {
    if (!needle) return 0;
    var n = 0;
    var i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) {
      n++;
      i += needle.length;
    }
    return n;
  }

  // —— Uygulamalar: { ok:true, ... } veya hata fırlatır ——
  var impl = {
    list_files: function () {
      var names = ws().list();
      var all = ws().all();
      return {
        ok: true,
        count: names.length,
        files: names.map(function (n) {
          return { path: n, chars: all[n].length };
        }),
      };
    },

    read_file: function (args) {
      var path = requireString(args, 'path');
      var content = ws().get(path);
      if (content == null) {
        throw new Error('Dosya bulunamadı: ' + path + '. Mevcut dosyalar: ' + (ws().list().join(', ') || '(yok)'));
      }
      var truncated = content.length > MAX_READ_CHARS;
      return {
        ok: true,
        path: ws().normalize(path),
        content: truncated ? content.slice(0, MAX_READ_CHARS) : content,
        truncated: truncated,
        total_chars: content.length,
      };
    },

    write_file: function (args) {
      var path = requireString(args, 'path');
      var content = requireString(args, 'content');
      var r = ws().set(path, content);
      return { ok: true, path: r.path, created: r.created, chars: content.length };
    },

    edit_file: function (args) {
      var path = requireString(args, 'path');
      var oldText = requireString(args, 'old_text');
      var newText = requireString(args, 'new_text');
      var current = ws().get(path);
      if (current == null) throw new Error('Dosya bulunamadı: ' + path);
      if (!oldText) throw new Error('old_text boş olamaz.');
      var n = countOccurrences(current, oldText);
      if (n === 0) {
        throw new Error('old_text dosyada bulunamadı. Önce read_file ile güncel içeriği oku ve tam eşleşen metni ver.');
      }
      if (n > 1) {
        throw new Error('old_text dosyada ' + n + ' kez geçiyor. Benzersiz olması için daha fazla çevre metin ekle.');
      }
      var idx = current.indexOf(oldText);
      var updated = current.slice(0, idx) + newText + current.slice(idx + oldText.length);
      var r = ws().set(path, updated);
      return { ok: true, path: r.path, chars: updated.length };
    },

    delete_file: function (args) {
      var path = requireString(args, 'path');
      if (!ws().remove(path)) throw new Error('Dosya bulunamadı: ' + path);
      return { ok: true, path: ws().normalize(path) };
    },

    get_console: function () {
      var out = consoleBuffer.slice();
      return {
        ok: true,
        count: out.length,
        entries: out,
        note: out.length ? undefined : 'Konsolda çıktı yok (hata da yok). Önizleme henüz yüklenmemiş olabilir.',
      };
    },

    remember: function (args) {
      var note = requireString(args, 'note').trim();
      if (!note) throw new Error('Not boş olamaz.');
      var mem = getMemory();
      if (mem.indexOf(note) === -1) mem.push(note.slice(0, 300));
      setMemory(mem);
      return { ok: true, total_notes: getMemory().length };
    },
  };

  /**
   * Aracı çalıştırır; asla fırlatmaz — hata { ok:false, error } olarak döner.
   * Model hatayı görüp kendini düzeltebilsin diye.
   */
  function run(name, args) {
    var fn = impl[name];
    if (!fn) return { ok: false, error: 'Bilinmeyen araç: ' + name };
    try {
      return fn(args || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  global.Tools = {
    declarations: declarations,
    run: run,
    pushConsole: pushConsole,
    clearConsole: function () {
      consoleBuffer = [];
    },
    getMemory: getMemory,
    setMemory: setMemory,
    removeMemory: function (i) {
      var m = getMemory();
      if (i >= 0 && i < m.length) {
        m.splice(i, 1);
        setMemory(m);
      }
    },
  };
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
