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

function buildCreationDateFilter(dateFrom, dateTo) {
  const from = dateFrom.toISOString();
  const to = dateTo.toISOString();
  return `creationDate:[${from} TO ${to}]`;
}

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

async function getOrderDetail(orderId) {
  const { data } = await client.get(`/api/oms/pvt/orders/${orderId}`);
  return data;
}

async function getSkuInventory(skuId) {
  const { data } = await client.get(`/api/logistics/pvt/inventory/skus/${skuId}`);
  return data;
}

async function listActiveSkuIds({ page = 1, pageSize = 1000 } = {}) {
  const { data } = await client.get("/api/catalog_system/pvt/sku/stockkeepingunitids", {
    params: { page, pagesize: pageSize },
  });
  return data || [];
}

async function getSkuDetail(skuId) {
  const { data } = await client.get(`/api/catalog_system/pvt/sku/stockkeepingunitbyid/${skuId}`);
  return data;
}

async function getCategoryTree(levels = 3) {
  const { data } = await client.get(`/api/catalog_system/pub/category/tree/${levels}`);
  return data;
}

function flattenCategoryTree(nodes, map = {}) {
  for (const node of nodes || []) {
    map[String(node.id)] = node.name;
    if (node.children && node.children.length) flattenCategoryTree(node.children, map);
  }
  return map;
}

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
  getCategoryTree,
  getCategoryMap,
};
