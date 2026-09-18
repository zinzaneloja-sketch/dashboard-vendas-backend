const { pool } = require("../db");
const vtex = require("../connectors/vtex");

// Vtex costuma tolerar bem paralelismo moderado; ajuste se receber 429 (Too Many Requests).
const CONCURRENCY = Number(process.env.VTEX_SYNC_CONCURRENCY || 5);

// Janela da sincronização de ROTINA (cron a cada 30 min, sem período explícito): só pedidos
// criados nos últimos N dias. Antes esse valor era 90 e o cron reprocessava os 90 dias
// inteiros do zero a cada rodada — pesado, e mesmo assim nada além disso se atualizava
// sozinho. 30 dias já cobre folgado o ciclo normal de pagamento/separação/entrega; pedido
// mais antigo que isso e que já foi entregue ou cancelado não muda mais, então não precisa
// ser reprocessado de novo. Pra puxar/atualizar um período mais antigo pontualmente, use o
// botão "Sincronizar período histórico" no Admin (ou passe dateFrom/dateTo explícitos aqui).
const DAYS_BACK = Number(process.env.VTEX_SYNC_DAYS_BACK || 30);

// Rede de segurança pra pedido "preso": mesmo fora da janela de rotina acima, se um pedido
// ainda não foi entregue nem cancelado, vale a pena reconferir o status dele por mais um
// tempo (atraso de transportadora, troca, etc.) — mas só até esse limite, senão a rotina
// voltaria a crescer sem fim com pedidos antigos que nunca fecham direito na Vtex.
const REOPEN_DAYS = Number(process.env.VTEX_SYNC_REOPEN_DAYS || 180);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Executa `fn` para cada item de `items`, com no máximo `limit` chamadas em paralelo. */
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

/** Extrai dias úteis/corridos de uma string de shippingEstimate da Vtex, ex: "5bd", "3d", "1h". */
function parseShippingEstimateToDays(estimate) {
  if (!estimate) return null;
  const match = String(estimate).match(/(\d+)(bd|d|h)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "h") return value / 24;
  return value; // trata "bd" (dias úteis) e "d" (dias corridos) de forma equivalente, aproximação
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
 * categoria usando o mapa vindo de `vtex.getCategoryMap()`. Se não encontrar no mapa
 * (categoria removida do catálogo, por ex.), cai para o ID como último recurso.
 */
function resolveCategoryName(item, categoryMap = {}) {
  const categoryId = item.additionalInfo?.categoriesIds?.split("/").filter(Boolean).pop();
  if (categoryId && categoryMap[categoryId]) return categoryMap[categoryId];
  return categoryId || item.productCategoryIds || null;
}

/**
 * Monta um mapa { itemIndex -> warehouseId } a partir de `shippingData.logisticsInfo`.
 * Cada entrada de `logisticsInfo` tem um `itemIndex` que indica a posição do item
 * correspondente dentro do array `items` do pedido, e `deliveryIds[].warehouseId`
 * identifica de qual depósito/loja (estratégia OMNI) aquele item foi expedido.
 * Quando há mais de um `deliveryId` (fulfillment dividido entre lojas), usamos o
 * primeiro — cobre a grande maioria dos casos; pedidos com split parcial de estoque
 * ficam com uma pequena imprecisão aqui, mas não afeta o total de receita, só a
 * atribuição de qual loja fez o envio.
 */
function buildWarehouseIndex(orderDetail) {
  const map = {};
  const logisticsInfo = orderDetail.shippingData?.logisticsInfo || [];
  for (const li of logisticsInfo) {
    if (li.itemIndex === undefined || li.itemIndex === null) continue;
    const warehouseId = li.deliveryIds?.[0]?.warehouseId || null;
    if (warehouseId) map[li.itemIndex] = warehouseId;
  }
  return map;
}

function extractItems(orderDetail, categoryMap = {}) {
  const items = orderDetail.items || [];
  const warehouseByIndex = buildWarehouseIndex(orderDetail);
  return items.map((item, index) => ({
    order_id: orderDetail.orderId,
    product_id: String(item.productId),
    sku: String(item.id),
    product_name: item.name,
    category: resolveCategoryName(item, categoryMap),
    quantity: item.quantity,
    unit_price: (item.price || 0) / 100,
    total_price: ((item.price || 0) * (item.quantity || 0)) / 100,
    // Preço de tabela (sem desconto) do item, segundo a Vtex. Quando `listPrice` não vem
    // no pedido, assumimos igual ao preço cobrado (item.price) — ou seja, sem desconto —
    // pra não classificar um item errado como "liquidação" por falta de dado.
    list_unit_price: (item.listPrice != null ? item.listPrice : (item.price || 0)) / 100,
    warehouse_id: warehouseByIndex[index] || null,
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
      `INSERT INTO order_items (order_id, product_id, sku, product_name, category, quantity, unit_price, total_price, list_unit_price, warehouse_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [item.order_id, item.product_id, item.sku, item.product_name, item.category, item.quantity, item.unit_price, item.total_price, item.list_unit_price, item.warehouse_id]
    );
  }
}

/**
 * Extrai os campos de um depósito/loja retornado por `vtex.listWarehouses()`.
 * O formato exato do endpoint de configuração de depósitos pode variar um pouco
 * por conta/versão da Vtex, então tentamos alguns caminhos alternativos e sempre
 * guardamos o JSON bruto em `raw` — se o estado/cidade não vier certo, dá pra
 * inspecionar `raw` direto no banco pra ajustar a extração sem precisar buscar de novo.
 */
function extractWarehouseFields(w) {
  const address = w.address || w.Address || {};
  return {
    warehouse_id: String(w.id ?? w.warehouseId ?? w.Id ?? ""),
    name: w.name ?? w.Name ?? null,
    state: address.state ?? address.State ?? address.uf ?? address.Uf ?? null,
    city: address.city ?? address.City ?? null,
    is_active: w.isActive ?? w.IsActive ?? null,
    raw: w,
  };
}

/** Sincroniza a lista de depósitos/lojas (warehouses) cadastrados na Vtex. */
async function syncWarehouses() {
  const list = await vtex.listWarehouses();
  console.log(`[sync] ${list.length} depósitos/lojas encontrados na Vtex.`);

  let processed = 0;
  for (const w of list) {
    const f = extractWarehouseFields(w);
    if (!f.warehouse_id) continue;
    await pool.query(
      `INSERT INTO warehouses (warehouse_id, name, state, city, is_active, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (warehouse_id) DO UPDATE SET name = $2, state = $3, city = $4, is_active = $5, raw = $6, synced_at = now()`,
      [f.warehouse_id, f.name, f.state, f.city, f.is_active, JSON.stringify(f.raw)]
    );
    processed += 1;
  }

  console.log(`[sync] depósitos/lojas sincronizados: ${processed}.`);
  return processed;
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

/** Busca o detalhe de um pedido na Vtex e grava (fields + items) no banco. */
async function syncOneOrderById(orderId, categoryMap) {
  const detail = await vtex.getOrderDetail(orderId);
  const fields = extractOrderFields(detail);
  const items = extractItems(detail, categoryMap);
  await upsertOrder(fields);
  await replaceItems(fields.order_id, items);
}

/**
 * Reconfere pedidos mais antigos que a janela de rotina, mas que no nosso banco ainda não
 * aparecem como "fechados" (nem entregues, nem cancelados) — cobre o caso de um pedido
 * demorar mais que `daysBack` pra ser entregue/cancelado (atraso de transportadora, troca,
 * etc.), sem precisar reprocessar TODOS os pedidos antigos de novo. Limitado a `REOPEN_DAYS`
 * pra não crescer sem fim com pedidos velhos que nunca fecham direito na Vtex.
 */
async function reopenPendingOrders(categoryMap, dateFrom) {
  const reopenSince = new Date(dateFrom.getTime() - REOPEN_DAYS * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT order_id FROM orders
     WHERE creation_date < $1 AND creation_date >= $2
       AND status NOT IN ('canceled','cancelled')
       AND delivered_at IS NULL`,
    [dateFrom, reopenSince]
  );
  if (!rows.length) return 0;

  console.log(`[sync] reconferindo ${rows.length} pedido(s) mais antigo(s) que ainda não fecharam (nem entregue, nem cancelado)...`);
  let processed = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    await syncOneOrderById(row.order_id, categoryMap);
    processed += 1;
  });
  console.log(`[sync] reconferência concluída: ${processed} pedido(s) atualizados.`);
  return processed;
}

// Aceita um período explícito (dateFrom/dateTo) para backfill de datas específicas do
// passado — ex: sincronizar só novembro de 2021, sem precisar reprocessar tudo desde então.
// Sem período explícito, cai no comportamento padrão: últimos `daysBack` dias a partir de hoje
// (é isso que o cron automático usa a cada 30 minutos). Nesse caso (rotina), também reconfere
// pedidos mais antigos ainda em aberto — ver `reopenPendingOrders` — pra pegar atualizações
// tardias sem precisar reprocessar tudo desde sempre a cada rodada.
async function syncOrders({ daysBack = DAYS_BACK, dateFrom: explicitFrom, dateTo: explicitTo } = {}) {
  const isRoutine = !explicitFrom && !explicitTo;
  const dateTo = explicitTo ? new Date(explicitTo) : new Date();
  const dateFrom = explicitFrom ? new Date(explicitFrom) : new Date(dateTo.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const categoryMap = await vtex.getCategoryMap().catch((err) => {
    console.error("[sync] falha ao buscar árvore de categorias, usando IDs como fallback:", err.message);
    return {};
  });

  console.log(`[sync] buscando pedidos de ${dateFrom.toISOString()} até ${dateTo.toISOString()}`);
  const summaries = await listOrdersInChunks(dateFrom, dateTo);
  console.log(`[sync] ${summaries.length} pedidos encontrados, buscando detalhes...`);

  let processed = 0;
  await mapWithConcurrency(summaries, CONCURRENCY, async (summary) => {
    await syncOneOrderById(summary.orderId, categoryMap);
    processed += 1;
    if (processed % 50 === 0) console.log(`[sync] ${processed}/${summaries.length} pedidos processados`);
  });

  console.log(`[sync] concluído: ${processed} pedidos sincronizados.`);

  if (isRoutine) {
    await reopenPendingOrders(categoryMap, dateFrom).catch((err) => {
      console.error("[sync] falha ao reconferir pedidos antigos em aberto:", err.response?.data || err.message);
    });
  }

  await pool.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('last_order_sync', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [new Date().toISOString()]
  );
}

/**
 * Backfill rápido: recalcula a categoria (nome real, não ID) e a loja/depósito (warehouse_id)
 * dos itens de todos os pedidos já sincronizados, reaproveitando o JSON bruto (`raw`) já salvo
 * no banco — sem precisar buscar cada pedido de novo na Vtex. Roda `extractItems` de novo, então
 * também é o jeito de popular `warehouse_id` em pedidos sincronizados antes dessa coluna existir.
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

/**
 * Extrai a data em que o SKU "entrou no site" a partir do detalhe do catálogo da Vtex.
 * `DateFirstAvailable` é o campo documentado pra isso, mas guardamos algumas variações
 * defensivamente (e o JSON bruto) porque o nome exato pode variar por conta/versão —
 * se vier tudo null, dá pra inspecionar a coluna `raw` da tabela `inventory` no banco
 * pra achar o campo certo, sem precisar buscar de novo na Vtex.
 */
function extractDateFirstAvailable(detail) {
  return detail.DateFirstAvailable || detail.ReleaseDate || detail.Product?.ReleaseDate || null;
}

async function syncInventory() {
  console.log("[sync] sincronizando estoque...");

  // Mantém a lista de lojas/depósitos (usada pra atribuir cada item vendido à loja OMNI
  // que o expediu) sempre atualizada junto com o estoque. Erro aqui não deve travar a
  // sincronização de estoque em si.
  await syncWarehouses().catch((err) => {
    console.error("[sync] falha ao sincronizar depósitos/lojas:", err.response?.data || err.message);
  });

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
      const dateFirstAvailable = extractDateFirstAvailable(detail);

      await pool.query(
        `INSERT INTO inventory (product_id, sku, product_name, category, available_quantity, date_first_available, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (sku) DO UPDATE SET product_id = $1, product_name = $3, category = $4, available_quantity = $5, date_first_available = $6, raw = $7, synced_at = now()`,
        [String(detail.ProductId), String(skuId), detail.SkuName || detail.NameComplete, detail.CategoryName || null, available, dateFirstAvailable, JSON.stringify(detail)]
      );
      totalSynced += 1;
    });

    page += 1;
    if (page > 200) break; // trava de segurança
  }

  console.log(`[sync] estoque sincronizado: ${totalSynced} SKUs.`);
}

module.exports = { syncOrders, syncInventory, syncWarehouses, backfillCategories, backfillOrderFields };
