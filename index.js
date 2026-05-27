const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

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

// Supabase client
const ws = require('ws');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    realtime: {
      transport: ws
    }
  }
);

// UK plumber rate defaults (overridden by plumber's own rate card when available)
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

  // Write lead to Supabase
  try {
    const { data, error } = await supabase
      .from('leads')
      .insert({
        customer_phone: `whatsapp:${callerNumber}`,
        status: 'New',
        message_body: `Missed call from ${callerNumber}`,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Supabase insert error:', error.message);
    } else {
      console.log(`✅ Lead saved to Supabase: ${data.id}`);
    }
  } catch (err) {
    console.error('❌ Supabase error:', err.message);
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

  // Update lead in Supabase with customer reply
  try {
    const { error } = await supabase
      .from('leads')
      .update({
        message_body: Body,
        issue: Body,
        status: 'New',
        photo_url: NumMedia > 0 ? MediaUrl0 : null,
      })
      .eq('customer_phone', `whatsapp:${callerNumber}`)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('❌ Supabase update error:', error.message);
    } else {
      console.log(`✅ Lead updated in Supabase for ${callerNumber}`);
    }
  } catch (err) {
    console.error('❌ Supabase error:', err.message);
  }

  // Decide: is this a question or just job info?
  const isQuestion = Body && (
    Body.includes('?') ||
    /\b(how much|any idea|what does|what will|when can|how long|do you|can you|are you|is it|will it|price|cost|charge|available|availability|soon|urgent|emergency|today|tomorrow)\b/i.test(Body)
  );

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

Key facts to use if relevant:
- Call-out charge: ${DEFAULT_RATES.callOut} (includes first hour)
- Hourly rate: ${DEFAULT_RATES.hourly}
- Emergency call-out: ${DEFAULT_RATES.emergency}
- Common jobs: blocked toilet ${DEFAULT_RATES.blockedToilet}, leaking tap ${DEFAULT_RATES.leakingTap}, boiler service ${DEFAULT_RATES.boilerService}
- Typical response time: ${DEFAULT_RATES.responseTime}
- Always say exact prices depend on the job once we see it
- End with "— DS Plumbing & Heating"
- Never make promises you can't keep
- Sound like a real plumber, not a chatbot`
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
