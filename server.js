const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const {
  getAmazonListings,
  getAmazonListingDetail,
  lookupAmazonIdentifier
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

function listingMatchesSearch(item, term) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return true;

  const haystack = [
    item?.title || '',
    item?.sku || '',
    item?.asin || ''
  ].join(' ').toLowerCase();

  return haystack.includes(needle);
}

/**
 * =========================================================
 * PERSISTENZA TOKEN SHOPIFY SU FILE
 * =========================================================
 */

const DATA_DIR = path.join(__dirname, 'data');
const SHOPIFY_TOKEN_FILE = path.join(DATA_DIR, 'shopify-token.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveShopifyTokenToFile({ accessToken, shop }) {
  try {
    ensureDataDir();

    const payload = {
      accessToken,
      shop,
      savedAt: new Date().toISOString()
    };

    fs.writeFileSync(SHOPIFY_TOKEN_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('Token Shopify salvato su file.');
  } catch (error) {
    console.error('Errore salvataggio token Shopify su file:', error.message);
  }
}

function loadShopifyTokenFromFile() {
  try {
    if (!fs.existsSync(SHOPIFY_TOKEN_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(SHOPIFY_TOKEN_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || !parsed.accessToken) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.error('Errore lettura token Shopify da file:', error.message);
    return null;
  }
}

function clearShopifyTokenFile() {
  try {
    if (fs.existsSync(SHOPIFY_TOKEN_FILE)) {
      fs.unlinkSync(SHOPIFY_TOKEN_FILE);
    }
  } catch (error) {
    console.error('Errore cancellazione token Shopify da file:', error.message);
  }
}

/**
 * =========================================================
 * HELPER LISTINGS AMAZON
 * =========================================================
 */

// Cursor keeps the offset within an Amazon page, so no fetched listing is discarded.
function decodeListingCursor(cursor) {
  if (!cursor) return { pageToken: null, offset: 0 };
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (obj.v !== 1 || !Number.isInteger(obj.offset) || obj.offset < 0 || obj.offset > 20 ||
        (obj.pageToken !== null && typeof obj.pageToken !== 'string')) throw Error('invalid');
    return { pageToken: obj.pageToken, offset: obj.offset };
  } catch { throw new Error('Cursore paginazione non valido. Premi Carica inserzioni Amazon per ripartire.'); }
}
function encodeListingCursor(pageToken, offset) {
  return Buffer.from(JSON.stringify({v:1,pageToken,offset})).toString('base64url');
}
async function getImportableAmazonListingsPage({ accessToken, pageSize, cursor }) {
  let {pageToken,offset} = decodeListingCursor(cursor);
  const items = [];
  const seen = new Set();
  let scannedPages = 0;
  const maxPages = 12;
  while (scannedPages < maxPages && items.length < pageSize) {
    const currentToken = pageToken;
    const result = await getAmazonListings({pageSize:20,pageToken:currentToken});
    const amazonItems = result.items || [];
    scannedPages++;
    if (!amazonItems.length) {
      if (!result.nextToken) return {listings:items,nextToken:null,scannedPages};
      pageToken = result.nextToken; offset = 0; continue;
    }
    const remaining = amazonItems.slice(offset);
    const existingMap = remaining.length ? await getExistingKeysMap(accessToken,remaining) : {};
    for (let i=offset;i<amazonItems.length;i++) {
      const item=amazonItems[i];
      const sku=String(item.sku||'');
      const duplicate=!!(sku && existingMap[`sku:${sku}`]) ||
        !!(item.barcode && existingMap[`barcode:${item.barcode}`]);
      if (!duplicate && sku && !seen.has(sku)) {seen.add(sku);items.push(item);}
      if (items.length >= pageSize) {
        const nextOffset=i+1;
        const nextToken=nextOffset < amazonItems.length
          ? encodeListingCursor(currentToken,nextOffset)
          : (result.nextToken ? encodeListingCursor(result.nextToken,0) : null);
        return {listings:sortListingsByRecentDesc(items),nextToken,scannedPages};
      }
    }
    if (!result.nextToken) return {listings:sortListingsByRecentDesc(items),nextToken:null,scannedPages};
    pageToken=result.nextToken; offset=0;
  }
  return {listings:sortListingsByRecentDesc(items),nextToken:encodeListingCursor(pageToken,offset),scannedPages};
}

let shopifyAccessToken = null;
let shopifyConnectedShop = process.env.SHOPIFY_STORE_DOMAIN || null;

const persistedShopify = loadShopifyTokenFromFile();
if (persistedShopify?.accessToken) {
  shopifyAccessToken = persistedShopify.accessToken;
  shopifyConnectedShop = persistedShopify.shop || shopifyConnectedShop;
  console.log(`Token Shopify ricaricato automaticamente da file per shop ${shopifyConnectedShop}`);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'amazon-importer-shopify',
    hasShopifyToken: !!shopifyAccessToken,
    shop: shopifyConnectedShop || null,
    tokenPersistedOnDisk: fs.existsSync(SHOPIFY_TOKEN_FILE)
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
    shopifyConnectedShop = shop;
    req.session.shopifyInstalled = true;

    saveShopifyTokenToFile({
      accessToken: shopifyAccessToken,
      shop
    });

    const adminUrl = host
      ? `https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/apps`
      : null;

    return res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Shopify collegato</title>
          <link rel="icon" type="image/jpeg" href="/favicon.jpg?v=2" />
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
            <p>Token ottenuto correttamente e salvato su file. L’app proverà a riutilizzarlo automaticamente ai riavvii.</p>
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
    shopifyConnected: !!shopifyAccessToken,
    shop: shopifyConnectedShop || null,
    tokenPersistedOnDisk: fs.existsSync(SHOPIFY_TOKEN_FILE)
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

    const pageSize = Math.min(Math.max(Number(req.query.pageSize || 20), 1), 20);
    const cursor = req.query.pageToken || null;

    const result = await getImportableAmazonListingsPage({
      accessToken: shopifyAccessToken,
      pageSize,
      cursor
    });

    res.json({
      ok: true,
      listings: result.listings,
      nextToken: result.nextToken
    });
  } catch (error) {
    console.error('Amazon listings error:', error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

app.get('/api/amazon/search', async (req, res) => {
  try {
    if (!shopifyAccessToken) {
      return res.status(401).json({
        ok: false,
        error: 'Shopify non collegato. Premi "Collega Shopify" prima.'
      });
    }

    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 40);
    const resumePageToken = req.query.resumePageToken || null;
    const excludeSkus = String(req.query.excludeSkus || '')
      .split(',')
      .map(x => String(x || '').trim())
      .filter(Boolean);

    if (!q) {
      return res.json({
        ok: true,
        listings: [],
        totalMatches: 0,
        scannedPages: 0,
        exhausted: true,
        timedOut: false,
        elapsedMs: 0,
        nextResumePageToken: null
      });
    }

    const startedAt = Date.now();
    const maxSearchMs = 18000;

    let pageToken = resumePageToken;
    let scannedPages = 0;
    let exhausted = false;
    let timedOut = false;
    const matches = [];
    const seenSkus = new Set(excludeSkus);

    while (scannedPages < 12 && matches.length < limit) {
      if (Date.now() - startedAt > maxSearchMs) {
        timedOut = true;
        break;
      }

      const result = await getAmazonListings({ pageSize: 20, pageToken });
      const amazonItems = result.items || [];
      pageToken = result.nextToken || null;

      if (!amazonItems.length) {
        exhausted = true;
        break;
      }

      const candidates = amazonItems.filter((item) => listingMatchesSearch(item, q));

      if (candidates.length) {
        const existingMap = await getExistingKeysMap(shopifyAccessToken, candidates);

        for (const item of candidates) {
          if (!item.sku) continue;
          if (seenSkus.has(item.sku)) continue;

          const skuKey = item.sku ? `sku:${item.sku}` : null;
          const barcodeKey = item.barcode ? `barcode:${item.barcode}` : null;

          if (skuKey && existingMap[skuKey]) continue;
          if (barcodeKey && existingMap[barcodeKey]) continue;

          seenSkus.add(item.sku);
          matches.push(item);

          if (matches.length >= limit) {
            break;
          }
        }
      }

      scannedPages += 1;

      if (!pageToken) {
        exhausted = true;
        break;
      }
    }

    const elapsedMs = Date.now() - startedAt;

    res.json({
      ok: true,
      listings: sortListingsByRecentDesc(matches).slice(0, limit),
      totalMatches: matches.length,
      scannedPages,
      exhausted,
      timedOut,
      elapsedMs,
      nextResumePageToken: pageToken || null
    });
  } catch (error) {
    console.error('Amazon search error:', error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

app.get('/api/amazon/lookup', async (req, res) => {
  try {
    if (!shopifyAccessToken) return res.status(401).json({ok:false,error:'Shopify non collegato'});
    const identifier = String(req.query.identifier || '').trim();
    if (!identifier || identifier.length > 100) return res.status(400).json({ok:false,error:'SKU/ASIN non valido'});
    const listings = await lookupAmazonIdentifier(identifier);
    if (!listings.length) return res.json({ok:true,listings:[],reason:'not_found'});
    const existing = await getExistingKeysMap(shopifyAccessToken,listings);
    const diagnostics = listings.map(item => {
      const skuDuplicate = !!existing[`sku:${item.sku}`];
      const barcodeDuplicate = !!(item.barcode && existing[`barcode:${item.barcode}`]);
      return {item,reason:skuDuplicate?'sku_duplicate':barcodeDuplicate?'barcode_duplicate':'importable'};
    });
    res.json({ok:true,listings:diagnostics.filter(x=>x.reason==='importable').map(x=>x.item),diagnostics});
  } catch(error) {
    console.error('Amazon lookup error:',error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ok:false,error:error.response?.data || error.message});
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

app.post('/api/shopify/disconnect', (req, res) => {
  shopifyAccessToken = null;
  shopifyConnectedShop = null;
  clearShopifyTokenFile();

  res.json({
    ok: true,
    message: 'Collegamento Shopify rimosso.'
  });
});

app.listen(process.env.PORT || 10000, () => {
  console.log(`Server avviato sulla porta ${process.env.PORT || 10000}`);
});
