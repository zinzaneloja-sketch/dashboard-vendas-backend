const { pool } = require("../db");
const vtex = require("../connectors/vtex");

const CONCURRENCY = Number(process.env.VTEX_SYNC_CONCURRENCY || 5);
const DAYS_BACK = Number(process.env.VTEX_SYNC_DAYS_BACK || 90);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        console.error(`[sync] erro no item ${current}:`, err.message);
        results[current] = null;
      }
    }
  }

  await Promise.all(new Array(limit).fill(0).map(worker));
  return results;
}

function parseShippingEstimateToDays(estimate) {
  if (!estimate) return null;
  const match = String(estimate).match(/(\d+)(bd|d|h)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "h") return value / 24;
  return value;
}

/**
 * Procura a data de entrega efetiva do pedido. Nesta conta a Vtex não preenche
 * `statusHistory` — quem carrega essa informação é `packageAttachment.packages[].courierStatus`
 * (populado pela transportadora/Correios). Damos preferência a isso e caímos para o
 * histórico de status como alternativa, caso outra conta/transportadora exponha por lá.
 */
function findDeliveredAt(orderDetail) {
  const packages = orderDetail.packageAttachment?.packages || [];
  for (const pkg of packages) {
    const courierStatus = pkg.courierStatus;
    if (!courierStatus) continue;
    if (courierStatus.deliveredDate) return courierStatus.deliveredDate;
    if (courierStatus.finished && Array.isArray(courierStatus.data)) {
      const deliveredEntry = courierStatus.data.find((d) => (d.description || "").toLowerCase().includes("entreg"));
      if (deliveredEntry) return deliveredEntry.lastChange || deliveredEntry.createDate || null;
    }
  }

  const history = orderDetail.statusHistory || orderDetail.changesAttachment?.changesData || [];
  for (const entry of history) {
    const status = (entry.status || entry.newState || "").toLowerCase();
    if (status.includes("deliver") || status.includes("entreg")) {
      return entry.date || entry.dateTime || null;
    }
  }
  return null;
}

function extractOrderFields(orderDetail) {
  const shippingAddress = orderDetail.shippingData?.address || {};
  const logisticsInfo = orderDetail.shippingData?.logisticsInfo?.[0] || {};
  const firstPayment = orderDetail.paymentData?.transactions?.[0]?.payments?.[0] || {};

  const deliveredAt = findDeliveredAt(orderDetail);
  const promisedDays = parseShippingEstimateToDays(logisticsInfo.shippingEstimate);
  const actualDays = deliveredAt
    ? (new Date(deliveredAt) - new Date(orderDetail.creationDate)) / (1000 * 60 * 60 * 24)
    : null;

  return {
    order_id: orderDetail.orderId,
    creation_date: orderDetail.creationDate,
    status: orderDetail.status,
    total_value: (orderDetail.value || 0) / 100,
    shipping_value: (orderDetail.shippingTotal || orderDetail.totals?.find((t) => t.id === "Shipping")?.value || 0) / 100,
    sales_channel: orderDetail.salesChannel,
    client_id: orderDetail.clientProfileData?.email || orderDetail.clientProfileData?.userProfileId || null,
    payment_method: firstPayment.paymentSystemName || null,
    payment_group: firstPayment.group || null,
    region_state: shippingAddress.state || null,
    region_city: shippingAddress.city || null,
    shipping_carrier: logisticsInfo.deliveryCompany || logisticsInfo.selectedSla || null,
    shipping_promised_days: promisedDays,
    shipping_actual_days: actualDays,
    delivered_at: deliveredAt,
    invoiced_at: orderDetail.invoicedDate || null,
    raw: orderDetail,
  };
}

/**
 * A Vtex retorna em `additionalInfo.categoriesIds` algo como "/14/28/", uma pilha de IDs
 * numéricos (não nomes). Resolvemos o ID mais específico (o último) para o nome real da
 * categoria usando o mapa vindo de `vtex.getCategoryMap()`. Se não encontrar no mapa,
 * cai para o ID como último recurso.
 */
function resolveCategoryName(item, categoryMap = {}) {
  const categoryId = item.additionalInfo?.categoriesIds?.split("/").filter(Boolean).pop();
  if (categoryId && categoryMap[categoryId]) return categoryMap[categoryId];
  return categoryId || item.productCategoryIds || null;
}

function extractItems(orderDetail, categoryMap = {}) {
  const items = orderDetail.items || [];
  return items.map((item) => ({
    order_id: orderDetail.orderId,
    product_id: String(item.productId),
    sku: String(item.id),
    product_name: item.name,
    category: resolveCategoryName(item, categoryMap),
    quantity: item.quantity,
    unit_price: (item.price || 0) / 100,
    total_price: ((item.price || 0) * (item.quantity || 0)) / 100,
  }));
}

async function upsertOrder(fields) {
  const cols = Object.keys(fields);
  const values = Object.values(fields).map((v) => (v && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v));
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter((c) => c !== "order_id").map((c) => `${c} = EXCLUDED.${c}`);

  const sql = `
    INSERT INTO orders (${cols.join(", ")}, synced_at)
    VALUES (${placeholders.join(", ")}, now())
    ON CONFLICT (order_id) DO UPDATE SET ${updates.join(", ")}, synced_at = now()
  `;
  await pool.query(sql, values);
}

async function replaceItems(orderId, items) {
  await pool.query("DELETE FROM order_items WHERE order_id = $1", [orderId]);
  for (const item of items) {
    await pool.query(
      `INSERT INTO order_items (order_id, product_id, sku, product_name, category, quantity, unit_price, total_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [item.order_id, item.product_id, item.sku, item.product_name, item.category, item.quantity, item.unit_price, item.total_price]
    );
  }
}

// A API de listagem de pedidos da Vtex não deixa paginar além de ~3000 resultados
// (page * per_page tem um teto). Para contas com muitos pedidos, quebramos o período
// em janelas menores (7 dias) e buscamos cada janela separadamente.
async function listOrdersInChunks(dateFrom, dateTo, chunkDays = 7) {
  const summaries = [];
  let windowStart = new Date(dateFrom);

  while (windowStart < dateTo) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + chunkDays * 24 * 60 * 60 * 1000, dateTo.getTime()));
    const chunk = await vtex.listOrders({ dateFrom: windowStart, dateTo: windowEnd });
    summaries.push(...chunk);
    windowStart = windowEnd;
  }

  return summaries;
}

async function syncOrders({ daysBack = DAYS_BACK } = {}) {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const categoryMap = await vtex.getCategoryMap().catch((err) => {
    console.error("[sync] falha ao buscar árvore de categorias, usando IDs como fallback:", err.message);
    return {};
  });

  console.log(`[sync] buscando pedidos de ${dateFrom.toISOString()} até ${dateTo.toISOString()}`);
  const summaries = await listOrdersInChunks(dateFrom, dateTo);
  console.log(`[sync] ${summaries.length} pedidos encontrados, buscando detalhes...`);

  let processed = 0;
  await mapWithConcurrency(summaries, CONCURRENCY, async (summary) => {
    const detail = await vtex.getOrderDetail(summary.orderId);
    const fields = extractOrderFields(detail);
    const items = extractItems(detail, categoryMap);
    await upsertOrder(fields);
    await replaceItems(fields.order_id, items);
    processed += 1;
    if (processed % 50 === 0) console.log(`[sync] ${processed}/${summaries.length} pedidos processados`);
  });

  console.log(`[sync] concluído: ${processed} pedidos sincronizados.`);
  await pool.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('last_order_sync', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [new Date().toISOString()]
  );
}

/**
 * Backfill rápido: recalcula a categoria (nome real, não ID) dos itens de todos os pedidos
 * já sincronizados, reaproveitando o JSON bruto (`raw`) já salvo no banco — sem precisar
 * buscar cada pedido de novo na Vtex.
 */
async function backfillCategories() {
  const categoryMap = await vtex.getCategoryMap();
  console.log(`[backfill] mapa de categorias carregado: ${Object.keys(categoryMap).length} categorias.`);

  const { rows } = await pool.query("SELECT order_id, raw FROM orders");
  console.log(`[backfill] recalculando categorias de ${rows.length} pedidos...`);

  let processed = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const orderDetail = typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw;
    const items = extractItems(orderDetail, categoryMap);
    await replaceItems(row.order_id, items);
    processed += 1;
    if (processed % 200 === 0) console.log(`[backfill] ${processed}/${rows.length} pedidos recalculados`);
  });

  console.log(`[backfill] concluído: ${processed} pedidos recalculados.`);
}

/**
 * Backfill rápido: recalcula os campos de entrega/logística (delivered_at, dias reais e
 * prometidos de frete) de todos os pedidos já sincronizados, reaproveitando o `raw` salvo
 * no banco. Útil depois de corrigir `findDeliveredAt` para achar a data de entrega certa.
 */
async function backfillOrderFields() {
  const { rows } = await pool.query("SELECT order_id, raw FROM orders");
  console.log(`[backfill-orders] recalculando campos de ${rows.length} pedidos...`);

  let processed = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const orderDetail = typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw;
    const fields = extractOrderFields(orderDetail);
    await upsertOrder(fields);
    processed += 1;
    if (processed % 200 === 0) console.log(`[backfill-orders] ${processed}/${rows.length} pedidos recalculados`);
  });

  console.log(`[backfill-orders] concluído: ${processed} pedidos recalculados.`);
}

async function syncInventory() {
  console.log("[sync] sincronizando estoque...");
  let page = 1;
  let totalSynced = 0;

  while (true) {
    const data = await vtex.listActiveSkuIds({ page, pageSize: 1000 });
    if (!data || data.length === 0) break;

    await mapWithConcurrency(data, CONCURRENCY, async (skuId) => {
      const [detail, inventory] = await Promise.all([
        vtex.getSkuDetail(skuId).catch(() => null),
        vtex.getSkuInventory(skuId).catch(() => null),
      ]);
      if (!detail) return;

      const available = (inventory?.balance || []).reduce((sum, b) => sum + (b.totalQuantity || 0), 0);

      await pool.query(
        `INSERT INTO inventory (product_id, sku, product_name, category, available_quantity, synced_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (sku) DO UPDATE SET product_id = $1, product_name = $3, category = $4, available_quantity = $5, synced_at = now()`,
        [String(detail.ProductId), String(skuId), detail.SkuName || detail.NameComplete, detail.CategoryName || null, available]
      );
      totalSynced += 1;
    });

    page += 1;
    if (page > 200) break;
  }

  console.log(`[sync] estoque sincronizado: ${totalSynced} SKUs.`);
}

module.exports = { syncOrders, syncInventory, backfillCategories, backfillOrderFields };
