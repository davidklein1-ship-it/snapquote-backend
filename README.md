# SnapQuote Backend

Webhook server for the missed call → WhatsApp follow-up flow.

## How it works

1. Customer calls your Twilio number
2. They hear the voicemail message (TwiML Bin)
3. Twilio fires a webhook to this server when the call ends
4. Server sends a WhatsApp message to the customer via the sandbox
5. Customer replies with job details + photos
6. Server sends a confirmation back

## Deploy to Railway (5 mins)

### 1. Put this on GitHub
Create a new repo on github.com, upload these files.

### 2. Connect Railway
- Go to railway.app → New Project → Deploy from GitHub
- Select your repo
- Railway auto-detects Node.js and deploys

### 3. Add environment variables
In Railway → your project → Variables, add:

| Variable | Value |
|---|---|
| | TWILIO_ACCOUNT_SID | (from Twilio console — Account Info panel) |
| TWILIO_AUTH_TOKEN | (from Twilio console) |
| WHATSAPP_FROM | whatsapp:+14155238886 |
| PLUMBER_MOBILE | +447700900000 (optional) |

### 4. Get your Railway URL
Railway gives you a URL like `https://snapquote-backend-production.up.railway.app`

### 5. Add webhooks to Twilio

**In your Twilio number Configure tab:**
- "A call comes in" → your TwiML Bin URL
- "Call status changes" → `https://your-railway-url.up.railway.app/webhooks/call-status`

**In Twilio WhatsApp Sandbox settings:**
- "When a message comes in" → `https://your-railway-url.up.railway.app/webhooks/whatsapp-incoming`

### 6. Join the WhatsApp sandbox
Go to Twilio console → Messaging → Try it out → Send a WhatsApp message
Follow the instructions to join the sandbox (text a code to the sandbox number).

## Test it
1. Call your Twilio number from any phone
2. Let it ring through / hang up
3. You should receive a WhatsApp from the sandbox number within seconds

## Local development
```
npm install
cp .env.example .env
# fill in .env
npm run dev
```
Use ngrok to expose localhost: `ngrok http 3000`
Then use the ngrok URL as your webhook temporarily.
