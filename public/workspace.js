/**
 * Sanal proje klasörü — tarayıcıda (localStorage) tutulan { yol: içerik } haritası.
 * Ajan araçları (tools.js) ve arayüz (app.js) aynı kaynağı kullanır.
 */
(function (global) {
  'use strict';

  var KEY = 'kodasistan.files';
  var LEGACY_CODE_KEY = 'kodasistan.code';
  var MAX_FILES = 50;
  var MAX_FILE_CHARS = 200000;

  var files = load();
  var listeners = [];

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var obj = raw ? JSON.parse(raw) : null;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (e) {
      /* bozuk veri → boş başla */
    }
    // Eski tek-editör sürümünden geçiş
    try {
      var legacy = localStorage.getItem(LEGACY_CODE_KEY);
      if (legacy && legacy.trim()) return { 'index.html': legacy };
    } catch (e) {
      /* yok say */
    }
    return {};
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(files));
    } catch (e) {
      /* kota dolu / gizli mod */
    }
  }

  function emit(change) {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](change);
      } catch (e) {
        /* dinleyici hatası akışı bozmasın */
      }
    }
  }

  function normalize(p) {
    var path = String(p == null ? '' : p)
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/');
    if (!path || path.length > 120 || path.split('/').some(function (s) { return s === '..' || s === ''; })) {
      throw new Error('Geçersiz dosya yolu: "' + p + '"');
    }
    return path;
  }

  function list() {
    return Object.keys(files).sort();
  }

  function has(path) {
    return Object.prototype.hasOwnProperty.call(files, normalize(path));
  }

  function get(path) {
    var p = normalize(path);
    return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
  }

  function set(path, content) {
    var p = normalize(path);
    var text = content == null ? '' : String(content);
    if (text.length > MAX_FILE_CHARS) {
      throw new Error('Dosya çok büyük (en fazla ' + MAX_FILE_CHARS + ' karakter).');
    }
    var existed = Object.prototype.hasOwnProperty.call(files, p);
    if (!existed && Object.keys(files).length >= MAX_FILES) {
      throw new Error('En fazla ' + MAX_FILES + ' dosya tutulabilir.');
    }
    files[p] = text;
    save();
    emit({ type: existed ? 'update' : 'create', path: p });
    return { path: p, created: !existed };
  }

  function remove(path) {
    var p = normalize(path);
    if (!Object.prototype.hasOwnProperty.call(files, p)) return false;
    delete files[p];
    save();
    emit({ type: 'delete', path: p });
    return true;
  }

  function all() {
    var copy = {};
    Object.keys(files).forEach(function (k) {
      copy[k] = files[k];
    });
    return copy;
  }

  function clear() {
    files = {};
    try {
      localStorage.removeItem(LEGACY_CODE_KEY);
    } catch (e) {
      /* yok say */
    }
    save();
    emit({ type: 'clear' });
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  global.Workspace = {
    list: list,
    has: has,
    get: get,
    set: set,
    remove: remove,
    all: all,
    clear: clear,
    onChange: onChange,
    normalize: normalize,
    MAX_FILES: MAX_FILES,
    MAX_FILE_CHARS: MAX_FILE_CHARS,
  };
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
