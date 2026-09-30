const axios = require("axios");

const ACCOUNT = process.env.VTEX_ACCOUNT;
const APP_KEY = process.env.VTEX_APP_KEY;
const APP_TOKEN = process.env.VTEX_APP_TOKEN;
const ENVIRONMENT = process.env.VTEX_ENVIRONMENT || "vtexcommercestable";

if (!ACCOUNT || !APP_KEY || !APP_TOKEN) {
  console.warn("[vtex] VTEX_ACCOUNT / VTEX_APP_KEY / VTEX_APP_TOKEN não configurados.");
}

const baseURL = `https://${ACCOUNT}.${ENVIRONMENT}.com.br`;

const client = axios.create({
  baseURL,
  headers: {
    "X-VTEX-API-AppKey": APP_KEY,
    "X-VTEX-API-AppToken": APP_TOKEN,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// Alguns ambientes usam apenas https://{account}.myvtex.com para o Admin,
// mas a Order Management API (OMS) roda em vtexcommercestable.com.br por padrão.
// Se sua loja usar outro domínio, ajuste VTEX_ENVIRONMENT nas variáveis de ambiente.

function buildCreationDateFilter(dateFrom, dateTo) {
  const from = dateFrom.toISOString();
  const to = dateTo.toISOString();
  return `creationDate:[${from} TO ${to}]`;
}

/**
 * Lista pedidos (resumo) dentro de um intervalo de datas, paginando automaticamente.
 * status: opcional, ex: "invoiced", "canceled", "handling", etc.
 */
async function listOrders({ dateFrom, dateTo, status, perPage = 100, onPage }) {
  let page = 1;
  let totalPages = 1;
  const allOrders = [];

  do {
    const params = {
      per_page: perPage,
      page,
      f_creationDate: buildCreationDateFilter(dateFrom, dateTo),
    };
    if (status) params.f_status = status;

    const { data } = await client.get("/api/oms/pvt/orders", { params });
    const list = data.list || [];
    allOrders.push(...list);
    if (onPage) await onPage(list, page);

    const paging = data.paging || {};
    totalPages = paging.pages || 1;
    page += 1;
  } while (page <= totalPages);

  return allOrders;
}

/** Busca o detalhe completo de um pedido (itens, pagamento, entrega, histórico de status). */
async function getOrderDetail(orderId) {
  const { data } = await client.get(`/api/oms/pvt/orders/${orderId}`);
  return data;
}

/** Retorna estoque disponível de um SKU específico. */
async function getSkuInventory(skuId) {
  const { data } = await client.get(`/api/logistics/pvt/inventory/skus/${skuId}`);
  return data;
}

/** Lista SKUs ativos no catálogo (paginado via GetStockKeepingUnitIds + detalhe). */
async function listActiveSkuIds({ page = 1, pageSize = 1000 } = {}) {
  const { data } = await client.get("/api/catalog_system/pvt/sku/stockkeepingunitids", {
    params: { page, pagesize: pageSize },
  });
  return data || [];
}

/** Detalhe de um SKU do catálogo (nome, categoria, etc.). */
async function getSkuDetail(skuId) {
  const { data } = await client.get(`/api/catalog_system/pvt/sku/stockkeepingunitbyid/${skuId}`);
  return data;
}

/**
 * Arquivos/fotos associados a um SKU (API de "SKU File Association" da Vtex — mesma família
 * de endpoint privado já usada em getSkuDetail acima). Retorna a lista crua da Vtex: cada
 * item costuma trazer Id, ArchiveId, SkuId, Name, IsMain, Label, Text, Url. Usamos a mesma
 * autenticação (AppKey/AppToken) já configurada no client.
 */
async function getSkuFiles(skuId) {
  const { data } = await client.get(`/api/catalog/pvt/stockkeepingunit/${skuId}/file`);
  return Array.isArray(data) ? data : [];
}

/**
 * URL da foto principal de um SKU (a marcada como IsMain, ou a primeira da lista se nenhuma
 * estiver marcada). Confirmado via /api/debug/sample-product-image contra a conta real da
 * Zinzane: em alguns SKUs o arquivo marcado como IsMain vem com Url null (a Vtex manteve o
 * registro do arquivo mas o link caiu — casos vistos: "Caixa de Presente p", "Calça Legging
 * Seamless Canelado", "Top Faixa Basic"), enquanto outro arquivo do mesmo SKU (geralmente o
 * de Label "color") tem uma Url válida. Por isso só aceitamos o IsMain se ele realmente tiver
 * Url; senão caímos pro primeiro arquivo da lista que tiver uma Url utilizável. Devolve null
 * só quando NENHUM arquivo do SKU tem Url (produto sem foto cadastrada mesmo) ou em qualquer
 * falha — SKU removido do catálogo, Vtex fora do ar — pra nunca derrubar o card de "Top
 * produtos" por causa de uma foto que não carregou.
 */
async function getSkuMainImageUrl(skuId) {
  try {
    const files = await getSkuFiles(skuId);
    if (!files.length) return null;
    const temUrl = (f) => !!(f && (f.Url || f.url));
    const main = files.find((f) => (f.IsMain === true || f.isMain === true) && temUrl(f));
    const candidato = main || files.find(temUrl);
    if (!candidato) return null;
    let url = candidato.Url || candidato.url;
    if (url.startsWith("//")) url = "https:" + url;
    return url;
  } catch (err) {
    console.warn(`[vtex] Falha ao buscar foto do SKU ${skuId}:`, err.message);
    return null;
  }
}

/**
 * Lista os depósitos/lojas (warehouses) cadastrados na conta — inclui as lojas físicas
 * usadas na estratégia OMNI (ship-from-store), de onde o estoque do e-commerce é expedido.
 */
async function listWarehouses() {
  const { data } = await client.get("/api/logistics/pvt/configuration/warehouses");
  return data || [];
}

/** Árvore de categorias do catálogo. */
async function getCategoryTree(levels = 3) {
  const { data } = await client.get(`/api/catalog_system/pub/category/tree/${levels}`);
  return data;
}

/** Achata a árvore de categorias em um mapa { "id": "nome" }, incluindo subcategorias. */
function flattenCategoryTree(nodes, map = {}) {
  for (const node of nodes || []) {
    map[String(node.id)] = node.name;
    if (node.children && node.children.length) flattenCategoryTree(node.children, map);
  }
  return map;
}

/** Busca a árvore de categorias e retorna um mapa id -> nome, pronto para lookup. */
async function getCategoryMap(levels = 5) {
  const tree = await getCategoryTree(levels);
  return flattenCategoryTree(tree);
}

module.exports = {
  client,
  listOrders,
  getOrderDetail,
  getSkuInventory,
  listActiveSkuIds,
  getSkuDetail,
  getSkuFiles,
  getSkuMainImageUrl,
  getCategoryTree,
  getCategoryMap,
  listWarehouses,
};
