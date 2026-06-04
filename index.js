const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
require('./callcatch-proxy-route')(app);

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
  callOut: '£80–£110',
  hourly: '£50–£75/hr',
  emergency: '£100–£150 call-out plus hourly rate',
  blockedToilet: '£100–£150',
  leakingTap: '£80–£120',
  boilerService: '£80–£120',
  drainClearance: '£75–£200',
  responseTime: '24–48 hours for non-emergencies, same day for emergencies',
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

app.get('/', (req, res) => {
  res.send('CallCatch backend running ✓');
});

app.post('/webhooks/call-status', async (req, res) => {
  const { CallStatus, From, To } = req.body;
  console.log(`📞 Call status: ${CallStatus} from ${From}`);

  const shouldFire = ['no-answer', 'busy', 'failed', 'completed'].includes(CallStatus);
  if (!shouldFire || !From) {
    return res.set('Content-Type', 'text/xml').send('<Response></Response>');
  }

  const callerNumber = From.replace('whatsapp:', '');

  try {
    const result = await supabaseInsert('leads', {
      customer_phone: `whatsapp:${callerNumber}`,
      status: 'New',
      message_body: `Missed call from ${callerNumber}`,
      created_at: new Date().toISOString(),
    });
    console.log(`✅ Lead saved to Supabase: ${result[0]?.id}`);
  } catch (err) {
    console.error('❌ Supabase insert error:', err.message);
  }

  try {
    await client.messages.create({
      from: SANDBOX_FROM,
      to: `whatsapp:${callerNumber}`,
      body: buildCustomerMessage(),
    });
    console.log(`✅ WhatsApp sent to ${callerNumber}`);

    if (PLUMBER_MOBILE) {
      await client.messages.create({
        from: To,
        to: PLUMBER_MOBILE,
        body: `📱 CallCatch: Missed call from ${callerNumber}. WhatsApp follow-up sent.`,
      });
    }
  } catch (err) {
    console.error('❌ Twilio error:', err.message);
  }

  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

app.post('/webhooks/whatsapp-incoming', async (req, res) => {
  const { From, Body, NumMedia, MediaUrl0 } = req.body;
  const callerNumber = From.replace('whatsapp:', '');
  console.log(`💬 Reply from ${callerNumber}: ${Body}`);
  if (NumMedia > 0) console.log(`📷 Photo: ${MediaUrl0}`);

  try {
    await supabaseUpdate('leads',
      {
        message_body: Body,
        issue: Body,
        status: 'New',
        photo_url: NumMedia > 0 ? MediaUrl0 : null,
      },
      { customer_phone: `eq.whatsapp:${callerNumber}` }
    );
    console.log(`✅ Lead updated in Supabase for ${callerNumber}`);
  } catch (err) {
    console.error('❌ Supabase update error:', err.message);
  }

  const isShortPostcode = Body && Body.trim().split(/\s+/).length <= 3 && /[A-Z0-9]/i.test(Body);
  const isConversational = Body && (
    Body.includes('?') ||
    Body.includes('!') ||
    /\b(how|when|what|where|why|who|can|could|would|will|do|does|is|are|have|has|how much|any idea|price|cost|charge|available|soon|urgent|emergency|today|tomorrow|radiator|boiler|leak|pipe|drain|toilet|tap|heating|water|fix|repair|replace|help|thanks|thank|cheers|mate|please|asap|quickly|fast|quick|issue|problem|broken|blocked|burst|flooded|flooding|dripping|running|hot|cold|pressure)\b/i.test(Body)
  );
  const isQuestion = isConversational && !isShortPostcode;

  let replyMessage;

  if (isQuestion && process.env.ANTHROPIC_API_KEY) {
    console.log(`🤖 Question detected — generating AI reply`);
    try {
      const aiReply = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are replying on behalf of DS Plumbing & Heating, a professional plumber in London. 
          
A customer has sent this WhatsApp message after missing a call: "${Body}"

Reply naturally and helpfully as the plumber would. Keep it conversational, warm and brief (2-4 sentences max).

If they sound frustrated or impatient, acknowledge it briefly and be reassuring.
If they've given job details, confirm you've got them and will be in touch.
If they're asking about price or timing, give a helpful ballpark.
If it's a statement about what's wrong, acknowledge the issue specifically and say you'll sort it.

Key facts to use if relevant:
- Call-out charge: ${DEFAULT_RATES.callOut} (includes first hour)
- Hourly rate: ${DEFAULT_RATES.hourly}
- Emergency call-out: ${DEFAULT_RATES.emergency}
- Common jobs: blocked toilet ${DEFAULT_RATES.blockedToilet}, leaking tap ${DEFAULT_RATES.leakingTap}, boiler service ${DEFAULT_RATES.boilerService}
- Typical response time: ${DEFAULT_RATES.responseTime}
- Always say exact prices depend on the job once we see it
- End with "— DS Plumbing & Heating"
- Never make promises you can't keep
- Sound like a real plumber texting a customer, not a chatbot
- Never start with "Hi there" — vary the opening`
        }]
      });

      replyMessage = aiReply.content[0].text;
      console.log(`✅ AI reply generated`);
    } catch (err) {
      console.error('❌ Anthropic error:', err.message);
      replyMessage = buildConfirmationMessage(NumMedia > 0);
    }
  } else {
    replyMessage = buildConfirmationMessage(NumMedia > 0);
  }

  try {
    await client.messages.create({
      from: SANDBOX_FROM,
      to: From,
      body: replyMessage,
    });
  } catch (err) {
    console.error('❌ Twilio error:', err.message);
  }

  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

function buildCustomerMessage() {
  return `Hi, sorry we missed your call. Can you tell me the problem and your postcode?`;
}

function buildConfirmationMessage(hasPhoto) {
  return `Thanks, got your details.${hasPhoto ? '\n📷 Photo received, really helpful.' : ''} We will be in touch shortly.`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 CallCatch running on port ${PORT}`));
