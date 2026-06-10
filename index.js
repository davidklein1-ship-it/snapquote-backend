const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── WHATSAPP ──────────────────────────────────────────────
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

// Template send — required for business-initiated messages (missed-call opener)
async function sendMissedCallTemplate(toNumber) {
  const to = String(toNumber).replace(/\D/g, ''); // digits only, no +
  const response = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: {
        name: process.env.WHATSAPP_TEMPLATE_NAME || 'missed_call_recovery',
        language: { code: 'en_GB' }, // must match the language the template was approved under
      },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

// ── SUPABASE HELPERS ──────────────────────────────────────
async function dbGet(table, filters) {
  const params = Object.entries(filters).map(([k,v]) => `${k}=${v}`).join('&');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return response.json();
}

async function dbInsert(table, data) {
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

async function dbUpdate(table, data, filters) {
  const params = Object.entries(filters).map(([k,v]) => `${k}=${v}`).join('&');
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

// ── CONVERSATION MEMORY ───────────────────────────────────
async function getOrCreateConversation(customerPhone) {
  // Check for existing open conversation
  const existing = await dbGet('conversations', {
    customer_phone: `eq.${customerPhone}`,
    status: 'eq.open',
    'order': 'created_at.desc',
    'limit': '1'
  });

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  // Create new conversation
  const created = await dbInsert('conversations', {
    customer_phone: customerPhone,
    status: 'open',
    created_at: new Date().toISOString(),
  });
  return created[0].id;
}

async function getConversationHistory(conversationId) {
  const messages = await dbGet('messages', {
    conversation_id: `eq.${conversationId}`,
    'order': 'id.asc',
    'limit': '20'
  });
  if (!messages || messages.length === 0) return [];

  return messages.map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body
  }));
}

async function saveMessage(conversationId, direction, body) {
  await dbInsert('messages', {
    conversation_id: conversationId,
    direction: direction,
    body: body,
    channel: 'whatsapp',
    created_at: new Date().toISOString(),
  });
}

// ── CALLCATCH SYSTEM PROMPT ───────────────────────────────
const SYSTEM_PROMPT = `You are CallCatch, a WhatsApp assistant for a UK plumbing and heating business.

A customer missed a call and you are following up to qualify their job. Your job is to collect:
1. What the problem is
2. How urgent it is
3. Their postcode
4. For non-emergencies: when they are available

URGENCY RULES:
HIGH (emergency): burst pipe, flooding, major leak, no heating in winter, gas smell, overflowing toilet. For HIGH urgency skip timing entirely and fire the proposal immediately after postcode.
MEDIUM: boiler issue, persistent leak, blocked drain. Ask timing.
LOW: planned work, service, quote. Ask timing.

CRITICAL RULES:
- Read the full conversation history before responding. Never ask for information already given.
- If they already gave their postcode, do not ask again.
- If they already described the problem, do not ask again.
- Ask ONE question at a time.
- Maximum 2 sentences per reply.
- UK English only. Warm and human, like a smart PA.
- Never quote a price.
- Never use dashes, use commas instead.
- No bullet points or lists.
- Once you have all the information needed, say "Perfect, I have got all the details and am passing this to [plumber] now, he will be in touch very shortly."`;

// ── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => res.send('CallCatch backend running'));

// Voice webhook — a forwarded call landing here IS a missed call
app.post('/voice/incoming', async (req, res) => {
  // Log everything Twilio sends so we can see where the customer's number lives on forwarded calls
  console.log('INBOUND CALL:', JSON.stringify({
    From: req.body.From,
    To: req.body.To,
    ForwardedFrom: req.body.ForwardedFrom,
    CalledVia: req.body.CalledVia,
    CallerName: req.body.CallerName,
    CallSid: req.body.CallSid,
  }));

  const customer = req.body.From;

  // Don't try to WhatsApp withheld/anonymous callers
  if (customer && customer.startsWith('+')) {
    try {
      await sendMissedCallTemplate(customer);
      console.log('Missed-call WhatsApp sent to ' + customer);
    } catch (err) {
      console.error('WhatsApp send FAILED:', err.message);
    }
  } else {
    console.log('Caller ID withheld or invalid, skipping WhatsApp:', customer);
  }

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Sorry we missed your call. We're sending you a WhatsApp message now.</Say>
  <Hangup/>
</Response>`);
});

// TEMPORARY — direct template send test. Delete after testing.
app.get('/test-send', async (req, res) => {
  try {
    const result = await sendMissedCallTemplate('+447779300431');
    res.json(result);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

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

// Claude proxy for tester UI
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
    res.status(500).json({ error: err.message });
  }
});

// Serve tester
app.get('/tester', (req, res) => {
  res.sendFile(path.join(__dirname, 'callcatch-tester.html'));
});

// Incoming WhatsApp from Meta Cloud API
app.post('/webhooks/whatsapp-incoming', async (req, res) => {
  res.status(200).send('OK');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const msgBody = message.type === 'text' ? message.text?.body : null;
    if (!msgBody) return;

    console.log('Inbound from ' + from + ': ' + msgBody);

    // Get or create conversation
    const conversationId = await getOrCreateConversation(from);

    // Save inbound message
    await saveMessage(conversationId, 'inbound', msgBody);

    // Load full history for context
    const history = await getConversationHistory(conversationId);

    // Generate AI reply with full history
    let replyMessage = 'Thanks, got your details, we will be in touch shortly.';

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const aiReply = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 300,
          system: SYSTEM_PROMPT,
          messages: history
        });
        replyMessage = aiReply.content[0].text;
        console.log('AI reply: ' + replyMessage);
      } catch (err) {
        console.error('Anthropic error:', err.message);
      }
    }

    // Save outbound message
    await saveMessage(conversationId, 'outbound', replyMessage);

    // Send via Meta Cloud API
    await sendWhatsApp(from, replyMessage);
    console.log('Reply sent to ' + from);

    // Update lead record
    try {
      await dbUpdate('leads',
        { message_body: msgBody, status: 'New' },
        { customer_phone: `eq.${from}` }
      );
    } catch (e) {
      try {
        await dbInsert('leads', {
          customer_phone: from,
          status: 'New',
          message_body: msgBody,
          created_at: new Date().toISOString(),
        });
      } catch (e2) {
        console.error('Lead save error:', e2.message);
      }
    }

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CallCatch running on port ' + PORT));
