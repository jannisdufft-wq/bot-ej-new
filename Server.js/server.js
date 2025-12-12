// server.js
const express = require('express');
const app = express();

// Einfacher Webserver, Replit braucht einen Port
app.get('/', (req, res) => {
  res.send('Bot is running ✅');
});

// Port von Replit oder 3000 fallback
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(Webserver, online, on .PORT, `${PORT}`);
});