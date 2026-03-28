require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_SHOP = process.env.SHOPIFY_STORE_DOMAIN || 'cncelectric.myshopify.com';
const SCOPES = 'read_analytics,read_customers,write_customers,read_price_rules,read_discounts,write_draft_orders,read_draft_orders,read_fulfillments,write_fulfillments,read_inventory,write_inventory,read_marketing_events,read_orders,write_orders,read_products,write_products,read_reports,read_shipping,read_themes,write_themes,read_online_store_navigation,write_online_store_navigation,read_online_store_pages,write_online_store_pages,read_metaobjects,write_metaobjects,read_content,write_content,read_locales,write_locales';

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '.')));

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── WhatsApp Config ──────────────────────────────────────────────────────────
const WA_TOKEN = process.env.META_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID || '1056575127539679';
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'cnc_electric_verify_2024';
const OWNER_PHONES = (process.env.OWNER_PHONES || '923020011194,923228064444').split(',');

// ─── Shopify OAuth ────────────────────────────────────────────────────────────
app.get('/shopify-auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/shopify-callback`;
  const authUrl = `https://${SHOPIFY_SHOP}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${SCOPES}&redirect_uri=${redirectUri}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/shopify-callback', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await axios.post(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      code,
    });
    const token = response.data.access_token;
    res.send(`<html><body style="background:#0a0c0f;color:#00d4ff;font-family:monospace;padding:40px;">
      <h2>✅ Shopify Token Mila!</h2>
      <code style="background:#111;padding:15px;display:block;border:1px solid #00d4ff;margin:10px 0;word-break:break-all;">${token}</code>
    </body></html>`);
  } catch (err) {
    res.send(`<p style="color:red;">Error: ${err.message}</p>`);
  }
});

// ─── Shopify Helpers ──────────────────────────────────────────────────────────
const SHOPIFY_BASE = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`;
const shopifyHeaders = {
  'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_KEY,
  'Content-Type': 'application/json',
};

async function getShopifyOrders(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const res = await axios.get(`${SHOPIFY_BASE}/orders.json`, {
    headers: shopifyHeaders,
    params: {
      status: 'any',
      created_at_min: since.toISOString(),
      limit: 250,
      fields: 'id,created_at,total_price,financial_status,fulfillment_status,line_items,customer',
    },
  });
  return res.data.orders;
}

async function getShopifySalesStats(days = 7) {
  const orders = await getShopifyOrders(days);
  const paid = orders.filter(o => o.financial_status === 'paid' || o.financial_status === 'partially_paid');
  const totalRevenue = paid.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const avgOrderValue = paid.length > 0 ? totalRevenue / paid.length : 0;
  const productSales = {};
  for (const order of paid) {
    for (const item of order.line_items || []) {
      if (!productSales[item.title]) productSales[item.title] = { qty: 0, revenue: 0 };
      productSales[item.title].qty += item.quantity;
      productSales[item.title].revenue += parseFloat(item.price) * item.quantity;
    }
  }
  const topProducts = Object.entries(productSales)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5)
    .map(([name, data]) => ({ name, ...data }));
  return {
    period: `Last ${days} days`,
    totalOrders: orders.length,
    paidOrders: paid.length,
    totalRevenue: totalRevenue.toFixed(2),
    avgOrderValue: avgOrderValue.toFixed(2),
    pendingOrders: orders.filter(o => o.financial_status === 'pending').length,
    topProducts,
  };
}

// ─── Meta Ads Helpers ─────────────────────────────────────────────────────────
const META_BASE = 'https://graph.facebook.com/v21.0';
const META_TOKEN = (process.env.META_ACCESS_TOKEN || '').replace(/\s+/g, '');
const META_AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;

function getTimeRange(days) {
  const today = new Date();
  const since = new Date();
  since.setDate(today.getDate() - (days - 1));
  return {
    since: since.toISOString().split('T')[0],
    until: today.toISOString().split('T')[0],
  };
}

async function getMetaInsights(days = 7) {
  const timeRange = getTimeRange(days);
  const res = await axios.get(`${META_BASE}/${META_AD_ACCOUNT}/insights`, {
    params: {
      access_token: META_TOKEN,
      time_range: JSON.stringify(timeRange),
      fields: 'spend,impressions,clicks,ctr,cpc,reach,actions,action_values',
      level: 'account',
    },
  });
  return res.data.data?.[0] || {};
}

async function getMetaCampaigns(days = 7) {
  const timeRange = getTimeRange(days);
  const res = await axios.get(`${META_BASE}/${META_AD_ACCOUNT}/campaigns`, {
    params: {
      access_token: META_TOKEN,
      fields: 'name,status,objective,daily_budget,lifetime_budget',
      limit: 20,
    },
  });
  const campaigns = res.data.data || [];
  const insightsRes = await axios.get(`${META_BASE}/${META_AD_ACCOUNT}/insights`, {
    params: {
      access_token: META_TOKEN,
      time_range: JSON.stringify(timeRange),
      fields: 'campaign_name,spend,impressions,clicks,ctr,actions',
      level: 'campaign',
      limit: 20,
    },
  });
  const insights = insightsRes.data.data || [];
  return { campaigns, insights };
}

// ─── Query Classifier ─────────────────────────────────────────────────────────
function classifyQuery(message) {
  const lower = message.toLowerCase();
  const numMatch = lower.match(/(\d+)\s*(din|day|days)/);
  const days = numMatch
    ? parseInt(numMatch[1])
    : /aaj|today/.test(lower) ? 1
    : /kal\b|yesterday/.test(lower) ? 2
    : /week|hafta/.test(lower) ? 7
    : /month|mahina/.test(lower) ? 30
    : 7;
  return {
    needsShopify: /shopify|order|sale|revenue|product|customer|store|income|kamay|bikri|maal/.test(lower),
    needsMeta: /meta|facebook|ad|campaign|spend|roas|impression|click|marketing|advertis|paisa|budget/.test(lower),
    days,
  };
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(forWhatsApp = false) {
  const base = `You are the business intelligence assistant for CNC Electric — a Pakistan-based electrical components company selling circuit breakers, solar bundles, ATS systems, and EV chargers at cncelectric.pk.

IMPORTANT GUIDELINES:
- Answer in the same language the owner writes in (Roman Urdu, Urdu, or English)
- Be concise but insightful — give numbers AND what they mean
- Format numbers clearly (PKR for currency, % for rates)
- If data shows a problem, flag it clearly`;

  if (forWhatsApp) {
    return base + `
- Plain text only — NO markdown, NO ** bold **, NO # headers
- Use emojis for structure (📊 🛒 📱 💡)
- Keep under 200 words
- End with a short tip`;
  }
  return base + `
- Use bullet points and formatting for web dashboard
- Keep responses under 300 words unless detailed report requested
- End with "💡 Suggestion:" when you have actionable advice`;
}

// ─── WhatsApp: Send Message ───────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ WhatsApp sent to ${to}`);
  } catch (err) {
    console.error('❌ WhatsApp send error:', err.response?.data || err.message);
  }
}

// ─── WhatsApp: Handle Query ───────────────────────────────────────────────────
async function handleWhatsAppQuery(message, from) {
  try {
    const { needsShopify, needsMeta, days } = classifyQuery(message);
    const dataFetches = [];
    if (needsShopify) dataFetches.push(getShopifySalesStats(days).catch(e => ({ error: e.message })));
    if (needsMeta) dataFetches.push(getMetaInsights(days).catch(e => ({ error: e.message })));
    if (needsMeta) dataFetches.push(getMetaCampaigns(days).catch(e => ({ error: e.message })));
    const results = await Promise.all(dataFetches);

    let dataContext = '';
    let idx = 0;
    if (needsShopify) dataContext += `\nSHOPIFY (${days} days):\n${JSON.stringify(results[idx++], null, 2)}`;
    if (needsMeta) dataContext += `\nMETA ADS:\n${JSON.stringify(results[idx++], null, 2)}`;
    if (needsMeta) dataContext += `\nCAMPAIGNS:\n${JSON.stringify(results[idx++], null, 2)}`;

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: buildSystemPrompt(true),
      messages: [{ role: 'user', content: dataContext ? `${message}\n\n[DATA]${dataContext}` : message }],
    });
    await sendWhatsAppMessage(from, response.content[0].text);
  } catch (err) {
    console.error('WA query error:', err.message);
    await sendWhatsAppMessage(from, '❌ Kuch masla hua, dobara try karo.');
  }
}

// ─── Daily Auto Report ────────────────────────────────────────────────────────
async function sendDailyReport() {
  console.log('📊 Daily report bhej raha hun...');
  try {
    const [shopify, meta] = await Promise.all([
      getShopifySalesStats(1).catch(() => null),
      getMetaInsights(1).catch(() => null),
    ]);
    const today = new Date().toLocaleDateString('en-PK', {
      timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric'
    });
    let report = `📊 CNC Electric Daily Report\n${today}\n\n`;
    if (shopify && !shopify.error) {
      report += `🛒 SHOPIFY\nOrders: ${shopify.totalOrders} (Paid: ${shopify.paidOrders})\nRevenue: PKR ${Number(shopify.totalRevenue).toLocaleString()}\nAvg Order: PKR ${Number(shopify.avgOrderValue).toLocaleString()}\n\n`;
    }
    if (meta && !meta.error) {
      report += `📱 META ADS\nSpend: PKR ${Number(meta.spend || 0).toLocaleString()}\nClicks: ${Number(meta.clicks || 0).toLocaleString()}\nCTR: ${Number(meta.ctr || 0).toFixed(2)}%\nReach: ${Number(meta.reach || 0).toLocaleString()}\n\n`;
    }
    report += `💡 Kisi bhi cheez ki detail ke liye message karo!`;
    for (const num of OWNER_PHONES) { await sendWhatsAppMessage(num, report); }
    console.log('✅ Daily report sent!');
  } catch (err) {
    console.error('Daily report error:', err.message);
  }
}

// ─── Cron: 9am Pakistan time daily ───────────────────────────────────────────
let lastReportDate = null;
setInterval(() => {
  const pkTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }));
  const hour = pkTime.getHours();
  const dateStr = pkTime.toDateString();
  if (hour === 9 && lastReportDate !== dateStr) {
    lastReportDate = dateStr;
    sendDailyReport();
  }
}, 60 * 1000);

// ─── WhatsApp Webhook: GET (Meta Verification) ────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log('Webhook verify:', { mode, token });
  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Verify failed');
    res.status(403).send('Forbidden');
  }
});

// ─── WhatsApp Webhook: POST (Incoming Messages) ───────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // Meta ko turant 200 chahiye
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;
    const msg = messages[0];
    const from = msg.from;
    const text = msg.text?.body;
    if (!text) return;
    console.log(`📩 From ${from}: ${text}`);
    if (!OWNER_PHONES.includes(from)) {
      await sendWhatsAppMessage(from, 'Yeh assistant sirf CNC Electric owner ke liye hai.');
      return;
    }
    await handleWhatsAppQuery(text, from);
  } catch (err) {
    console.error('Webhook POST error:', err.message);
  }
});

// ─── Web Dashboard Chat ───────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
  try {
    const { needsShopify, needsMeta, days } = classifyQuery(message);
    const dataFetches = [];
    if (needsShopify) dataFetches.push(getShopifySalesStats(days).catch(e => ({ error: e.message })));
    if (needsMeta) dataFetches.push(getMetaInsights(days).catch(e => ({ error: e.message })));
    if (needsMeta) dataFetches.push(getMetaCampaigns(days).catch(e => ({ error: e.message })));
    const results = await Promise.all(dataFetches);
    let dataContext = '';
    let idx = 0;
    if (needsShopify) dataContext += `\n\n=== SHOPIFY DATA (${days} days) ===\n${JSON.stringify(results[idx++], null, 2)}`;
    if (needsMeta) dataContext += `\n\n=== META ADS OVERVIEW ===\n${JSON.stringify(results[idx++], null, 2)}`;
    if (needsMeta) dataContext += `\n\n=== META CAMPAIGNS ===\n${JSON.stringify(results[idx++], null, 2)}`;
    const messages = [
      ...history.slice(-10),
      { role: 'user', content: dataContext ? `${message}\n\n[LIVE DATA FETCHED]${dataContext}` : message },
    ];
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: buildSystemPrompt(false),
      messages,
    });
    res.json({ reply: response.content[0].text, dataFetched: { shopify: needsShopify, meta: needsMeta } });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

// ─── Stats + Utility Endpoints ────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [shopify, meta] = await Promise.all([
      getShopifySalesStats(7).catch(() => null),
      getMetaInsights(7).catch(() => null),
    ]);
    res.json({ shopify, meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual report trigger — test ke liye
app.get('/send-report', async (req, res) => {
  await sendDailyReport();
  res.json({ status: 'Report bhej di!' });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CNC Electric Assistant running on port ${PORT}`));
