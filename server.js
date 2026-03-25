const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const {
  getAmazonListings,
  getAmazonListingDetail
} = require('./amazon');

const {
  buildShopifyInstallUrl,
  verifyShopifyCallbackHmac,
  exchangeCodeForToken,
  createShopifyProduct
} = require('./shopify');

const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me-now',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function getBaseUrl(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
}

function getShopifyStoreDomain() {
  return requireEnv('SHOPIFY_STORE_DOMAIN');
}

let shopifyAccessToken = null;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'amazon-importer-shopify',
    hasShopifyToken: !!shopifyAccessToken,
    shop: process.env.SHOPIFY_STORE_DOMAIN || null
  });
});

app.get('/shopify/install', (req, res) => {
  try {
    const shop = getShopifyStoreDomain();
    const state = crypto.randomBytes(16).toString('hex');
    req.session.shopifyState = state;

    const redirectUri = `${getBaseUrl(req)}/shopify/callback`;
    const url = buildShopifyInstallUrl({
      shop,
      state,
      redirectUri
    });

    return res.redirect(url);
  } catch (error) {
    console.error('Shopify install error:', error.message);
    return res.status(500).send(`Errore Shopify install: ${error.message}`);
  }
});

app.get('/shopify/callback', async (req, res) => {
  try {
    const { code, hmac, state, shop, host } = req.query;

    if (!code || !hmac || !state || !shop) {
      return res.status(400).send('Parametri callback Shopify mancanti.');
    }

    if (!req.session.shopifyState || req.session.shopifyState !== state) {
      return res.status(400).send('State Shopify non valido.');
    }

    const valid = verifyShopifyCallbackHmac(req.query, process.env.SHOPIFY_CLIENT_SECRET);
    if (!valid) {
      return res.status(400).send('HMAC Shopify non valido.');
    }

    const redirectUri = `${getBaseUrl(req)}/shopify/callback`;

    const tokenResponse = await exchangeCodeForToken({
      shop,
      code,
      redirectUri
    });

    shopifyAccessToken = tokenResponse.access_token;

    req.session.shopifyInstalled = true;

    const adminUrl = host
      ? `https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/apps`
      : null;

    return res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Shopify collegato</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 30px; line-height: 1.5; }
            a, button { font-size: 16px; }
          </style>
        </head>
        <body>
          <h2>Collegamento Shopify completato</h2>
          <p>Token ottenuto correttamente.</p>
          <p><a href="/">Vai all'importer</a></p>
          ${adminUrl ? `<p><a href="${adminUrl}" target="_blank" rel="noreferrer">Apri Shopify Admin</a></p>` : ''}
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Shopify callback error:', error.response?.data || error.message);
    return res.status(500).send(
      `Errore callback Shopify: ${JSON.stringify(error.response?.data || error.message)}`
    );
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    shopifyConnected: !!shopifyAccessToken
  });
});

app.get('/api/amazon/listings', async (req, res) => {
  try {
    const pageSize = Number(req.query.pageSize || 20);
    const listings = await getAmazonListings({ pageSize });
    res.json({ ok: true, listings });
  } catch (error) {
    console.error('Amazon listings error:', error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

app.get('/api/amazon/listing/:sku', async (req, res) => {
  try {
    const sku = req.params.sku;
    const detail = await getAmazonListingDetail(sku);
    res.json({ ok: true, detail });
  } catch (error) {
    console.error('Amazon detail error:', error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

app.post('/api/shopify/import/:sku', async (req, res) => {
  try {
    if (!shopifyAccessToken) {
      return res.status(401).json({
        ok: false,
        error: 'Shopify non collegato. Vai su /shopify/install prima.'
      });
    }

    const sku = req.params.sku;
    const detail = await getAmazonListingDetail(sku);

    const product = await createShopifyProduct({
      accessToken: shopifyAccessToken,
      detail
    });

    res.json({
      ok: true,
      product
    });
  } catch (error) {
    console.error('Shopify import error:', error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log(`Server avviato sulla porta ${process.env.PORT || 10000}`);
});
