const axios = require('axios');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

async function getLwaAccessToken() {
  const clientId = requireEnv('AMAZON_LWA_CLIENT_ID');
  const clientSecret = requireEnv('AMAZON_LWA_CLIENT_SECRET');
  const refreshToken = requireEnv('AMAZON_REFRESH_TOKEN');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await axios.post(
    'https://api.amazon.com/auth/o2/token',
    body.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  return response.data.access_token;
}

function getSpApiClient(accessToken) {
  const endpoint = requireEnv('AMAZON_SP_API_ENDPOINT');

  return axios.create({
    baseURL: endpoint,
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 30000
  });
}

function pickListingSummary(item) {
  const summary = Array.isArray(item.summaries) ? item.summaries[0] : null;
  const attrs = item.attributes || {};
  const offers = item.offers || [];
  const firstOffer = Array.isArray(offers) ? offers[0] : null;

  const imageUrl =
    summary?.mainImage?.link ||
    summary?.main_image?.link ||
    null;

  const title =
    summary?.itemName ||
    summary?.item_name ||
    item.sku ||
    '';

  const asin =
    summary?.asin ||
    item.asin ||
    null;

  let price = null;

  if (firstOffer?.price?.amount) {
    price = String(firstOffer.price.amount);
  } else if (attrs?.list_price?.[0]?.value?.amount) {
    price = String(attrs.list_price[0].value.amount);
  } else if (attrs?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax) {
    price = String(attrs.purchasable_offer[0].our_price[0].schedule[0].value_with_tax);
  }

  const barcode = findBarcode(attrs);
  const createdAt = findAmazonDate(item, summary, attrs);

  return {
    sku: item.sku,
    asin,
    title,
    imageUrl,
    status: item.status || [],
    price,
    barcode,
    createdAt
  };
}

async function getAmazonListings({ pageSize = 20, pageToken = null } = {}) {
  const sellerId = requireEnv('AMAZON_SELLER_ID');
  const marketplaceId = requireEnv('AMAZON_MARKETPLACE_ID');

  const token = await getLwaAccessToken();
  const client = getSpApiClient(token);

  const params = {
    marketplaceIds: marketplaceId,
    pageSize,
    includedData: 'summaries,attributes,offers'
  };

  if (pageToken) {
    params.pageToken = pageToken;
  }

  const response = await client.get(`/listings/2021-08-01/items/${sellerId}`, {
    params
  });

  const items = response.data.items || [];

  return {
    items: items.map(pickListingSummary),
    nextToken: response.data.pagination?.nextToken || null
  };
}

async function getAmazonListingDetail(sku) {
  const sellerId = requireEnv('AMAZON_SELLER_ID');
  const marketplaceId = requireEnv('AMAZON_MARKETPLACE_ID');

  const token = await getLwaAccessToken();
  const client = getSpApiClient(token);

  const response = await client.get(
    `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`,
    {
      params: {
        marketplaceIds: marketplaceId,
        includedData: 'summaries,attributes,offers,fulfillmentAvailability,issues'
      }
    }
  );

  const item = response.data;
  const summary = Array.isArray(item.summaries) ? item.summaries[0] : {};
  const attributes = item.attributes || {};

  const title =
    summary.itemName ||
    summary.item_name ||
    sku;

  const asin =
    summary.asin ||
    item.asin ||
    null;

  const brand = firstNonEmpty([
    summary.brand,
    getAttributeValue(attributes, 'brand'),
    getAttributeValue(attributes, 'manufacturer')
  ]);

  const descriptionHtml = buildDescriptionHtml(attributes, sku);

  const imageCandidates = [];

  if (summary.mainImage?.link) {
    imageCandidates.push(summary.mainImage.link);
  }

  if (Array.isArray(summary.otherProductImageUrls)) {
    imageCandidates.push(...summary.otherProductImageUrls);
  }

  const uniqueImages = [...new Set(imageCandidates.filter(Boolean))];

  let price = null;
  const offers = item.offers || [];
  const firstOffer = Array.isArray(offers) ? offers[0] : null;

  if (firstOffer?.price?.amount) {
    price = String(firstOffer.price.amount);
  } else if (attributes?.list_price?.[0]?.value?.amount) {
    price = String(attributes.list_price[0].value.amount);
  } else if (attributes?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax) {
    price = String(attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax);
  } else {
    price = '0.00';
  }

  const barcode = findBarcode(attributes);
  const quantity = getAmazonQuantity(item);
  const weight = findWeight(attributes);

  return {
    sku,
    asin,
    title,
    brand: brand || '',
    descriptionHtml,
    imageUrls: uniqueImages,
    price,
    barcode,
    quantity,
    weight,
    raw: item
  };
}

function buildDescriptionHtml(attributes, sku) {
  const introParts = [];

  const productDescription = collectAttributeStrings(attributes, [
    'product_description',
    'description',
    'item_description'
  ]);

  for (const text of productDescription) {
    if (text && text.length > 10) {
      introParts.push(`<p>${escapeHtml(text)}</p>`);
    }
  }

  const bullets = dedupeStrings([
    ...collectAttributeStrings(attributes, ['bullet_point']),
    ...collectAttributeStrings(attributes, [
      'special_feature',
      'included_components',
      'material',
      'color',
      'style',
      'model_name'
    ])
  ]).filter(Boolean);

  const bulletHtml = bullets.length
    ? `<ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';

  const html = `${introParts.join('')}${bulletHtml}`.trim();

  if (html) return html;

  return `<p>Prodotto importato da Amazon SKU ${escapeHtml(sku)}</p>`;
}

function getAmazonQuantity(item) {
  if (!Array.isArray(item.fulfillmentAvailability)) return 0;

  for (const entry of item.fulfillmentAvailability) {
    if (typeof entry.quantity === 'number') return entry.quantity;
    if (typeof entry.fulfillment_channel_quantity === 'number') return entry.fulfillment_channel_quantity;
  }

  return 0;
}

function findBarcode(attributes) {
  const directCandidates = [
    'externally_assigned_product_identifier',
    'item_package_gtin',
    'gtin',
    'ean',
    'ean_code',
    'upc',
    'isbn'
  ];

  for (const key of directCandidates) {
    const value = getAttributeValue(attributes, key);
    if (looksLikeBarcode(value)) {
      return onlyDigits(value);
    }
  }

  return null;
}

function findWeight(attributes) {
  const preferredPaths = [
    'item_package_weight',
    'package_weight',
    'item_weight'
  ];

  for (const key of preferredPaths) {
    const entry = getAttributeEntry(attributes, key);
    const normalized = normalizeWeightEntry(entry);
    if (normalized) return normalized;
  }

  return null;
}

function findAmazonDate(item, summary, attributes) {
  const candidates = [
    item?.createdDate,
    item?.creationDate,
    item?.created_at,
    item?.lastUpdatedDate,
    item?.updatedAt,
    summary?.createdDate,
    summary?.creationDate,
    summary?.created_at,
    summary?.lastUpdatedDate,
    summary?.updatedAt,
    getAttributeValue(attributes, 'creation_date'),
    getAttributeValue(attributes, 'created_date'),
    getAttributeValue(attributes, 'publication_date'),
    getAttributeValue(attributes, 'release_date')
  ];

  for (const value of candidates) {
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function normalizeWeightEntry(entry) {
  if (!entry) return null;

  if (Array.isArray(entry)) {
    for (const sub of entry) {
      const found = normalizeWeightEntry(sub);
      if (found) return found;
    }
    return null;
  }

  if (typeof entry === 'object') {
    const value = entry.value ?? entry.amount ?? null;
    const unit = entry.unit ?? entry.unit_of_measure ?? entry.unitOfMeasure ?? null;

    if (typeof value === 'number' || typeof value === 'string') {
      const parsed = Number(String(value).replace(',', '.'));
      if (!Number.isNaN(parsed) && parsed > 0) {
        return {
          value: parsed,
          unit: normalizeWeightUnit(unit)
        };
      }
    }

    for (const nested of Object.values(entry)) {
      const found = normalizeWeightEntry(nested);
      if (found) return found;
    }
  }

  return null;
}

function normalizeWeightUnit(unit) {
  const raw = String(unit || 'kg').trim().toUpperCase();

  if (raw.includes('GRAM')) return 'GRAMS';
  if (raw === 'G') return 'GRAMS';
  if (raw.includes('KILOGRAM')) return 'KILOGRAMS';
  if (raw === 'KG') return 'KILOGRAMS';
  if (raw.includes('OUNCE') || raw === 'OZ') return 'OUNCES';
  if (raw.includes('POUND') || raw === 'LB' || raw === 'LBS') return 'POUNDS';

  return 'KILOGRAMS';
}

function getAttributeEntry(attributes, key) {
  return attributes?.[key] ?? null;
}

function getAttributeValue(attributes, key) {
  const entry = getAttributeEntry(attributes, key);
  if (!entry) return null;

  if (Array.isArray(entry)) {
    for (const item of entry) {
      const found = extractAnyString(item);
      if (found) return found;
    }
    return null;
  }

  return extractAnyString(entry);
}

function collectAttributeStrings(attributes, keys) {
  const out = [];

  for (const key of keys) {
    const entry = getAttributeEntry(attributes, key);
    if (!entry) continue;

    if (Array.isArray(entry)) {
      for (const item of entry) {
        const found = extractAnyString(item);
        if (found) out.push(found);
      }
    } else {
      const found = extractAnyString(entry);
      if (found) out.push(found);
    }
  }

  return dedupeStrings(out);
}

function extractAnyString(value) {
  if (value == null) return null;

  if (typeof value === 'string') {
    const v = value.trim();
    return v || null;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractAnyString(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const preferredKeys = ['value', 'display_value', 'name', 'text'];
    for (const key of preferredKeys) {
      if (key in value) {
        const found = extractAnyString(value[key]);
        if (found) return found;
      }
    }

    for (const nested of Object.values(value)) {
      const found = extractAnyString(nested);
      if (found) return found;
    }
  }

  return null;
}

function looksLikeBarcode(value) {
  const digits = onlyDigits(value);
  return digits.length >= 8 && digits.length <= 14;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function dedupeStrings(values) {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

module.exports = {
  getAmazonListings,
  getAmazonListingDetail
};
