const { pool } = require("../db");
const ga4 = require("../connectors/ga4");

async function receitaPorDispositivo({ dateRanges, source = "web" } = {}) {
  const rows = await ga4.runReport(source, {
    dimensions: ["deviceCategory"],
    metrics: ["totalRevenue", "sessions", "transactions"],
    dateRanges,
  });
  return rows.map((r) => ({
    dispositivo: r.deviceCategory,
    receita: r.totalRevenue,
    sessoes: r.sessions,
    pedidos: r.transactions,
  }));
}

async function taxaDeRejeicao({ dateRanges, source = "web" } = {}) {
  const rows = await ga4.runReport(source, {
    dimensions: [],
    metrics: ["bounceRate", "sessions"],
    dateRanges,
  });
  const r = rows[0] || {};
  return { taxaRejeicaoPct: (r.bounceRate || 0) * 100, sessoes: r.sessions || 0 };
}

async function taxaDeConversao({ dateRanges, source = "web" } = {}) {
  const rows = await ga4.runReport(source, {
    dimensions: [],
    metrics: ["sessions", "conversions"],
    dateRanges,
  });
  const r = rows[0] || {};
  const sessions = r.sessions || 0;
  const conversions = r.conversions || 0;
  return { taxaConversaoPct: sessions > 0 ? (conversions / sessions) * 100 : 0, sessoes: sessions, conversoes: conversions };
}

async function trackingDePedido({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS pedidos
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
     GROUP BY status
     ORDER BY pedidos DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({ status: r.status, pedidos: Number(r.pedidos) }));
}

async function itensPorPedido({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(oi.quantity),0) AS itens, COUNT(DISTINCT o.order_id) AS pedidos
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')`,
    [dateFrom || null, dateTo || null]
  );
  const itens = Number(rows[0].itens);
  const pedidos = Number(rows[0].pedidos);
  return { itens, pedidos, mediaItensPorPedido: pedidos > 0 ? itens / pedidos : 0 };
}

async function ltvPorCategoria({ dateFrom, dateTo } = {}) {
  // Categoria "principal" do cliente = categoria onde ele mais gastou historicamente.
  const { rows } = await pool.query(
    `WITH gasto_cliente_categoria AS (
       SELECT o.client_id, oi.category, SUM(oi.total_price) AS receita
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       WHERE o.client_id IS NOT NULL AND o.status NOT IN ('canceled','cancelled')
       GROUP BY o.client_id, oi.category
     ),
     categoria_principal AS (
       SELECT DISTINCT ON (client_id) client_id, category AS categoria_principal
       FROM gasto_cliente_categoria
       ORDER BY client_id, receita DESC
     ),
     receita_total_cliente AS (
       SELECT o.client_id, SUM(o.total_value) AS receita_total
       FROM orders o
       WHERE o.client_id IS NOT NULL AND o.status NOT IN ('canceled','cancelled')
       GROUP BY o.client_id
     )
     SELECT cp.categoria_principal AS categoria,
            COUNT(*) AS clientes,
            AVG(rtc.receita_total) AS ltv_medio
     FROM categoria_principal cp
     JOIN receita_total_cliente rtc ON rtc.client_id = cp.client_id
     GROUP BY cp.categoria_principal
     ORDER BY ltv_medio DESC`
  );
  return rows.map((r) => ({
    categoria: r.categoria || "Sem categoria",
    clientes: Number(r.clientes),
    ltvMedio: Number(r.ltv_medio),
  }));
}

module.exports = { receitaPorDispositivo, taxaDeRejeicao, taxaDeConversao, trackingDePedido, itensPorPedido, ltvPorCategoria };
