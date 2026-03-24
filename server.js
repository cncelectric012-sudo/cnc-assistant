require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// Shopify OAuth config
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '3982062fe4ecec6bd5b2f55820e4135';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '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';
const SHOPIFY_SHOP = process.env.SHOPIFY_STORE_DOMAIN || 'cncelectric.myshopify.com';
const SCOPES = 'read_orders,read_products,read_customers,read_analytics';

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Clients ──────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Shopify OAuth Routes ─────────────────────────────────────────────────────
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
    res.send(`
      <html><body style="background:#0a0c0f;color:#00d4ff;font-family:monospace;padding:40px;">
        <h2>✅ Shopify Token Mila!</h2>
        <p>Yeh token Railway Variables mein lagao:</p>
        <p><strong>SHOPIFY_ADMIN_API_KEY =</strong></p>
        <code style="background:#111;padding:15px;display:block;border:1px solid #00d4ff;margin:10px 0;word-break:break-all;">${token}</code>
        <p style="color:#64748b;">Token copy karo → Railway Variables mein paste karo → Redeploy!</p>
      </body></html>
    `);
  } catch (err) {
    res.send(`<p style="color:red;">Error: ${err.message}</p>`);
  }
});

// ─── Shopify Helpers ───────────────────────────────────────────────────────────
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

async function getShopifyProducts() {
  const res = await axios.get(`${SHOPIFY_BASE}/products.json`, {
    headers: shopifyHeaders,
    params: { limit: 250, fields: 'id,title,status,variants,product_type' },
  });
  return res.data.products;
}

async function getShopifySalesStats(days = 7) {
  const orders = await getShopifyOrders(days);
  const paid = orders.filter(o => o.financial_status === 'paid' || o.financial_status === 'partially_paid');
  const totalRevenue = paid.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const avgOrderValue = paid.length > 0 ? totalRevenue / paid.length : 0;

  // Top products
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
const META_BASE = 'https://graph.facebook.com/v19.0';
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID; // format: act_XXXXXXXXXX

async function getMetaInsights(days = 7) {
  const res = await axios.get(`${META_BASE}/${META_AD_ACCOUNT}/insights`, {
    params: {
      access_token: META_TOKEN,
      date_preset: days <= 7 ? 'last_7d' : days <= 30 ? 'last_30d' : 'last_90d',
      fields: 'spend,impressions,clicks,ctr,cpc,reach,actions,action_values,roas',
      level: 'account',
    },
  });
  return res.data.data?.[0] || {};
}

async function getMetaCampaigns(days = 7) {
  const res = await axios.get(`${META_BASE}/${META_AD_ACCOUNT}/campaigns`, {
    params: {
      access_token: META_TOKEN,
      fields: 'name,status,objective,daily_budget,lifetime_budget',
      limit: 20,
    },
  });
  const campaigns = res.data.data || [];

  // Get insights per campaign
  const insightsRes = await axios.get(`${META_BASE}/${META_AD_ACCOUNT}/insights`, {
    params: {
      access_token: META_TOKEN,
      date_preset: days <= 7 ? 'last_7d' : 'last_30d',
      fields: 'campaign_name,spend,impressions,clicks,ctr,actions,roas',
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
  return {
    needsShopify:
      /shopify|order|sale|revenue|product|customer|store|income|kamay|bikri|order|maal/.test(lower),
    needsMeta:
      /meta|facebook|ad|campaign|spend|roas|impression|click|marketing|advertis|paisa|budget/.test(
        lower
      ),
    days: /aaj|today|kal|yesterday/.test(lower)
      ? 1
      : /week|hafta|7/.test(lower)
      ? 7
      : /month|mahina|30/.test(lower)
      ? 30
      : 7,
  };
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are the business intelligence assistant for CNC Electric — a Pakistan-based electrical components company selling circuit breakers, solar bundles, ATS systems, and EV chargers at cncelectric.pk.

You help the business owner get instant insights from their Shopify store and Meta Ads account.

IMPORTANT GUIDELINES:
- Answer in the same language the owner writes in (Roman Urdu, Urdu, or English)
- Be concise but insightful — give numbers AND what they mean
- Always suggest 1-2 actionable improvements based on data
- Format numbers clearly (PKR for currency, % for rates)
- If data shows a problem, flag it clearly
- If asked about something not in the data, say so honestly

RESPONSE FORMAT:
- Use simple bullet points or short paragraphs
- Bold important numbers
- End with "💡 Suggestion:" when you have actionable advice
- Keep responses under 300 words unless a detailed report is explicitly requested`;
}

// ─── Main Chat Endpoint ────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    const { needsShopify, needsMeta, days } = classifyQuery(message);

    // Fetch relevant data in parallel
    const dataFetches = [];
    if (needsShopify) dataFetches.push(getShopifySalesStats(days).catch(e => ({ error: e.message })));
    if (needsMeta) dataFetches.push(getMetaInsights(days).catch(e => ({ error: e.message })));
    if (needsMeta) dataFetches.push(getMetaCampaigns(days).catch(e => ({ error: e.message })));

    const results = await Promise.all(dataFetches);

    let dataContext = '';
    let idx = 0;
    if (needsShopify) {
      dataContext += `\n\n=== SHOPIFY DATA (${days} days) ===\n${JSON.stringify(results[idx++], null, 2)}`;
    }
    if (needsMeta) {
      dataContext += `\n\n=== META ADS OVERVIEW ===\n${JSON.stringify(results[idx++], null, 2)}`;
      dataContext += `\n\n=== META CAMPAIGNS ===\n${JSON.stringify(results[idx++], null, 2)}`;
    }

    // Build conversation history for Claude
    const messages = [
      ...history.slice(-10), // last 10 messages for context
      {
        role: 'user',
        content: dataContext
          ? `${message}\n\n[LIVE DATA FETCHED]${dataContext}`
          : message,
      },
    ];

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages,
    });

    const reply = response.content[0].text;
    res.json({ reply, dataFetched: { shopify: needsShopify, meta: needsMeta } });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

// ─── Quick Stats Endpoint (for dashboard) ─────────────────────────────────────
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

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CNC Electric Assistant running on port ${PORT}`));
