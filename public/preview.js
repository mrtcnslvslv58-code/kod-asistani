/**
 * Önizleme: dosya haritasından iframe srcdoc + konsol yakalama + ZIP indirme.
 */
(function (global) {
  'use strict';

  var consoleCallback = null;
  var messageBound = false;

  function onConsole(cb) {
    consoleCallback = typeof cb === 'function' ? cb : null;
    ensureMessageListener();
  }

  function ensureMessageListener() {
    if (messageBound || typeof window === 'undefined') return;
    messageBound = true;
    window.addEventListener('message', function (ev) {
      var data = ev.data;
      if (!data || data.source !== 'kod-asistani-preview') return;
      if (typeof consoleCallback === 'function') {
        try {
          consoleCallback({
            level: data.level || 'log',
            args: data.args || [],
            message: data.message || '',
          });
        } catch (e) {
          /* ignore */
        }
      }
    });
  }

  function escapeClosingScript(js) {
    return String(js).replace(/<\/script/gi, '<\\/script');
  }

  function basename(path) {
    var p = String(path || '').replace(/\\/g, '/');
    var i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  }

  function findFile(files, name) {
    if (!files) return null;
    if (files[name] != null) return files[name];
    var base = basename(name);
    if (files[base] != null) return files[base];
    var keys = Object.keys(files);
    for (var i = 0; i < keys.length; i++) {
      if (basename(keys[i]) === base || basename(keys[i]) === name) {
        return files[keys[i]];
      }
    }
    return null;
  }

  /**
   * index.html içindeki yerel css/js referanslarını inline eder.
   */
  function buildSrcdoc(files) {
    files = files || {};
    var html = files['index.html'] != null ? String(files['index.html']) : '';
    if (!html) {
      html =
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Önizleme</title></head>' +
        '<body><p>index.html bulunamadı.</p></body></html>';
    }

    // <link rel="stylesheet" href="...">
    html = html.replace(
      /<link\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>/gi,
      function (full, pre, href, post) {
        var attrs = (pre + ' ' + post).toLowerCase();
        if (attrs.indexOf('stylesheet') === -1 && !/\.css(\?|$)/i.test(href)) {
          return full;
        }
        if (/^(https?:|\/\/|data:)/i.test(href)) return full;
        var css = findFile(files, href);
        if (css == null) return full;
        return '<style data-inlined-from="' + href.replace(/"/g, '') + '">\n' + css + '\n</style>';
      }
    );

    // Bare style.css convention: if no link but style.css exists and not already inlined, inject into head
    if (files['style.css'] != null && !/\bdata-inlined-from=["']style\.css["']/.test(html)) {
      if (!/<style\b[^>]*>[\s\S]*<\/style>/i.test(html) || html.indexOf(files['style.css']) === -1) {
        // only auto-inject if no local stylesheet link was successfully inlined from style.css
        var hasStyleLink = /<link\b[^>]*href\s*=\s*["'][^"']*style\.css["'][^>]*>/i.test(
          String(files['index.html'] || '')
        );
        var already = /data-inlined-from=["']style\.css["']/.test(html);
        if (!already) {
          var styleTag =
            '<style data-inlined-from="style.css">\n' + files['style.css'] + '\n</style>';
          if (/<\/head>/i.test(html)) {
            html = html.replace(/<\/head>/i, styleTag + '\n</head>');
          } else {
            html = styleTag + html;
          }
        }
      }
    }

    // <script src="..."></script>
    html = html.replace(
      /<script\b([^>]*?)src\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
      function (full, pre, src, post) {
        if (/^(https?:|\/\/|data:)/i.test(src)) return full;
        var js = findFile(files, src);
        if (js == null) return full;
        return (
          '<script data-inlined-from="' +
          src.replace(/"/g, '') +
          '"' +
          pre +
          post +
          '>\n' +
          escapeClosingScript(js) +
          '\n</script>'
        );
      }
    );

    // Bare script.js convention
    if (files['script.js'] != null && !/data-inlined-from=["']script\.js["']/.test(html)) {
      var scriptTag =
        '<script data-inlined-from="script.js">\n' +
        escapeClosingScript(files['script.js']) +
        '\n</script>';
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, scriptTag + '\n</body>');
      } else {
        html = html + scriptTag;
      }
    }

    // Console bridge (no allow-same-origin → postMessage only)
    var bridge =
      '<script data-preview-bridge="1">(function(){' +
      'function send(level, args){' +
      'var msg="";try{msg=Array.prototype.map.call(args,function(a){' +
      'try{return typeof a==="string"?a:JSON.stringify(a)}catch(e){return String(a)}' +
      '}).join(" ")}catch(e){msg=String(e)}' +
      'try{parent.postMessage({source:"kod-asistani-preview",level:level,args:Array.prototype.slice.call(args),message:msg},"*")}catch(e){}' +
      '}' +
      '["log","info","warn","error","debug"].forEach(function(l){' +
      'var orig=console[l];console[l]=function(){send(l,arguments);if(orig)try{orig.apply(console,arguments)}catch(e){}}' +
      '});' +
      'window.addEventListener("error",function(ev){send("error",[ev.message+" ("+(ev.filename||"")+":"+(ev.lineno||"")+")"])});' +
      'window.addEventListener("unhandledrejection",function(ev){send("error",["Unhandled: "+(ev.reason&&ev.reason.message?ev.reason.message:String(ev.reason))])});' +
      '})();</script>';

    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, '<head$1>' + bridge);
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, '<html$1><head>' + bridge + '</head>');
    } else {
      html = bridge + html;
    }

    return html;
  }

  /**
   * @param {Object.<string,string>} files
   * @param {HTMLIFrameElement} iframeEl
   */
  function render(files, iframeEl) {
    if (!iframeEl) throw new Error('iframe öğesi gerekli');
    ensureMessageListener();
    iframeEl.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals'
    );
    iframeEl.srcdoc = buildSrcdoc(files);
  }

  /* ---------- Minimal ZIP (STORE, no CDN) ---------- */
  function crc32(buf) {
    var table = crc32.table;
    if (!table) {
      table = (crc32.table = new Uint32Array(256));
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    var crc = 0 ^ -1;
    for (var i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  function u16(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  }
  function u32(n) {
    return new Uint8Array([
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff,
    ]);
  }

  function concatBytes(chunks) {
    var len = 0;
    for (var i = 0; i < chunks.length; i++) len += chunks[i].length;
    var out = new Uint8Array(len);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], off);
      off += chunks[j].length;
    }
    return out;
  }

  function encodeUtf8(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str);
    }
    var utf8 = unescape(encodeURIComponent(str));
    var arr = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) arr[i] = utf8.charCodeAt(i);
    return arr;
  }

  function buildZip(files) {
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    var names = Object.keys(files || {});
    var count = 0;

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var content = files[name];
      if (content == null) continue;
      var nameBytes = encodeUtf8(name);
      var data =
        typeof content === 'string' ? encodeUtf8(content) : new Uint8Array(content);
      var crc = crc32(data);
      var size = data.length;

      var local = concatBytes([
        u32(0x04034b50),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
        data,
      ]);

      var central = concatBytes([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]);

      localParts.push(local);
      centralParts.push(central);
      offset += local.length;
      count++;
    }

    var centralDir = concatBytes(centralParts);
    var end = concatBytes([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(count),
      u16(count),
      u32(centralDir.length),
      u32(offset),
      u16(0),
    ]);

    return concatBytes(localParts.concat([centralDir, end]));
  }

  function download(files, zipName) {
    var bytes = buildZip(files);
    var blob = new Blob([bytes], { type: 'application/zip' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = zipName || 'proje.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  var Preview = {
    render: render,
    onConsole: onConsole,
    download: download,
    buildSrcdoc: buildSrcdoc,
    buildZip: buildZip,
  };

  global.Preview = Preview;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
