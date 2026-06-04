const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Send a WhatsApp message via Meta Cloud API
async function sendWhatsApp(to, message) {
  const response = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: message },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

async function supabaseInsert(table, data) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

async function supabaseUpdate(table, data, match) {
  const params = new URLSearchParams(match).toString();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(JSON.stringify(result));
  }
  return true;
}

// Health check
app.get('/', (req, res) => {
  res.send('CallCatch backend running');
});

// Meta webhook verification
app.get('/webhooks/whatsapp-incoming', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === 'callcatch2024') {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Claude proxy for tester
app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(response.status).send(text);
  } catch (err) {
    console.error('Claude proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve tester
app.get('/tester', (req, res) => {
  res.sendFile(path.join(__dirname, 'callcatch-tester.html'));
});

// Incoming WhatsApp messages from Meta Cloud API
app.post('/webhooks/whatsapp-incoming', async (req, res) => {
  // Always respond 200 immediately to Meta
  res.status(200).send('OK');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const from = message.from;
    const msgBody = message.type === 'text' ? message.text?.body : null;
    const mediaUrl = message.type === 'image' ? message.image?.id : null;

    console.log('Message from ' + from + ': ' + msgBody);

    // Save to Supabase
    try {
      await supabaseUpdate('leads',
        { message_body: msgBody, issue: msgBody, status: 'New', photo_url: mediaUrl },
        { customer_phone: 'eq.' + from }
      );
    } catch (err) {
      // Lead may not exist yet, try insert
      try {
        await supabaseInsert('leads', {
          customer_phone: from,
          status: 'New',
          message_body: msgBody,
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error('Supabase error:', e.message);
      }
    }

    // Generate AI reply
    let replyMessage = 'Thanks, got your details. We will be in touch shortly.';

    if (msgBody && process.env.ANTHROPIC_API_KEY) {
      try {
        const aiReply = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: 'You are CallCatch, a WhatsApp assistant for a UK plumber. A customer sent: "' + msgBody + '". Reply warmly in 2 sentences max, UK English. Ask for their postcode if not given. Ask about urgency if not clear. Never quote a price. No dashes, use commas.'
          }]
        });
        replyMessage = aiReply.content[0].text;
      } catch (err) {
        console.error('Anthropic error:', err.message);
      }
    }

    // Send reply via Meta Cloud API
    await sendWhatsApp(from, replyMessage);
    console.log('Reply sent to ' + from);

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CallCatch running on port ' + PORT));
