const axios = require('axios');
const crypto = require('crypto');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function getScopes() {
  return 'read_products,write_products';
}

function buildShopifyInstallUrl({ shop, state, redirectUri }) {
  const clientId = requireEnv('SHOPIFY_CLIENT_ID');

  const params = new URLSearchParams({
    client_id: clientId,
    scope: getScopes(),
    redirect_uri: redirectUri,
    state
  });

  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

function verifyShopifyCallbackHmac(query, clientSecret) {
  const { hmac, signature, ...rest } = query;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(',') : rest[key];
      return `${key}=${value}`;
    })
    .join('&');

  const generated = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  return generated === hmac;
}

async function exchangeCodeForToken({ shop, code, redirectUri }) {
  const clientId = requireEnv('SHOPIFY_CLIENT_ID');
  const clientSecret = requireEnv('SHOPIFY_CLIENT_SECRET');

  const response = await axios.post(
    `https://${shop}/admin/oauth/access_token`,
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }
  );

  return response.data;
}

async function shopifyGraphQL(accessToken, query, variables = {}) {
  const shop = requireEnv('SHOPIFY_STORE_DOMAIN');
  const apiVersion = requireEnv('SHOPIFY_API_VERSION');

  const response = await axios.post(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      timeout: 30000
    }
  );

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data.data;
}

async function createShopifyProduct({ accessToken, detail }) {
  const tags = [
    'amazon-imported',
    detail.asin ? `amazon-asin:${detail.asin}` : null,
    detail.sku ? `amazon-sku:${detail.sku}` : null
  ].filter(Boolean);

  const productCreateMutation = `
    mutation productCreate($input: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(input: $input, media: $media) {
        product {
          id
          title
          handle
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const media = (detail.imageUrls || []).map((url) => ({
    originalSource: url,
    mediaContentType: 'IMAGE'
  }));

  const variables = {
    input: {
      title: detail.title,
      descriptionHtml: detail.descriptionHtml,
      vendor: detail.brand || 'Amazon Import',
      productType: 'Amazon Import',
      tags,
      status: 'DRAFT'
    },
    media
  };

  const created = await shopifyGraphQL(accessToken, productCreateMutation, variables);

  const result = created.productCreate;

  if (result.userErrors && result.userErrors.length) {
    throw new Error(JSON.stringify(result.userErrors));
  }

  const productId = result.product.id;

  const variantMutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          sku
          barcode
          price
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variantUpdate = await shopifyGraphQL(accessToken, variantMutation, {
    productId,
    variants: [
      {
        price: detail.price || '0.00',
        inventoryItem: {
          sku: detail.sku || '',
          tracked: false
        },
        barcode: detail.barcode || null
      }
    ]
  });

  if (
    variantUpdate.productVariantsBulkUpdate.userErrors &&
    variantUpdate.productVariantsBulkUpdate.userErrors.length
  ) {
    throw new Error(JSON.stringify(variantUpdate.productVariantsBulkUpdate.userErrors));
  }

  return {
    product: result.product,
    variants: variantUpdate.productVariantsBulkUpdate.productVariants
  };
}

module.exports = {
  buildShopifyInstallUrl,
  verifyShopifyCallbackHmac,
  exchangeCodeForToken,
  createShopifyProduct
};
