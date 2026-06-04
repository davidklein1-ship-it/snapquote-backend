const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SANDBOX_FROM = process.env.WHATSAPP_FROM || 'whatsapp:+14155238886';
const PLUMBER_MOBILE = process.env.PLUMBER_MOBILE || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DEFAULT_RATES = {
  callOut: '£80-£110',
  hourly: '£50-£75/hr',
  emergency: '£100-£150 call-out plus hourly rate',
  blockedToilet: '£100-£150',
  leakingTap: '£80-£120',
  boilerService: '£80-£120',
  drainClearance: '£75-£200',
  responseTime: '24-48 hours for non-emergencies, same day for emergencies',
};

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

// Call status webhook
app.post('/webhooks/call-status', async (req, res) => {
  const { CallStatus, From, To } = req.body;
  console.log('Call status: ' + CallStatus + ' from ' + From);

  const shouldFire = ['no-answer', 'busy', 'failed', 'completed'].includes(CallStatus);
  if (!shouldFire || !From) {
    return res.set('Content-Type', 'text/xml').send('<Response></Response>');
  }

  const callerNumber = From.replace('whatsapp:', '');

  try {
    const result = await supabaseInsert('leads', {
      customer_phone: 'whatsapp:' + callerNumber,
      status: 'New',
      message_body: 'Missed call from ' + callerNumber,
      created_at: new Date().toISOString(),
    });
    console.log('Lead saved: ' + result[0]?.id);
  } catch (err) {
    console.error('Supabase insert error:', err.message);
  }

  try {
    await client.messages.create({
      from: SANDBOX_FROM,
      to: 'whatsapp:' + callerNumber,
      body: 'Hi, sorry we missed your call. Can you tell me the problem and your postcode?',
    });
    console.log('WhatsApp sent to ' + callerNumber);

    if (PLUMBER_MOBILE) {
      await client.messages.create({
        from: To,
        to: PLUMBER_MOBILE,
        body: 'CallCatch: Missed call from ' + callerNumber + '. WhatsApp follow-up sent.',
      });
    }
  } catch (err) {
    console.error('Twilio error:', err.message);
  }

  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

// Incoming WhatsApp
app.post('/webhooks/whatsapp-incoming', async (req, res) => {
  const { From, Body, NumMedia, MediaUrl0 } = req.body;
  const callerNumber = From.replace('whatsapp:', '');
  console.log('Reply from ' + callerNumber + ': ' + Body);

  try {
    await supabaseUpdate('leads',
      {
        message_body: Body,
        issue: Body,
        status: 'New',
        photo_url: NumMedia > 0 ? MediaUrl0 : null,
      },
      { customer_phone: 'eq.whatsapp:' + callerNumber }
    );
  } catch (err) {
    console.error('Supabase update error:', err.message);
  }

  const isShortPostcode = Body && Body.trim().split(/\s+/).length <= 3 && /[A-Z0-9]/i.test(Body);
  const isConversational = Body && (
    Body.includes('?') || Body.includes('!') ||
    /\b(how|when|what|where|why|who|can|could|would|will|do|does|is|are|have|has|price|cost|charge|urgent|emergency|today|boiler|leak|pipe|drain|toilet|tap|heating|water|blocked|burst|flooding)\b/i.test(Body)
  );
  const isQuestion = isConversational && !isShortPostcode;

  let replyMessage;

  if (isQuestion && process.env.ANTHROPIC_API_KEY) {
    try {
      const aiReply = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: 'You are a WhatsApp assistant for DS Plumbing & Heating. A customer sent: "' + Body + '". Reply warmly and briefly in 2-3 sentences UK English. Never quote exact prices. End with "DS Plumbing & Heating".'
        }]
      });
      replyMessage = aiReply.content[0].text;
    } catch (err) {
      console.error('Anthropic error:', err.message);
      replyMessage = 'Thanks, got your details. We will be in touch shortly.';
    }
  } else {
    replyMessage = 'Thanks, got your details.' + (NumMedia > 0 ? ' Photo received, really helpful.' : '') + ' We will be in touch shortly.';
  }

  try {
    await client.messages.create({
      from: SANDBOX_FROM,
      to: From,
      body: replyMessage,
    });
  } catch (err) {
    console.error('Twilio error:', err.message);
  }

  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CallCatch running on port ' + PORT));
