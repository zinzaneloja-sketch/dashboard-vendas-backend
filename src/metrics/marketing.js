const { pool } = require("../db");
const ga4 = require("../connectors/ga4");

async function sessoesPorCategoriaEProduto({ dateRanges } = {}) {
  const rows = await ga4.runReport("web", {
    dimensions: ["itemCategory", "itemName"],
    metrics: ["sessions", "itemsViewed"],
    dateRanges,
  });
  return rows.map((r) => ({
    categoria: r.itemCategory,
    produto: r.itemName,
    sessoes: r.sessions,
    itensVisualizados: r.itemsViewed,
  }));
}

async function ticketMedio({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_value),0) AS receita, COUNT(*) AS pedidos
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND status NOT IN ('canceled','cancelled')`,
    [dateFrom || null, dateTo || null]
  );
  const receita = Number(rows[0].receita);
  const pedidos = Number(rows[0].pedidos);
  return { receita, pedidos, ticketMedio: pedidos > 0 ? receita / pedidos : 0 };
}

async function conversaoPorOrigem({ dateRanges } = {}) {
  const rows = await ga4.runReport("web", {
    dimensions: ["sessionSourceMedium"],
    metrics: ["sessions", "conversions", "totalRevenue"],
    dateRanges,
  });
  return rows
    .map((r) => ({
      origem: r.sessionSourceMedium,
      sessoes: r.sessions,
      conversoes: r.conversions,
      receita: r.totalRevenue,
      taxaConversaoPct: r.sessions > 0 ? (r.conversions / r.sessions) * 100 : 0,
    }))
    .sort((a, b) => b.sessoes - a.sessoes);
}

async function receitaPorCategoriaEProduto({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT oi.category, oi.product_name, SUM(oi.total_price) AS receita, SUM(oi.quantity) AS unidades
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.category, oi.product_name
     ORDER BY receita DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({
    categoria: r.category || "Sem categoria",
    produto: r.product_name,
    receita: Number(r.receita),
    unidades: Number(r.unidades),
  }));
}

async function receitaPorPagamentoERegiao({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(payment_method,'Não informado') AS metodo,
            COALESCE(region_state,'Não informado') AS regiao,
            SUM(total_value) AS receita
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND status NOT IN ('canceled','cancelled')
     GROUP BY metodo, regiao
     ORDER BY receita DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({ metodo: r.metodo, regiao: r.regiao, receita: Number(r.receita) }));
}

module.exports = {
  sessoesPorCategoriaEProduto,
  ticketMedio,
  conversaoPorOrigem,
  receitaPorCategoriaEProduto,
  receitaPorPagamentoERegiao,
};
