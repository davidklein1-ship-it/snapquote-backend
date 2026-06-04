const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const callcatchRoutes = require('./callcatch-proxy-route');
app.use(callcatchRoutes);
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

// UK plumber rate defaults
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

// Direct REST API calls to Supabase — no client library
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

// ── CALL STATUS WEBHOOK ───────────────────────────────────
app.post('/webhooks/call-status', async (req, res) => {
  const { CallStatus, From, To } = req.body;
  console.log(`📞 Call status: ${CallStatus} from ${From}`);

  const shouldFire = ['no-answer', 'busy', 'failed', 'completed'].includes(CallStatus);
  if (!shouldFire || !From) {
    return res.set('Content-Type', 'text/xml').send('<Response></Response>');
  }

  const callerNumber = From.replace('whatsapp:', '');

  // Write lead to Supabase via REST
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

  // Send WhatsApp to caller
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

// ── INCOMING WHATSAPP ─────────────────────────────────────
app.post('/webhooks/whatsapp-incoming', async (req, res) => {
  const { From, Body, NumMedia, MediaUrl0 } = req.body;
  const callerNumber = From.replace('whatsapp:', '');
  console.log(`💬 Reply from ${callerNumber}: ${Body}`);
  if (NumMedia > 0) console.log(`📷 Photo: ${MediaUrl0}`);

  // Update lead in Supabase via REST
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

  // Detect if this needs an AI reply — anything conversational, not just questions
  const isJobInfo = Body && /^\s*([A-Z]{1,4}[0-9]{1,2}\s?[0-9][A-Z]{2}|nw|sw|se|ne|n|s|e|w)\d/i.test(Body) && Body.length < 30;
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

  // Send reply
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

// ── MESSAGE BUILDERS ──────────────────────────────────────
function buildCustomerMessage() {
  return `Hi, Sorry we missed your call. I am on a job right now.

To find out whats wrong and to get a quote sent to you as quickly as I can, please send me:
• What you need help with
• Your postcode
• Photos if possible 📷
• When a visit works best for you

I'll be in touch as soon as possible to help.
— DS Plumbing & Heating`;
}

function buildConfirmationMessage(hasPhoto) {
  return `Thanks for the info. I've got your details.${hasPhoto ? "\n📷 Photo received. That's really helpful." : ""}

Your quote is now being prepared. I'll be in touch as soon as I can.
— DS Plumbing & Heating`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 CallCatch running on port ${PORT}`));
