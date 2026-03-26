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
  return 'read_products,write_products,read_inventory,write_inventory,read_locations';
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

async function getExistingKeysMap(accessToken, amazonItems) {
  const map = {};
  const tasks = [];

  for (const item of amazonItems) {
    if (item.sku) {
      tasks.push(
        findVariantByQuery(accessToken, `sku:${escapeSearch(item.sku)}`)
          .then((found) => {
            if (found) {
              map[`sku:${item.sku}`] = found;
            }
          })
      );
    }

    if (item.barcode) {
      tasks.push(
        findVariantByQuery(accessToken, `barcode:${escapeSearch(item.barcode)}`)
          .then((found) => {
            if (found) {
              map[`barcode:${item.barcode}`] = found;
            }
          })
      );
    }
  }

  await Promise.all(tasks);
  return map;
}

async function findVariantByQuery(accessToken, query) {
  const gql = `
    query DuplicateVariantSearch($query: String!) {
      productVariants(first: 1, query: $query) {
        nodes {
          id
          sku
          barcode
          product {
            id
            title
            handle
            status
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(accessToken, gql, { query });
  return data.productVariants?.nodes?.[0] || null;
}

async function createOrRejectShopifyProduct({ accessToken, detail }) {
  const duplicateMap = await getExistingKeysMap(accessToken, [detail]);

  if (
    (detail.sku && duplicateMap[`sku:${detail.sku}`]) ||
    (detail.barcode && duplicateMap[`barcode:${detail.barcode}`])
  ) {
    return {
      created: false,
      duplicate: true,
      reason: 'SKU già presente su Shopify',
      existing: duplicateMap[`sku:${detail.sku}`] || duplicateMap[`barcode:${detail.barcode}`]
    };
  }

  const location = await getFirstLocation(accessToken);
  const created = await createShopifyProduct(accessToken, detail);

  const product = created.product;
  const firstVariant = created.firstVariant;

  await updateVariantData(accessToken, product.id, firstVariant.id, detail);

  const refreshedVariant = await getVariantById(accessToken, firstVariant.id);

  if (detail.quantity > 0 && refreshedVariant?.inventoryItem?.id && location?.id) {
    await ensureInventory(accessToken, refreshedVariant.inventoryItem.id, location.id, detail.quantity);
  }

  return {
    created: true,
    duplicate: false,
    product,
    variant: refreshedVariant || firstVariant
  };
}

async function getFirstLocation(accessToken) {
  const gql = `
    query FirstLocation {
      locations(first: 1) {
        nodes {
          id
          name
        }
      }
    }
  `;

  const data = await shopifyGraphQL(accessToken, gql);
  return data.locations?.nodes?.[0] || null;
}

async function createShopifyProduct(accessToken, detail) {
  const tags = [
    'amazon-imported',
    detail.asin ? `amazon-asin:${detail.asin}` : null,
    detail.sku ? `amazon-sku:${detail.sku}` : null,
    detail.brand ? normalizeTag(detail.brand) : null
  ].filter(Boolean);

  const productCreateMutation = `
    mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product {
          id
          title
          handle
          status
          vendor
          variants(first: 1) {
            nodes {
              id
              sku
              barcode
              price
              inventoryItem {
                id
                sku
                tracked
              }
            }
          }
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
    product: {
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

  const product = result.product;
  const firstVariant = product?.variants?.nodes?.[0];

  if (!firstVariant?.id) {
    throw new Error('Variant iniziale Shopify non trovata dopo productCreate.');
  }

  return { product, firstVariant };
}

async function updateVariantData(accessToken, productId, variantId, detail) {
  const variantMutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          sku
          barcode
          price
          inventoryItem {
            id
            sku
            tracked
            measurement {
              weight {
                value
                unit
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const inventoryItem = {
    sku: detail.sku || '',
    tracked: true,
    requiresShipping: true
  };

  if (detail.weight?.value) {
    inventoryItem.measurement = {
      weight: {
        value: detail.weight.value,
        unit: detail.weight.unit || 'KILOGRAMS'
      }
    };
  }

  const variables = {
    productId,
    variants: [
      {
        id: variantId,
        price: detail.price || '0.00',
        barcode: detail.barcode || null,
        inventoryItem
      }
    ]
  };

  const updated = await shopifyGraphQL(accessToken, variantMutation, variables);

  if (
    updated.productVariantsBulkUpdate.userErrors &&
    updated.productVariantsBulkUpdate.userErrors.length
  ) {
    throw new Error(JSON.stringify(updated.productVariantsBulkUpdate.userErrors));
  }

  return updated.productVariantsBulkUpdate.productVariants?.[0] || null;
}

async function ensureInventory(accessToken, inventoryItemId, locationId, quantity) {
  const activateMutation = `
    mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
        inventoryLevel {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const activated = await shopifyGraphQL(accessToken, activateMutation, {
    inventoryItemId,
    locationId,
    available: Number(quantity || 0)
  });

  const activateErrors = activated.inventoryActivate?.userErrors || [];
  if (activateErrors.length) {
    const msg = JSON.stringify(activateErrors);
    const ignorable = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('stocked');
    if (!ignorable) {
      throw new Error(msg);
    }
  }

  const setMutation = `
    mutation InventorySet($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
          reason
          changes {
            name
            delta
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const setResult = await shopifyGraphQL(accessToken, setMutation, {
    input: {
      name: 'available',
      reason: 'correction',
      ignoreCompareQuantity: true,
      referenceDocumentUri: `gid://amazon-importer/import/${inventoryItemId}`,
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity: Number(quantity || 0)
        }
      ]
    }
  });

  const setErrors = setResult.inventorySetQuantities?.userErrors || [];
  if (setErrors.length) {
    throw new Error(JSON.stringify(setErrors));
  }
}

async function getVariantById(accessToken, variantId) {
  const gql = `
    query VariantById($id: ID!) {
      productVariant(id: $id) {
        id
        sku
        barcode
        price
        inventoryQuantity
        inventoryItem {
          id
          sku
          tracked
          measurement {
            weight {
              value
              unit
            }
          }
        }
        product {
          id
          title
          vendor
          handle
          status
        }
      }
    }
  `;

  const data = await shopifyGraphQL(accessToken, gql, { id: variantId });
  return data.productVariant || null;
}

function normalizeTag(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function escapeSearch(value) {
  return String(value || '').replace(/([:\\()"])/g, '\\$1');
}

module.exports = {
  buildShopifyInstallUrl,
  verifyShopifyCallbackHmac,
  exchangeCodeForToken,
  createOrRejectShopifyProduct,
  getExistingKeysMap
};
