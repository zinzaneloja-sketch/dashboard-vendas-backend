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
 * URL PÚBLICA (CDN de assets da Vtex) da foto principal de um SKU. Causa raiz real das fotos
 * que não apareciam (confirmada comparando com o produto "Calça Pantalona Detalhe Vivos" no
 * site de verdade da Zinzane, zinzane.com.br): o campo `Url` que getSkuFiles devolve aponta
 * pro bucket S3 de UPLOAD interno da Vtex (ex.: sincdn.s3.sa-east-1.amazonaws.com,
 * wks-s3-sincdn-useast2.s3.us-east-2.amazonaws.com) — esse bucket não é servido publicamente
 * pro navegador, então a foto falhava mesmo quando `Url` vinha preenchida (não era só um
 * problema de IsMain com Url nula — isso também acontecia, mas era secundário). O site
 * público serve as fotos por outro domínio, https://{conta}.vtexassets.com/arquivos/ids/
 * {ArchiveId}-{largura}-auto, construído a partir do `ArchiveId` do arquivo — que a Vtex
 * sempre devolve, ao contrário de `Url`. Por isso ignoramos `Url` completamente e montamos a
 * URL a partir do ArchiveId. Prioriza o arquivo marcado como IsMain; se ele não tiver
 * ArchiveId (não deveria acontecer), cai pro primeiro arquivo da lista que tiver. Devolve
 * null só quando o SKU não tem nenhum arquivo, ou em qualquer falha — SKU removido do
 * catálogo, Vtex fora do ar — pra nunca derrubar o card de "Top produtos" por causa de uma
 * foto que não carregou.
 */
async function getSkuMainImageUrl(skuId) {
  try {
    const files = await getSkuFiles(skuId);
    if (!files.length) return null;
    const temArchiveId = (f) => !!(f && (f.ArchiveId || f.archiveId));
    const main = files.find((f) => (f.IsMain === true || f.isMain === true) && temArchiveId(f));
    const candidato = main || files.find(temArchiveId);
    if (!candidato) return null;
    const archiveId = candidato.ArchiveId || candidato.archiveId;
    return `https://${ACCOUNT}.vtexassets.com/arquivos/ids/${archiveId}-300-auto?width=300&height=auto&aspect=true`;
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
