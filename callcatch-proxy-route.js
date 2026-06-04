// ─────────────────────────────────────────────
// CallCatch — Claude proxy route
// Add this to your existing Express server
// ─────────────────────────────────────────────

const express = require('express');
const router = express.Router();

// Proxy Claude API calls from the tester UI
// POST /api/claude
router.post('/api/claude', async (req, res) => {
  try {
    const { model, max_tokens, system, messages } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error('Claude proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve the tester HTML at /tester
router.get('/tester', (req, res) => {
  res.sendFile('callcatch-tester.html', {
    root: __dirname,
  });
});

module.exports = router;

// ─────────────────────────────────────────────
// In your main server file (e.g. index.js):
//
// const callcatchRoutes = require('./callcatch-proxy-route');
// app.use(callcatchRoutes);
// ─────────────────────────────────────────────
