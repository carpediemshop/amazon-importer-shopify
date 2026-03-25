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

  return {
    sku: item.sku,
    asin,
    title,
    imageUrl,
    status: item.status || [],
    price
  };
}

async function getAmazonListings({ pageSize = 100, nextToken = null } = {}) {
  const sellerId = requireEnv('AMAZON_SELLER_ID');
  const marketplaceId = requireEnv('AMAZON_MARKETPLACE_ID');

  const token = await getLwaAccessToken();
  const client = getSpApiClient(token);

  const params = {
    marketplaceIds: marketplaceId,
    pageSize,
    includedData: 'summaries,attributes,offers'
  };

  if (nextToken) {
    params.nextToken = nextToken;
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

  const brand =
    summary.brand ||
    attributes.brand?.[0]?.value ||
    '';

  const descriptionParts = [];

  if (attributes.product_description?.[0]?.value) {
    descriptionParts.push(attributes.product_description[0].value);
  }

  if (Array.isArray(attributes.bullet_point)) {
    const bullets = attributes.bullet_point
      .map((b) => b.value)
      .filter(Boolean);

    if (bullets.length) {
      descriptionParts.push(
        '<ul>' + bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('') + '</ul>'
      );
    }
  }

  const descriptionHtml =
    descriptionParts.join('<br><br>') ||
    `<p>Prodotto importato da Amazon SKU ${escapeHtml(sku)}</p>`;

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

  const barcode =
    attributes.externally_assigned_product_identifier?.[0]?.value ||
    attributes.item_package_gtin?.[0]?.value ||
    null;

  return {
    sku,
    asin,
    title,
    brand,
    descriptionHtml,
    imageUrls: uniqueImages,
    price,
    barcode,
    raw: item
  };
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
