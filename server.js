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
  createOrRejectShopifyProduct,
  getExistingKeysMap
} = require('./shopify');

const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me-now',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.jpg'));
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.jpg'));
});

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

function safeTime(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function sortListingsByRecentDesc(items) {
  return [...items].sort((a, b) => safeTime(b.createdAt) - safeTime(a.createdAt));
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
          <link rel="icon" type="image/jpeg" href="/favicon.jpg" />
          <style>
            body {
              font-family: Inter, Arial, sans-serif;
              background: #f5f7fb;
              padding: 40px;
              color: #111827;
            }
            .card {
              max-width: 720px;
              margin: 0 auto;
              background: #ffffff;
              border-radius: 18px;
              padding: 32px;
              box-shadow: 0 12px 40px rgba(15, 23, 42, 0.08);
              border: 1px solid #e5e7eb;
            }
            h2 {
              margin-top: 0;
              margin-bottom: 10px;
            }
            p {
              color: #4b5563;
              line-height: 1.6;
            }
            a.button {
              display: inline-block;
              margin-right: 12px;
              margin-top: 10px;
              padding: 12px 18px;
              border-radius: 12px;
              text-decoration: none;
              font-weight: 600;
              background: #111827;
              color: #fff;
            }
            a.secondary {
              background: #eef2ff;
              color: #3730a3;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Collegamento Shopify completato</h2>
            <p>Token ottenuto correttamente. L’app importer è pronta a creare prodotti in bozza su Shopify.</p>
            <a class="button" href="/">Vai all'importer</a>
            ${adminUrl ? `<a class="button secondary" href="${adminUrl}" target="_blank" rel="noreferrer">Apri Shopify Admin</a>` : ''}
          </div>
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
    if (!shopifyAccessToken) {
      return res.status(401).json({
        ok: false,
        error: 'Shopify non collegato. Premi "Collega Shopify" prima.'
      });
    }

    const pageSize = Number(req.query.pageSize || 20);
    let pageToken = req.query.pageToken || null;

    let finalItems = [];
    let finalNextToken = null;
    let scannedPages = 0;

    while (scannedPages < 10 && finalItems.length < pageSize) {
      const result = await getAmazonListings({ pageSize, pageToken });
      const amazonItems = result.items || [];
      finalNextToken = result.nextToken || null;

      if (!amazonItems.length) {
        break;
      }

      const existingMap = await getExistingKeysMap(shopifyAccessToken, amazonItems);

      const filtered = amazonItems.filter((item) => {
        const skuKey = item.sku ? `sku:${item.sku}` : null;
        const barcodeKey = item.barcode ? `barcode:${item.barcode}` : null;

        if (skuKey && existingMap[skuKey]) return false;
        if (barcodeKey && existingMap[barcodeKey]) return false;

        return true;
      });

      finalItems.push(...filtered);

      if (!finalNextToken) break;
      pageToken = finalNextToken;
      scannedPages += 1;
    }

    finalItems = sortListingsByRecentDesc(finalItems).slice(0, pageSize);

    res.json({
      ok: true,
      listings: finalItems,
      nextToken: finalNextToken
    });
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
        error: 'Shopify non collegato. Premi "Collega Shopify" prima.'
      });
    }

    const sku = req.params.sku;
    const detail = await getAmazonListingDetail(sku);

    const result = await createOrRejectShopifyProduct({
      accessToken: shopifyAccessToken,
      detail
    });

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    console.error('Shopify import error:', error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

app.post('/api/shopify/import-bulk', async (req, res) => {
  try {
    if (!shopifyAccessToken) {
      return res.status(401).json({
        ok: false,
        error: 'Shopify non collegato. Premi "Collega Shopify" prima.'
      });
    }

    const skus = Array.isArray(req.body.skus) ? req.body.skus : [];
    const cleanedSkus = [...new Set(skus.map(x => String(x || '').trim()).filter(Boolean))];

    if (!cleanedSkus.length) {
      return res.status(400).json({
        ok: false,
        error: 'Nessuno SKU ricevuto per l’importazione massiva.'
      });
    }

    const results = [];

    for (const sku of cleanedSkus) {
      try {
        const detail = await getAmazonListingDetail(sku);

        const result = await createOrRejectShopifyProduct({
          accessToken: shopifyAccessToken,
          detail
        });

        results.push({
          sku,
          created: !!result.created,
          duplicate: !!result.duplicate,
          result
        });
      } catch (error) {
        console.error(`Bulk import error for SKU ${sku}:`, error.response?.data || error.message);
        results.push({
          sku,
          created: false,
          duplicate: false,
          error: typeof error.response?.data === 'string'
            ? error.response.data
            : (error.message || 'Errore sconosciuto')
        });
      }
    }

    res.json({
      ok: true,
      results
    });
  } catch (error) {
    console.error('Shopify bulk import error:', error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log(`Server avviato sulla porta ${process.env.PORT || 10000}`);
});
