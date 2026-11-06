/**
 * Ajan döngüsü: model → araç çağrıları → sonuçlar → model … cevap bitene kadar.
 * Konuşma Gemini'nin kendi biçiminde ({role, parts}) tutulur; arayüz bundan çizilir.
 */
(function (global) {
  'use strict';

  var INSTRUCTIONS_KEY = 'kodasistan.instructions';
  var MAX_STEPS = 15;
  var WINDOW = 40;

  var BASE_PROMPT = [
    'Sen KodAsistan\'sın: kullanıcıyla birlikte çalışan, pratik ve dürüst bir yazılım ajanısın. Her zaman Türkçe yaz.',
    '',
    'ÇALIŞMA ŞEKLİN',
    '- Kullanıcı bir şey yapmanı istediğinde sadece anlatma, ARAÇLARI KULLANARAK gerçekten yap: dosyaları write_file / edit_file ile oluştur ve düzenle. Kodu sohbete yapıştırma; dosyaya yaz.',
    '- Karmaşık bir iş geliyorsa önce 1-3 cümleyle ne yapacağını söyle, sonra çalış.',
    '- Mevcut bir dosyayı değiştirirken önce read_file ile oku. Küçük değişiklikte edit_file, yeni dosya veya köklü değişiklikte write_file kullan. Her zaman dosyanın tam ve çalışır halini üret; "burası aynı kalsın" gibi yer tutucu bırakma.',
    '- Kod yazdıktan sonra get_console ile önizlemedeki hataları kontrol et; hata varsa kendin düzelt, sonra tekrar kontrol et.',
    '- İstek belirsizse ve yanlış tahmin pahalıysa tek bir net soru sor. Küçük detaylarda mantıklı varsayım yap ve varsayımını belirt.',
    '- Bittiğinde kısa bir özet ver: ne yaptın, hangi dosyalar değişti, kullanıcının bilmesi gereken bir şey var mı. Uzatma, tekrar etme.',
    '',
    'ÖNİZLEME SINIRLARI',
    '- Önizleme tarayıcıda çalışan statik HTML/CSS/JavaScript\'tir. Sunucu, npm, veritabanı, dosya sistemi yok. Harici kütüphaneyi CDN üzerinden ekleyebilirsin.',
    '- index.html giriş dosyasıdır; style.css ve script.js gibi yerel dosyalara <link>/<script src> ile bağlanabilir.',
    '',
    'DÜRÜSTLÜK',
    '- Yapamadığın veya emin olmadığın şeyi açıkça söyle; uydurma. Araç hata verirse hatayı oku ve düzelt, sonuç başarısızsa bunu dürüstçe bildir.',
    '- remember aracını yalnızca kullanıcının kalıcı bir tercihini veya proje için uzun vadeli önemli bir bilgiyi öğrendiğinde kullan.',
    '- API anahtarı gibi gizli bilgileri asla yazma, isteme veya tekrar etme.',
  ].join('\n');

  function getInstructions() {
    try {
      return localStorage.getItem(INSTRUCTIONS_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setInstructions(text) {
    try {
      if (text && String(text).trim()) localStorage.setItem(INSTRUCTIONS_KEY, String(text).trim());
      else localStorage.removeItem(INSTRUCTIONS_KEY);
    } catch (e) {
      /* yok say */
    }
  }

  function buildSystem(toolsOn) {
    var parts = [toolsOn ? BASE_PROMPT : global.Model.SYSTEM_PROMPT];
    var custom = getInstructions().trim();
    if (custom) parts.push('KULLANICININ ÖZEL TALİMATLARI (bunlara uy)\n' + custom);
    var mem = global.Tools ? global.Tools.getMemory() : [];
    if (mem.length) parts.push('HAFIZA (önceki konuşmalardan kalıcı notlar)\n- ' + mem.join('\n- '));
    if (toolsOn && global.Workspace) {
      var names = global.Workspace.list();
      parts.push('PROJE DOSYALARI ŞU AN: ' + (names.length ? names.join(', ') : '(boş)'));
    }
    return parts.join('\n\n');
  }

  function isUserText(c) {
    return (
      c &&
      c.role === 'user' &&
      Array.isArray(c.parts) &&
      c.parts.some(function (p) {
        return typeof p.text === 'string';
      })
    );
  }

  /** Modele giden pencere: çok uzayınca eskiyi at ama yetim functionResponse bırakma. */
  function windowContents(contents) {
    if (contents.length <= WINDOW) return contents;
    var start = contents.length - WINDOW;
    var idx = -1;
    for (var i = start; i < contents.length; i++) {
      if (isUserText(contents[i])) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      for (var j = contents.length - 1; j >= 0; j--) {
        if (isUserText(contents[j])) {
          idx = j;
          break;
        }
      }
    }
    return idx === -1 ? contents : contents.slice(idx);
  }

  /** İptal/hata sonrası: cevapsız kalan functionCall varsa kapat (API bunu zorunlu tutar). */
  function repair(contents) {
    var last = contents[contents.length - 1];
    if (!last || last.role !== 'model' || !Array.isArray(last.parts)) return false;
    var calls = last.parts.filter(function (p) {
      return p.functionCall;
    });
    if (!calls.length) return false;
    contents.push({
      role: 'user',
      parts: calls.map(function (c) {
        return {
          functionResponse: {
            name: c.functionCall.name,
            response: { ok: false, error: 'İşlem iptal edildi veya yarıda kesildi.' },
          },
        };
      }),
    });
    return true;
  }

  function abortError() {
    var e = new Error('İstek iptal edildi.');
    e.name = 'AbortError';
    e.code = 'aborted';
    return e;
  }

  /**
   * @param {Array} contents  Gemini konuşması; yerinde güncellenir.
   * @param {{signal?:AbortSignal, tools?:boolean, onLive?:Function, onTurn?:Function, onNotice?:Function}} opts
   */
  async function run(contents, opts) {
    opts = opts || {};
    var toolsOn = opts.tools !== false;
    var steps = 0;
    var emptyRetried = false;

    function turn() {
      if (typeof opts.onTurn === 'function') opts.onTurn();
    }
    function live(parts) {
      if (typeof opts.onLive === 'function') opts.onLive(parts);
    }

    while (steps < MAX_STEPS) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      steps++;

      var res;
      try {
        res = await global.Model.generate(windowContents(contents), {
          system: buildSystem(toolsOn),
          tools: toolsOn ? global.Tools.declarations : null,
          signal: opts.signal,
          onParts: live,
        });
      } catch (err) {
        live(null);
        if (err && err.code === 'tools_unsupported' && toolsOn) {
          toolsOn = false;
          steps--;
          if (typeof opts.onNotice === 'function') {
            opts.onNotice('Bu model araç çağırmayı desteklemiyor; metin moduna geçildi (kod blokları dosyalara aktarılır).');
          }
          continue;
        }
        throw err;
      }
      live(null);

      if (!res.parts.length) {
        if (!emptyRetried) {
          emptyRetried = true;
          steps--;
          continue;
        }
        if (typeof opts.onNotice === 'function') {
          opts.onNotice('Model boş yanıt döndürdü' + (res.finishReason ? ' (' + res.finishReason + ')' : '') + '. Tekrar dene.');
        }
        return;
      }

      contents.push({ role: 'model', parts: res.parts });
      turn();

      var calls = res.parts.filter(function (p) {
        return p.functionCall;
      });

      if (!calls.length) {
        if (!toolsOn) {
          var files = global.Model.parseFiles(res.text);
          Object.keys(files).forEach(function (name) {
            try {
              global.Workspace.set(name, files[name]);
            } catch (e) {
              /* geçersiz ad → atla */
            }
          });
        }
        return;
      }

      var responses = calls.map(function (c) {
        return {
          functionResponse: {
            name: c.functionCall.name,
            response: global.Tools.run(c.functionCall.name, c.functionCall.args),
          },
        };
      });
      contents.push({ role: 'user', parts: responses });
      turn();
    }

    if (typeof opts.onNotice === 'function') {
      opts.onNotice('Adım sınırına (' + MAX_STEPS + ') ulaşıldı. Devam etmesi için "devam et" yaz.');
    }
  }

  global.Agent = {
    run: run,
    repair: repair,
    buildSystem: buildSystem,
    windowContents: windowContents,
    getInstructions: getInstructions,
    setInstructions: setInstructions,
    MAX_STEPS: MAX_STEPS,
    BASE_PROMPT: BASE_PROMPT,
  };
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
