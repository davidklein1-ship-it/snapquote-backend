// TEMPORARY — one-time Cloud API registration. Delete after use.
app.get('/register', async (req, res) => {
  try {
    const response = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        pin: '152535',
      }),
    });
    const result = await response.json();
    res.status(response.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).send(err.message);
  }
});
