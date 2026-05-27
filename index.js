const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
 
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
 
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
 
const SANDBOX_FROM = process.env.WHATSAPP_FROM || 'whatsapp:+14155238886';
const PLUMBER_MOBILE = process.env.PLUMBER_MOBILE || '';
 
// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
 
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
        phone: callerNumber,
        status: 'new',
        call_status: CallStatus,
        twilio_number: To,
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
        status: 'new',
        customer_message: Body,
        has_photo: NumMedia > 0,
        photo_url: NumMedia > 0 ? MediaUrl0 : null,
        updated_at: new Date().toISOString(),
      })
      .eq('phone', callerNumber)
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
 
  // Send confirmation to customer
  try {
    await client.messages.create({
      from: SANDBOX_FROM,
      to: From,
      body: buildConfirmationMessage(NumMedia > 0),
    });
  } catch (err) {
    console.error('❌ Twilio error:', err.message);
  }
 
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});
 
// ── MESSAGE BUILDERS ──────────────────────────────────────
function buildCustomerMessage() {
  return `Hi, Sorry we missed your call. I am on a job right now.
 
To find out whats wrong and to get a quote sent to you as quickly as possible, please can send me:
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
