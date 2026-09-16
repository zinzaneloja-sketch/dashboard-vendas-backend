const { pool } = require("../db");

async function receitaVsMeta({ month } = {}) {
  const ref = month ? new Date(month) : new Date();
  const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const monthEnd = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);

  const { rows: revenueRows } = await pool.query(
    `SELECT COALESCE(SUM(total_value),0) AS receita
     FROM orders
     WHERE creation_date >= $1 AND creation_date < $2 AND status NOT IN ('canceled','cancelled')`,
    [monthStart, monthEnd]
  );

  const { rows: goalRows } = await pool.query(
    `SELECT goal_value FROM revenue_goals WHERE month = $1`,
    [monthStart.toISOString().slice(0, 10)]
  );

  return {
    mes: monthStart.toISOString().slice(0, 7),
    receita: Number(revenueRows[0].receita),
    meta: goalRows[0] ? Number(goalRows[0].goal_value) : null,
  };
}

async function setRevenueGoal({ month, goalValue }) {
  const monthStart = new Date(month.getFullYear ? month : new Date(month));
  const monthKey = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO revenue_goals (month, goal_value) VALUES ($1, $2)
     ON CONFLICT (month) DO UPDATE SET goal_value = $2`,
    [monthKey, goalValue]
  );
}

async function vendaPorCategoria({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT oi.category, SUM(oi.total_price) AS receita, SUM(oi.quantity) AS unidades
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.category
     ORDER BY receita DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({ categoria: r.category || "Sem categoria", receita: Number(r.receita), unidades: Number(r.unidades) }));
}

async function curvaAbcProdutos({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT oi.product_name, oi.category, SUM(oi.total_price) AS receita
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.product_name, oi.category
     ORDER BY receita DESC`,
    [dateFrom || null, dateTo || null]
  );

  const total = rows.reduce((sum, r) => sum + Number(r.receita), 0) || 1;
  let cumulative = 0;
  return rows.map((r) => {
    cumulative += Number(r.receita);
    const cumulativePct = (cumulative / total) * 100;
    const classe = cumulativePct <= 80 ? "A" : cumulativePct <= 95 ? "B" : "C";
    return {
      produto: r.product_name,
      categoria: r.category,
      receita: Number(r.receita),
      participacaoPct: (Number(r.receita) / total) * 100,
      cumulativoPct: cumulativePct,
      classe,
    };
  });
}

async function meiosDePagamento({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(payment_method,'Não informado') AS metodo, COUNT(*) AS pedidos, SUM(total_value) AS receita
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND status NOT IN ('canceled','cancelled')
     GROUP BY metodo
     ORDER BY receita DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({ metodo: r.metodo, pedidos: Number(r.pedidos), receita: Number(r.receita) }));
}

async function eficienciaFretePorRegiao({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(region_state,'Não informado') AS regiao,
            AVG(shipping_actual_days) AS prazo_medio_real,
            AVG(shipping_promised_days) AS prazo_medio_prometido,
            AVG(shipping_value) AS custo_medio_frete,
            COUNT(*) AS pedidos
     FROM orders
     WHERE shipping_actual_days IS NOT NULL
       AND ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
     GROUP BY regiao
     ORDER BY pedidos DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({
    regiao: r.regiao,
    prazoMedioReal: Number(r.prazo_medio_real),
    prazoMedioPrometido: r.prazo_medio_prometido ? Number(r.prazo_medio_prometido) : null,
    custoMedioFrete: Number(r.custo_medio_frete),
    pedidos: Number(r.pedidos),
  }));
}

async function receitaPorRegiao({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(o.region_state,'Não informado') AS regiao,
            COALESCE(o.shipping_carrier,'Não informado') AS transportadora,
            COALESCE(oi.category,'Sem categoria') AS categoria,
            SUM(oi.total_price) AS receita
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY regiao, transportadora, categoria
     ORDER BY receita DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({
    regiao: r.regiao,
    transportadora: r.transportadora,
    categoria: r.categoria,
    receita: Number(r.receita),
  }));
}

async function giroDeEstoque({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT oi.category,
            SUM(oi.quantity) AS unidades_vendidas,
            COALESCE(AVG(inv.available_quantity), 0) AS estoque_medio
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN inventory inv ON inv.sku = oi.sku
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.category`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => {
    const estoqueMedio = Number(r.estoque_medio) || 0;
    const unidades = Number(r.unidades_vendidas);
    return {
      categoria: r.category || "Sem categoria",
      unidadesVendidas: unidades,
      estoqueMedio,
      giro: estoqueMedio > 0 ? unidades / estoqueMedio : null,
    };
  });
}

async function rankingProdutosXEstoque({ dateFrom, dateTo, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT oi.product_name, oi.sku, oi.category,
            SUM(oi.quantity) AS unidades_vendidas,
            SUM(oi.total_price) AS receita,
            COALESCE(MAX(inv.available_quantity), 0) AS estoque_disponivel
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN inventory inv ON inv.sku = oi.sku
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.product_name, oi.sku, oi.category
     ORDER BY unidades_vendidas DESC
     LIMIT $3`,
    [dateFrom || null, dateTo || null, limit]
  );
  return rows.map((r) => ({
    produto: r.product_name,
    sku: r.sku,
    categoria: r.category,
    unidadesVendidas: Number(r.unidades_vendidas),
    receita: Number(r.receita),
    estoqueDisponivel: Number(r.estoque_disponivel),
  }));
}

module.exports = {
  receitaVsMeta,
  setRevenueGoal,
  vendaPorCategoria,
  curvaAbcProdutos,
  meiosDePagamento,
  eficienciaFretePorRegiao,
  receitaPorRegiao,
  giroDeEstoque,
  rankingProdutosXEstoque,
};
