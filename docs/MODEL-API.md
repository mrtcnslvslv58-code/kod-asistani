# Kod Asistanı — Model & Preview API (BRO için)

Statik site. Backend yok. Gemini API tarayıcıdan doğrudan çağrılır; anahtar `localStorage` içinde tutulur.

Dosyalar:

- `public/model.js` → `window.Model`
- `public/preview.js` → `window.Preview`
- `public/dev.html` → modül test sayfası

Script etiketleri (BRO UI):

```html
<script src="./model.js"></script>
<script src="./preview.js"></script>
```

## Model seçimi ve uç nokta

| Alan | Değer |
|------|--------|
| Varsayılan model | `gemini-3.8-flash` (ücretsiz katman) |
| REST streaming | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` |
| Kimlik doğrulama | Header: `x-goog-api-key: <anahtar>` |
| CORS | Tarayıcıdan desteklenir (kullanıcının kendi anahtarıyla) |

Kaynaklar:

- [Streaming REST (Google Gemini Cookbook)](https://github.com/google-gemini/cookbook/blob/main/quickstarts/rest/Streaming_REST.ipynb) — model id `gemini-3.8-flash`, `alt=sse`
- [streamGenerateContent API](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)
- [CORS / ücretsiz katman doğrulaması (cors.dev, Eki 2026)](https://cors.dev/guides/free-ai-api)

`Model.setModel(name)` ile model değiştirilebilir (`localStorage` anahtarı: `gemini_model`).

---

## `window.Model`

### Anahtar / model

```js
Model.getKey()          // string — localStorage 'gemini_key'
Model.setKey(k)         // boş/null → siler
Model.getModel()        // varsayılan: 'gemini-3.8-flash'
Model.setModel(name)
Model.DEFAULT_MODEL     // 'gemini-3.8-flash'
```

### `Model.chat(messages, onChunk?, { signal }?) → Promise<string>`

- `messages`: `[{ role: 'user' | 'assistant', content: string }, ...]`
  - `assistant` Gemini'de `model` rolüne çevrilir.
- `onChunk(textSoFar, delta)`: her SSE parçasında çağrılır.
- `signal`: `AbortController.signal` — iptal için.
- Dönüş: birleşik tam metin.
- Sistem promptu (Türkçe, sabit): uzman kod asistanı; web uygulamasında fence'li dosya blokları (`file=index.html` vb.); yanıtlar Türkçe.

Örnek:

```js
const ctrl = new AbortController();
const text = await Model.chat(
  [{ role: 'user', content: 'Merhaba, basit bir sayaç yaz' }],
  (soFar, delta) => { /* soFar'ı ekrana yaz */ },
  { signal: ctrl.signal }
);
```

### `Model.parseFiles(text) → { [filename]: content }`

Fence'li kod bloklarından dosya haritası:

1. ` ```html file=index.html ` / `file=style.css`
2. İlk satır: `// script.js` veya `/* style.css */` veya `<!-- index.html -->`
3. Dil `html` ve dosya adı yoksa → `index.html`
4. Dil `css` / `js` ve ad yoksa → `style.css` / `script.js`

```js
const files = Model.parseFiles(assistantText);
// { "index.html": "...", "style.css": "...", "script.js": "..." }
```

### Hatalar (Türkçe `Error.message`, `error.code`)

| Durum | `code` | Mesaj (özet) |
|-------|--------|----------------|
| Anahtar yok | `no_key` | API anahtarı yok… |
| HTTP 400 / 403 | `invalid_key` | API anahtarı geçersiz veya yetkisiz… |
| HTTP 429 | `quota` | `Günlük/dakikalık ücretsiz kota doldu, biraz sonra tekrar dene` |
| Ağ / fetch | `network` | Ağ hatası: Gemini API'ye ulaşılamadı… |
| Abort | `aborted` | İstek iptal edildi. |

---

## `window.Preview`

### `Preview.render(files, iframeEl)`

- `files`: `Model.parseFiles` çıktısı.
- `index.html` üzerinden `srcdoc` üretir; yerel `href`/`src` ile referans edilen css/js dosyalarını inline eder.
- `style.css` / `script.js` referans edilmemiş olsa bile varsa otomatik enjekte edilir.
- `sandbox="allow-scripts allow-forms allow-modals"` (**`allow-same-origin` yok**).

### `Preview.onConsole(cb)`

iframe içinden `postMessage` ile gelen konsol / hata olayları:

```js
Preview.onConsole((entry) => {
  // entry: { level, args, message }
});
```

### `Preview.download(files, zipName?)`

Küçük gömülü ZIP yazıcı (CDN yok, STORE). Varsayılan ad: `proje.zip`.

### Yardımcılar (test / ileri kullanım)

- `Preview.buildSrcdoc(files) → string`
- `Preview.buildZip(files) → Uint8Array`

---

## BRO entegrasyon akışı

1. Ayarlar ekranında `Model.setKey` / `Model.setModel`.
2. Sohbette `Model.chat` + stream'i balona yaz.
3. Yanıt bitince `files = Model.parseFiles(text)`.
4. Dosya varsa `Preview.render(files, iframe)` + `Preview.onConsole` ile konsol paneli.
5. İndir: `Preview.download(files)`.

Test: `public/dev.html` — anahtar, stream, sahte SSE, önizleme, ZIP.
