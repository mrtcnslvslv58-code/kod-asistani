const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', app: 'KodAsistan' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`KodAsistan http://localhost:${PORT} üzerinde çalışıyor`);
});
