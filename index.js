const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const SANDBOX_FROM = process.env.WHATSAPP_FROM || 'whatsapp:+14155238886';
const PLUMBER_MOBILE = process.env.PLUMBER_MOBILE || '';

app.get('/', (req, res) => {
  res.send('SnapQuote backend running ✓');
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
        body: `📱 SnapQuote: Missed call from ${callerNumber}. WhatsApp follow-up sent.`,
      });
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  }

  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

// ── INCOMING WHATSAPP ─────────────────────────────────────
app.post('/webhooks/whatsapp-incoming', async (req, res) => {
  const { From, Body, NumMedia, MediaUrl0 } = req.body;
  const callerNumber = From.replace('whatsapp:', '');

  console.log(`💬 Reply from ${callerNumber}: ${Body}`);
  if (NumMedia > 0) console.log(`📷 Photo: ${MediaUrl0}`);

  try {
    await client.messages.create({
      from: SANDBOX_FROM,
      to: From,
      body: buildConfirmationMessage(NumMedia > 0),
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
  }

  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

// ── MESSAGE BUILDERS ──────────────────────────────────────
function buildCustomerMessage() {
  return `Hi 👋 Sorry we missed your call — we're on a job right now.

To get you a quote as quickly as possible, please send:

• What you need help with
• Your postcode
• Photos if possible 📷
• When works best for you

We'll be back to you shortly.

— DS Plumbing & Heating`;
}

function buildConfirmationMessage(hasPhoto) {
  return `Thanks — got your details.${hasPhoto ? '\n📷 Photo received — really helpful!' : ''}

Quote being prepared now. We'll be in touch very shortly.

— DS Plumbing & Heating`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SnapQuote running on port ${PORT}`));
