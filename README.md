# KodAsistan

Kişisel kod asistanı web uygulaması. Sol panelde sohbet, ortada kod editörü, altta/sağda canlı önizleme.

## Çalıştırma

```bash
cd /workspace/kod-asistani
npm install
npm start
```

Tarayıcıda: http://localhost:3000

Render: `public/` static site olarak da yayınlanabilir; Node ile `npm start` (`PORT` env) de çalışır.

## Gemini API anahtarı

1. Üst bardaki **Ayarlar** düğmesine tıkla.
2. API anahtarını yapıştır ve kaydet.
3. Anahtar `Model.setKey` ile `localStorage` anahtarı `gemini_key` altında saklanır; sohbete yazılmaz / gösterilmez.
4. `Model.getKey()` ile okunur (REİS `model.js`).

## Dosyalar

| Dosya | Kim | Ne |
|-------|-----|-----|
| `public/index.html` | UI | Arayüz iskeleti |
| `public/style.css` | UI | Koyu tema |
| `public/app.js` | UI | Sohbet, ayarlar, Model/Preview bağlama |
| `public/model.js` | REİS | Gemini bağlantısı |
| `public/preview.js` | REİS | Önizleme motoru |
| `server.js` | UI | Express static + health |
