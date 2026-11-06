/**
 * KodAsistan — Ajan Sohbet ve Proje Arayüzü
 * Sohbet merkezde akar; düşünme adımları ve araç çağrıları kart olarak görünür.
 * Yan panelde canlı önizleme ve sanal proje dosyaları yer alır.
 */
(function () {
  'use strict';

  var CONTENTS_KEY = 'kodasistan.contents';
  var LEGACY_HISTORY_KEY = 'kodasistan.chatHistory';
  var TOOLS_ON_KEY = 'kodasistan.tools';
  var SIDE_OPEN_KEY = 'kodasistan.sideOpen';

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  var layoutEl = $('#layout');
  var chatMessagesEl = $('#chat-messages');
  var noticeEl = $('#notice');
  var chatForm = $('#chat-form');
  var chatInput = $('#chat-input');
  var btnSend = $('#btn-send');
  var btnStop = $('#btn-stop');
  var btnModel = $('#btn-model');
  var btnNew = $('#btn-new');
  var btnPanel = $('#btn-panel');
  var btnSettings = $('#btn-settings');

  var tabBtns = document.querySelectorAll('.side-tabs .tab');
  var panePreview = $('#pane-preview');
  var paneFiles = $('#pane-files');
  var fileCountEl = $('#file-count');
  var btnRefreshPreview = $('#btn-refresh-preview');
  var btnClosePanel = $('#btn-close-panel');
  var previewFrame = $('#preview-frame');
  var previewPlaceholder = $('#preview-placeholder');
  var consoleLogEl = $('#console-log');

  var btnFileNew = $('#btn-file-new');
  var btnFileDel = $('#btn-file-del');
  var btnDownload = $('#btn-download');
  var btnClearProject = $('#btn-clear-project');
  var fileListEl = $('#file-list');
  var editorNameEl = $('#editor-name');
  var codeEditor = $('#code-editor');

  var settingsDialog = $('#settings-dialog');
  var settingsForm = $('#settings-form');
  var apiKeyInput = $('#api-key-input');
  var modelInput = $('#model-input');
  var modelOptions = $('#model-options');
  var toolsInput = $('#tools-input');
  var instructionsInput = $('#instructions-input');
  var memoryListEl = $('#memory-list');
  var memoryEmptyEl = $('#memory-empty');

  /** @type {Array<{role:string, parts:Array}>} */
  var contents = [];
  var activeFile = null;
  var activeTab = 'preview';
  var streaming = false;
  var abortController = null;
  var liveTurnEl = null;

  var SUGGESTIONS = [
    'Modern, koyu temalı bir Pomodoro zamanlayıcı uygulaması yap',
    'Sürükle-bırak destekli bir Kanban görev panosu oluştur',
    'Canlı önizlemeli bir Markdown not defteri hazırla',
    'Projedeki dosyaları listele ve yapıyı özetle',
  ];

  // —— Kalıcılık ——
  function loadContents() {
    try {
      var raw = localStorage.getItem(CONTENTS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          contents = parsed;
          return;
        }
      }
    } catch (e) {
      /* bozuksa sıfırla */
    }
    // Eski {role, content} geçmişinden geçiş
    try {
      var oldRaw = localStorage.getItem(LEGACY_HISTORY_KEY);
      if (oldRaw) {
        var oldArr = JSON.parse(oldRaw);
        if (Array.isArray(oldArr) && oldArr.length) {
          contents = oldArr
            .filter(function (m) {
              return m && (m.role === 'user' || m.role === 'assistant') && m.content;
            })
            .map(function (m) {
              return {
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(m.content) }],
              };
            });
          saveContents();
          return;
        }
      }
    } catch (e) {
      /* yok say */
    }
    contents = [];
  }

  function saveContents() {
    try {
      localStorage.setItem(CONTENTS_KEY, JSON.stringify(contents));
    } catch (e) {
      /* kota / gizli mod */
    }
  }

  function isToolsEnabled() {
    try {
      var v = localStorage.getItem(TOOLS_ON_KEY);
      return v === null ? true : v === '1';
    } catch (e) {
      return true;
    }
  }

  function setToolsEnabled(on) {
    try {
      localStorage.setItem(TOOLS_ON_KEY, on ? '1' : '0');
    } catch (e) {
      /* yok say */
    }
  }

  // —— Yardımcılar: HTML kaçış ve hafif Markdown ——
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatInline(text) {
    var s = esc(text);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return s;
  }

  function renderMarkdown(text) {
    var wrap = document.createElement('div');
    wrap.className = 'md';
    var src = String(text || '');
    var fences = [];
    var placeholder = src.replace(/```([^\n`]*)\n([\s\S]*?)```/g, function (_m, hdr, code) {
      var idx = fences.length;
      fences.push({ header: (hdr || '').trim(), code: code.replace(/\n$/, '') });
      return '\u0000FENCE_' + idx + '\u0000';
    });

    var blocks = placeholder.split(/\n{2,}/);
    var htmlParts = [];

    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i].trim();
      if (!b) continue;
      var fenceMatch = b.match(/^\u0000FENCE_(\d+)\u0000$/);
      if (fenceMatch) {
        htmlParts.push(b);
        continue;
      }
      var lines = b.split('\n');
      if (/^#{1,3}\s+/.test(lines[0]) && lines.length === 1) {
        var lvl = lines[0].match(/^(#{1,3})\s+(.*)$/);
        var tag = lvl[1].length === 1 ? 'h3' : lvl[1].length === 2 ? 'h4' : 'h5';
        htmlParts.push('<' + tag + '>' + formatInline(lvl[2]) + '</' + tag + '>');
        continue;
      }
      var isUl = lines.every(function (l) {
        return /^\s*[-*]\s+/.test(l);
      });
      if (isUl) {
        htmlParts.push(
          '<ul>' +
            lines
              .map(function (l) {
                return '<li>' + formatInline(l.replace(/^\s*[-*]\s+/, '')) + '</li>';
              })
              .join('') +
            '</ul>'
        );
        continue;
      }
      var isOl = lines.every(function (l) {
        return /^\s*\d+\.\s+/.test(l);
      });
      if (isOl) {
        htmlParts.push(
          '<ol>' +
            lines
              .map(function (l) {
                return '<li>' + formatInline(l.replace(/^\s*\d+\.\s+/, '')) + '</li>';
              })
              .join('') +
            '</ol>'
        );
        continue;
      }
      htmlParts.push('<p>' + lines.map(formatInline).join('<br>') + '</p>');
    }

    var finalHtml = htmlParts.join('\n').replace(/\u0000FENCE_(\d+)\u0000/g, function (_m, n) {
      var f = fences[Number(n)];
      if (!f) return '';
      var label = f.header || 'kod';
      return (
        '<div class="code">' +
        '<div class="code-head"><span>' +
        esc(label) +
        '</span><button type="button" data-copy-code="' +
        Number(n) +
        '">Kopyala</button></div>' +
        '<pre><code>' +
        esc(f.code) +
        '</code></pre>' +
        '</div>'
      );
    });

    wrap.innerHTML = finalHtml;
    wrap.querySelectorAll('[data-copy-code]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var f = fences[Number(btn.getAttribute('data-copy-code'))];
        if (!f || !navigator.clipboard) return;
        navigator.clipboard.writeText(f.code).then(function () {
          btn.textContent = 'Kopyalandı';
          setTimeout(function () {
            btn.textContent = 'Kopyala';
          }, 1500);
        });
      });
    });
    return wrap;
  }

  // —— Araç kartı yardımcıları ——
  var TOOL_META = {
    list_files: { ico: '≣', label: 'Dosyaları listele' },
    read_file: { ico: '📄', label: 'Dosya oku' },
    write_file: { ico: '✏️', label: 'Dosya yaz' },
    edit_file: { ico: '🔧', label: 'Dosya düzenle' },
    delete_file: { ico: '🗑️', label: 'Dosya sil' },
    get_console: { ico: '⌘', label: 'Konsolu kontrol et' },
    remember: { ico: '★', label: 'Hafızaya kaydet' },
  };

  function buildToolCard(call, responseObj, isRunning) {
    var name = (call && call.name) || 'tool';
    var args = (call && call.args) || {};
    var meta = TOOL_META[name] || { ico: '⚙', label: name };
    var target = args.path || args.note || '';

    var details = document.createElement('details');
    var statusText = 'Çalışıyor…';
    var stateClass = 'run';
    if (!isRunning && responseObj) {
      if (responseObj.ok === false) {
        stateClass = 'err';
        statusText = 'Hata';
      } else {
        stateClass = 'ok';
        if (name === 'write_file') {
          statusText = (responseObj.created ? 'oluşturuldu' : 'güncellendi') + ' (' + (responseObj.chars || 0) + ' kr)';
        } else if (name === 'edit_file') {
          statusText = 'düzenlendi (' + (responseObj.chars || 0) + ' kr)';
        } else if (name === 'read_file') {
          statusText = (responseObj.total_chars || 0) + ' kr okundu';
        } else if (name === 'list_files') {
          statusText = (responseObj.count || 0) + ' dosya';
        } else if (name === 'get_console') {
          statusText = (responseObj.count || 0) + ' kayıt';
        } else {
          statusText = 'Tamam';
        }
      }
    }
    details.className = 'tool ' + stateClass;

    var summary = document.createElement('summary');
    summary.innerHTML =
      '<span class="tool-ico">' +
      esc(meta.ico) +
      '</span>' +
      '<span class="tool-title"><b>' +
      esc(meta.label) +
      '</b>' +
      (target ? ' · <code>' + esc(String(target).slice(0, 80)) + '</code>' : '') +
      '</span>' +
      '<span class="tool-status">' +
      esc(statusText) +
      '</span>';
    details.appendChild(summary);

    var body = document.createElement('div');
    body.className = 'tool-body';

    if (args.path && global.Workspace && global.Workspace.has(args.path)) {
      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-tiny';
      openBtn.textContent = 'Dosyada göster: ' + args.path;
      openBtn.addEventListener('click', function () {
        openSidePanel('files', args.path);
      });
      body.appendChild(openBtn);
    }

    var argLbl = document.createElement('div');
    argLbl.className = 'lbl';
    argLbl.textContent = 'Parametreler';
    var argPre = document.createElement('pre');
    argPre.textContent = JSON.stringify(args, null, 2);
    body.appendChild(argLbl);
    body.appendChild(argPre);

    if (responseObj) {
      var resLbl = document.createElement('div');
      resLbl.className = 'lbl';
      resLbl.textContent = 'Sonuç';
      var resPre = document.createElement('pre');
      resPre.textContent = JSON.stringify(responseObj, null, 2);
      body.appendChild(resLbl);
      body.appendChild(resPre);
    }

    details.appendChild(body);
    return details;
  }

  function buildThoughtCard(text, isRunning) {
    var details = document.createElement('details');
    details.className = 'tool ' + (isRunning ? 'run' : 'ok');
    var summary = document.createElement('summary');
    summary.innerHTML =
      '<span class="tool-ico">💭</span>' +
      '<span class="tool-title"><b>Düşünme adımı</b></span>' +
      '<span class="tool-status">' +
      (isRunning ? 'Düşünüyor…' : 'Tamam') +
      '</span>';
    var body = document.createElement('div');
    body.className = 'tool-body';
    var pre = document.createElement('pre');
    pre.textContent = text;
    body.appendChild(pre);
    details.appendChild(summary);
    details.appendChild(body);
    return details;
  }

  // —— Sohbet çizimi ——
  function renderEmptyState() {
    var wrap = document.createElement('div');
    wrap.className = 'empty';

    var hasKey = global.Model && global.Model.getKey();
    if (!hasKey) {
      var kb = document.createElement('div');
      kb.className = 'keybanner';
      kb.innerHTML =
        'Başlamak için Gemini API anahtarını gir.' +
        '<button type="button" class="btn btn-tiny btn-primary" id="btn-empty-key">Ayarlar’ı aç</button>';
      wrap.appendChild(kb);
    }

    var h2 = document.createElement('h2');
    h2.textContent = 'Bugün ne üzerinde çalışalım?';
    var p = document.createElement('p');
    p.textContent =
      'İstediğin uygulamayı veya değişikliği yaz; dosyaları oluşturup düzenleyeyim, konsolu kontrol edip canlı önizlemede çalıştırayım.';
    wrap.appendChild(h2);
    wrap.appendChild(p);

    var grid = document.createElement('div');
    grid.className = 'suggestions';
    SUGGESTIONS.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'suggestion';
      btn.textContent = s;
      btn.addEventListener('click', function () {
        handleSend(s);
      });
      grid.appendChild(btn);
    });
    wrap.appendChild(grid);
    chatMessagesEl.appendChild(wrap);

    var emptyKeyBtn = $('#btn-empty-key');
    if (emptyKeyBtn) emptyKeyBtn.addEventListener('click', openSettings);
  }

  function renderAssistantParts(parts, responseMap, isLive) {
    var container = document.createElement('div');
    container.className = 'msg-assistant';
    var callIdx = 0;

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (p.thought && typeof p.text === 'string') {
        container.appendChild(buildThoughtCard(p.text, isLive && i === parts.length - 1));
      } else if (typeof p.text === 'string' && p.text.trim()) {
        container.appendChild(renderMarkdown(p.text));
      } else if (p.functionCall) {
        var resp = responseMap && responseMap[callIdx] ? responseMap[callIdx] : null;
        callIdx++;
        container.appendChild(buildToolCard(p.functionCall, resp, isLive && !resp));
      }
    }

    if (isLive && !parts.length) {
      var th = document.createElement('div');
      th.className = 'thinking';
      th.innerHTML = '<span class="dots"><span></span><span></span><span></span></span><span>Düşünüyor…</span>';
      container.appendChild(th);
    }

    return container;
  }

  function renderConversation() {
    chatMessagesEl.innerHTML = '';
    liveTurnEl = null;

    if (!contents.length) {
      renderEmptyState();
      return;
    }

    for (var i = 0; i < contents.length; i++) {
      var turn = contents[i];
      if (!turn || !Array.isArray(turn.parts)) continue;

      var isFnResponseTurn = turn.parts.every(function (p) {
        return p && p.functionResponse;
      });
      if (isFnResponseTurn) continue;

      if (turn.role === 'user') {
        var text = turn.parts
          .map(function (p) {
            return p && typeof p.text === 'string' ? p.text : '';
          })
          .join('\n')
          .trim();
        if (!text) continue;
        var uTurn = document.createElement('div');
        uTurn.className = 'turn msg-user';
        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = text;
        uTurn.appendChild(bubble);
        chatMessagesEl.appendChild(uTurn);
      } else if (turn.role === 'model') {
        // Hemen sonraki tur functionResponse içeriyorsa eşleştir
        var next = contents[i + 1];
        var respList = [];
        if (next && next.role === 'user' && Array.isArray(next.parts)) {
          respList = next.parts
            .filter(function (p) {
              return p && p.functionResponse;
            })
            .map(function (p) {
              return p.functionResponse.response;
            });
        }
        var mTurn = document.createElement('div');
        mTurn.className = 'turn';
        mTurn.appendChild(renderAssistantParts(turn.parts, respList, false));
        chatMessagesEl.appendChild(mTurn);
      } else if (turn.role === 'error') {
        var eTurn = document.createElement('div');
        eTurn.className = 'turn';
        var errBox = document.createElement('div');
        errBox.className = 'msg-error';
        errBox.textContent = (turn.parts[0] && turn.parts[0].text) || 'Hata';
        eTurn.appendChild(errBox);
        chatMessagesEl.appendChild(eTurn);
      }
    }

    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function updateLiveParts(parts) {
    if (parts === null) {
      if (liveTurnEl) {
        liveTurnEl.remove();
        liveTurnEl = null;
      }
      return;
    }
    if (!liveTurnEl) {
      liveTurnEl = document.createElement('div');
      liveTurnEl.className = 'turn';
      chatMessagesEl.appendChild(liveTurnEl);
    }
    liveTurnEl.innerHTML = '';
    liveTurnEl.appendChild(renderAssistantParts(parts || [], null, true));
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function showNotice(msg) {
    if (!noticeEl) return;
    if (!msg) {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
      return;
    }
    noticeEl.textContent = msg;
    noticeEl.hidden = false;
  }

  // —— Yan panel, dosya listesi ve önizleme ——
  function setSideOpen(open) {
    layoutEl.classList.toggle('side-open', !!open);
    btnPanel.setAttribute('aria-pressed', open ? 'true' : 'false');
    try {
      localStorage.setItem(SIDE_OPEN_KEY, open ? '1' : '0');
    } catch (e) {
      /* yok say */
    }
  }

  function switchTab(tab) {
    activeTab = tab === 'files' ? 'files' : 'preview';
    tabBtns.forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === activeTab);
    });
    panePreview.hidden = activeTab !== 'preview';
    paneFiles.hidden = activeTab !== 'files';
  }

  function openSidePanel(tab, selectPath) {
    setSideOpen(true);
    if (tab) switchTab(tab);
    if (selectPath && global.Workspace.has(selectPath)) {
      selectFile(selectPath);
    }
  }

  function selectFile(path) {
    activeFile = path;
    renderFileList();
    if (!path || !global.Workspace.has(path)) {
      editorNameEl.textContent = 'Dosya seç';
      codeEditor.value = '';
      codeEditor.disabled = true;
      return;
    }
    editorNameEl.textContent = path;
    codeEditor.disabled = false;
    codeEditor.value = global.Workspace.get(path) || '';
  }

  function renderFileList() {
    var names = global.Workspace.list();
    fileCountEl.textContent = String(names.length);
    fileListEl.innerHTML = '';

    if (!names.length) {
      var li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'Henüz dosya yok';
      fileListEl.appendChild(li);
      if (activeFile) {
        activeFile = null;
        editorNameEl.textContent = 'Dosya seç';
        codeEditor.value = '';
        codeEditor.disabled = true;
      }
      return;
    }

    if (!activeFile || !global.Workspace.has(activeFile)) {
      activeFile = global.Workspace.has('index.html') ? 'index.html' : names[0];
    }

    names.forEach(function (n) {
      var item = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = n;
      btn.classList.toggle('on', n === activeFile);
      btn.addEventListener('click', function () {
        selectFile(n);
      });
      item.appendChild(btn);
      fileListEl.appendChild(item);
    });

    if (activeFile && document.activeElement !== codeEditor) {
      editorNameEl.textContent = activeFile;
      codeEditor.disabled = false;
      codeEditor.value = global.Workspace.get(activeFile) || '';
    }
  }

  function refreshPreview() {
    var all = global.Workspace.all();
    var names = Object.keys(all);
    if (!names.length) {
      previewPlaceholder.classList.remove('hidden');
      previewFrame.srcdoc = '';
      return;
    }
    if (global.Tools) global.Tools.clearConsole();
    if (consoleLogEl) {
      consoleLogEl.innerHTML = '';
      consoleLogEl.hidden = true;
    }
    previewPlaceholder.classList.add('hidden');
    global.Preview.render(all, previewFrame);
  }

  // —— Gönder / Durdur ——
  function setStreamingState(on) {
    streaming = on;
    btnSend.hidden = on;
    btnStop.hidden = !on;
    chatInput.disabled = false;
  }

  async function handleSend(text) {
    var prompt = (text != null ? text : chatInput.value).trim();
    if (!prompt || streaming) return;

    showNotice('');
    global.Agent.repair(contents);
    contents.push({ role: 'user', parts: [{ text: prompt }] });
    saveContents();

    chatInput.value = '';
    autoResizeInput();
    renderConversation();
    updateLiveParts([]);

    setStreamingState(true);
    abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    try {
      await global.Agent.run(contents, {
        signal: abortController ? abortController.signal : undefined,
        tools: isToolsEnabled(),
        onLive: function (parts) {
          updateLiveParts(parts);
        },
        onTurn: function () {
          saveContents();
          renderConversation();
        },
        onNotice: function (msg) {
          showNotice(msg);
        },
      });
    } catch (err) {
      updateLiveParts(null);
      global.Agent.repair(contents);
      if (err && (err.name === 'AbortError' || err.code === 'aborted')) {
        showNotice('İşlem durduruldu.');
      } else {
        var msg = (err && err.message) || String(err);
        contents.push({ role: 'error', parts: [{ text: msg }] });
        if (err && (err.code === 'no_key' || err.code === 'invalid_key')) {
          openSettings();
        }
      }
      saveContents();
      renderConversation();
    } finally {
      updateLiveParts(null);
      setStreamingState(false);
      abortController = null;
      updateModelChip();
      chatInput.focus();
    }
  }

  function handleStop() {
    if (abortController) abortController.abort();
  }

  // —— Ayarlar ——
  function updateModelChip() {
    var m = global.Model.getModel();
    var toolsTag = isToolsEnabled() ? ' · araçlar açık' : '';
    btnModel.textContent = m + toolsTag;
  }

  function renderMemoryInSettings() {
    var notes = global.Tools.getMemory();
    memoryListEl.innerHTML = '';
    memoryEmptyEl.hidden = notes.length > 0;
    notes.forEach(function (note, idx) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = note;
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Sil';
      del.addEventListener('click', function () {
        global.Tools.removeMemory(idx);
        renderMemoryInSettings();
      });
      li.appendChild(span);
      li.appendChild(del);
      memoryListEl.appendChild(li);
    });
  }

  function openSettings() {
    var existingKey = global.Model.getKey();
    apiKeyInput.value = '';
    apiKeyInput.placeholder = existingKey
      ? '••••••••  (kayıtlı — değiştirmek için yeni anahtar yaz)'
      : 'AIza… (değer maskelenir)';

    modelInput.value = global.Model.getModel();
    modelOptions.innerHTML = '';
    (global.Model.FALLBACK_MODELS || []).forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m;
      modelOptions.appendChild(opt);
    });

    toolsInput.checked = isToolsEnabled();
    instructionsInput.value = global.Agent.getInstructions();
    renderMemoryInSettings();

    if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
    else settingsDialog.setAttribute('open', '');
  }

  // —— Olay dinleyicileri ——
  function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
  }

  chatInput.addEventListener('input', autoResizeInput);

  chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    handleSend();
  });

  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  btnStop.addEventListener('click', handleStop);

  btnNew.addEventListener('click', function () {
    if (streaming) handleStop();
    contents = [];
    saveContents();
    showNotice('');
    renderConversation();
  });

  btnPanel.addEventListener('click', function () {
    setSideOpen(!layoutEl.classList.contains('side-open'));
  });

  btnClosePanel.addEventListener('click', function () {
    setSideOpen(false);
  });

  btnModel.addEventListener('click', openSettings);
  btnSettings.addEventListener('click', openSettings);

  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  btnRefreshPreview.addEventListener('click', refreshPreview);

  codeEditor.addEventListener('input', function () {
    if (!activeFile) return;
    try {
      global.Workspace.set(activeFile, codeEditor.value);
    } catch (e) {
      /* yok say */
    }
  });

  btnFileNew.addEventListener('click', function () {
    var name = prompt('Yeni dosya adı (örn. index.html, style.css, script.js):');
    if (!name) return;
    try {
      var r = global.Workspace.set(name, '');
      selectFile(r.path);
      codeEditor.focus();
    } catch (e) {
      alert(e.message || String(e));
    }
  });

  btnFileDel.addEventListener('click', function () {
    if (!activeFile) return;
    var target = activeFile;
    activeFile = null;
    global.Workspace.remove(target);
    renderFileList();
  });

  btnDownload.addEventListener('click', function () {
    var all = global.Workspace.all();
    if (!Object.keys(all).length) return;
    global.Preview.download(all, 'proje.zip');
  });

  btnClearProject.addEventListener('click', function () {
    if (!global.Workspace.list().length) return;
    if (!confirm('Projedeki tüm dosyalar silinsin mi?')) return;
    activeFile = null;
    global.Workspace.clear();
  });

  settingsForm.addEventListener('submit', function (e) {
    var submitter = e.submitter;
    var val = submitter && submitter.value;
    if (val === 'save') {
      var k = apiKeyInput.value.trim();
      if (k) global.Model.setKey(k);
      var m = modelInput.value.trim();
      if (m) global.Model.setModel(m);
      setToolsEnabled(toolsInput.checked);
      global.Agent.setInstructions(instructionsInput.value);
      updateModelChip();
      if (!contents.length) renderConversation();
    }
    apiKeyInput.value = '';
  });

  // Önizleme konsolu → hem Tools tamponuna hem alt konsol kutusuna
  global.Preview.onConsole(function (entry) {
    global.Tools.pushConsole(entry);
    if (!consoleLogEl) return;
    consoleLogEl.hidden = false;
    var row = document.createElement('div');
    row.className = entry.level || 'log';
    row.textContent = '[' + (entry.level || 'log') + '] ' + (entry.message || '');
    consoleLogEl.appendChild(row);
    consoleLogEl.scrollTop = consoleLogEl.scrollHeight;
  });

  // Dosya değiştiğinde listeyi ve önizlemeyi güncelle, panel kapalıysa aç
  global.Workspace.onChange(function (change) {
    if (change && (change.type === 'create' || change.type === 'update') && change.path) {
      activeFile = change.path;
      if (!layoutEl.classList.contains('side-open')) {
        setSideOpen(true);
      }
    }
    renderFileList();
    refreshPreview();
  });

  // —— Başlangıç ——
  loadContents();
  updateModelChip();
  renderFileList();

  var initialSideOpen = false;
  try {
    var savedSide = localStorage.getItem(SIDE_OPEN_KEY);
    initialSideOpen = savedSide !== null ? savedSide === '1' : global.Workspace.list().length > 0;
  } catch (e) {
    initialSideOpen = global.Workspace.list().length > 0;
  }
  setSideOpen(initialSideOpen);
  refreshPreview();
  renderConversation();
})();
