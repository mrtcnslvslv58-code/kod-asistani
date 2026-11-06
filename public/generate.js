/**
 * Model.generate — araç çağrısı (function calling) destekli Gemini akışı.
 * model.js'ten sonra yüklenir; anahtar, model seçimi ve 503/429 yedek zinciri aynı kalır.
 *
 *   var r = await Model.generate(contents, { system, tools, signal, onParts });
 *   r.parts → modelin ham parça listesi (thoughtSignature dahil, geri gönderilmek üzere olduğu gibi saklanmalı)
 */
(function (global) {
  'use strict';

  var Model = global.Model;
  if (!Model || !Model._internal) {
    if (typeof console !== 'undefined') console.error('[KodAsistan] generate.js: model.js önce yüklenmeli');
    return;
  }

  var turkishError = Model._internal.turkishError;
  var buildModelList = Model._internal.buildModelList;

  function isPlainText(p) {
    return p && typeof p.text === 'string' && !p.thought && !p.functionCall && !p.functionResponse;
  }

  /** Akan parçaları birleştirir: art arda gelen düz metinler tek parça olur, imza korunur. */
  function addPart(acc, part) {
    if (!part || typeof part !== 'object') return;
    var last = acc[acc.length - 1];
    if (isPlainText(part) && last && isPlainText(last) && !last.thoughtSignature) {
      last.text += part.text;
      if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
      return;
    }
    acc.push(JSON.parse(JSON.stringify(part)));
  }

  function visibleText(parts) {
    var out = '';
    for (var i = 0; i < parts.length; i++) if (isPlainText(parts[i])) out += parts[i].text;
    return out;
  }

  async function generate(contents, opts) {
    opts = opts || {};
    var key = Model.getKey();
    if (!key) {
      var noKey = new Error("API anahtarı yok. Ayarlar'dan Gemini API anahtarını gir.");
      noKey.code = 'no_key';
      throw noKey;
    }

    var body = {
      contents: contents,
      generationConfig: { temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4 },
    };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.tools && opts.tools.length) body.tools = [{ functionDeclarations: opts.tools }];

    var models = buildModelList();
    var response = null;
    var usedModel = null;
    var lastStatus = 0;
    var lastErr = '';

    for (var mi = 0; mi < models.length; mi++) {
      var model = models[mi];
      var url =
        Model.API_BASE + '/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse';
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
      } catch (err) {
        throw turkishError(0, '', err);
      }
      if (response.ok) {
        usedModel = model;
        if (model !== Model.getModel()) Model.setModel(model);
        break;
      }
      lastStatus = response.status;
      try {
        lastErr = await response.text();
      } catch (e) {
        lastErr = '';
      }
      response = null;
      // Yoğunluk, kota ya da bu modelde yok → sıradaki modele geç
      if (lastStatus === 503 || lastStatus === 429 || lastStatus === 404) continue;
      // Anahtar sorunu değil de araç şeması reddedildiyse çağırana bildir
      if (lastStatus === 400 && opts.tools && !/api key/i.test(lastErr) && /function|tool|schema/i.test(lastErr)) {
        var te = new Error('Bu model araç çağırmayı desteklemiyor veya şemayı reddetti.');
        te.code = 'tools_unsupported';
        te.status = 400;
        te.detail = lastErr;
        throw te;
      }
      throw turkishError(lastStatus, lastErr, null);
    }
    if (!response) throw turkishError(lastStatus || 503, lastErr, null);
    if (!response.body || !response.body.getReader) {
      throw turkishError(0, '', new Error('Streaming desteklenmiyor'));
    }

    var parts = [];
    var finishReason = '';
    var blockReason = '';
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function handlePayload(payload) {
      var json;
      try {
        json = JSON.parse(payload);
      } catch (e) {
        return;
      }
      if (json && json.error) {
        var st = json.error.code || 400;
        if (typeof st === 'string') st = 400;
        throw turkishError(st, JSON.stringify(json.error), null);
      }
      if (json && json.promptFeedback && json.promptFeedback.blockReason) {
        blockReason = json.promptFeedback.blockReason;
      }
      var cand = json && json.candidates && json.candidates[0];
      if (!cand) return;
      if (cand.finishReason) finishReason = cand.finishReason;
      var ps = cand.content && cand.content.parts;
      if (!ps) return;
      for (var i = 0; i < ps.length; i++) addPart(parts, ps[i]);
      if (typeof opts.onParts === 'function') {
        try {
          opts.onParts(parts);
        } catch (cbErr) {
          /* arayüz hatası akışı kesmesin */
        }
      }
    }

    function handleLine(raw) {
      var line = raw.replace(/\r$/, '');
      if (!line || line.charAt(0) === ':' || line.indexOf('data:') !== 0) return;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      handlePayload(payload);
    }

    while (true) {
      var chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw turkishError(0, '', err);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var li = 0; li < lines.length; li++) handleLine(lines[li]);
    }
    if (buffer) handleLine(buffer);

    if (!parts.length && blockReason) {
      var blocked = new Error('İstek güvenlik filtresine takıldı (' + blockReason + '). Farklı ifade etmeyi dene.');
      blocked.code = 'blocked';
      throw blocked;
    }

    return {
      parts: parts,
      text: visibleText(parts),
      finishReason: finishReason,
      model: usedModel,
    };
  }

  Model.generate = generate;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
