const { pool } = require("../db");

/**
 * Receita vs. meta cadastrada. Metas são sempre mensais (`revenue_goals` é indexada por
 * mês), mas o card de Vendas usa o filtro de período do topo do painel — que pode ser
 * qualquer intervalo, não só um mês cheio. Por isso: quando vem `dateFrom`/`dateTo` (period
 * filter selecionado pelo usuário), a receita é calculada exatamente nesse intervalo, e a
 * meta usada é a do mês em que esse intervalo COMEÇA (já que uma meta só existe por mês).
 * Sem `dateFrom`/`dateTo` (uso do card de Insights, que não tem filtro de período), cai no
 * comportamento antigo: mês calendário atual (ou `month`, se informado) por inteiro.
 */
async function receitaVsMeta({ dateFrom, dateTo, month } = {}) {
  const periodFrom = dateFrom ? new Date(dateFrom) : null;
  const periodTo = dateTo ? new Date(dateTo) : null;

  // Usa os componentes UTC (não os locais) pra achar o 1º dia do mês: dateFrom chega como
  // ISO em UTC do frontend, e o fuso do processo Node pode não ser UTC — misturar getMonth()
  // (local) com um valor que é UTC desloca o mês em 1 perto da virada do dia/mês.
  const monthRef = periodFrom || (month ? new Date(month) : new Date());
  const monthStart = new Date(Date.UTC(monthRef.getUTCFullYear(), monthRef.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(monthRef.getUTCFullYear(), monthRef.getUTCMonth() + 1, 1));

  const revenueFrom = periodFrom || monthStart;
  const revenueTo = periodTo || monthEnd;

  const { rows: revenueRows } = await pool.query(
    `SELECT COALESCE(SUM(total_value),0) AS receita
     FROM orders
     WHERE creation_date >= $1 AND creation_date < $2 AND status NOT IN ('canceled','cancelled')`,
    [revenueFrom, revenueTo]
  );

  const { rows: goalRows } = await pool.query(
    `SELECT goal_value FROM revenue_goals WHERE month = $1`,
    [monthStart.toISOString().slice(0, 10)]
  );

  return {
    mes: monthStart.toISOString().slice(0, 7),
    receita: Number(revenueRows[0].receita),
    meta: goalRows[0] ? Number(goalRows[0].goal_value) : null,
    seguePeriodo: !!(periodFrom && periodTo),
  };
}

async function setRevenueGoal({ month, goalValue }) {
  // Mesmo cuidado de receitaVsMeta acima: usa componentes UTC pra não deslocar o mês
  // dependendo do fuso do processo Node.
  const ref = month.getFullYear ? month : new Date(month);
  const monthKey = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1)).toISOString().slice(0, 10);
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

/**
 * Curva ABC de produtos.
 * @param {object} opts
 * @param {Date}   opts.dateFrom
 * @param {Date}   opts.dateTo
 * @param {string} [opts.categoria]  Filtra por categoria de produto. "todas"/undefined = todas as categorias.
 * @param {string} [opts.metric]     'receita' (padrão) ou 'quantidade' — base de cálculo da curva.
 * @param {string[]} [opts.classes]  Subconjunto de classes a retornar, ex. ['A','B']. undefined = todas.
 */
async function curvaAbcProdutos({ dateFrom, dateTo, categoria, metric, classes } = {}) {
  const useQuantidade = metric === "quantidade";
  const categoriaFiltro = categoria && categoria !== "todas" ? categoria : null;

  const { rows } = await pool.query(
    `SELECT oi.product_name, oi.category,
            SUM(oi.total_price) AS receita,
            SUM(oi.quantity) AS unidades
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
       AND ($3::text IS NULL OR oi.category = $3)
     GROUP BY oi.product_name, oi.category
     ORDER BY ${useQuantidade ? "unidades" : "receita"} DESC`,
    [dateFrom || null, dateTo || null, categoriaFiltro]
  );

  const valorDe = (r) => Number(useQuantidade ? r.unidades : r.receita);
  const total = rows.reduce((sum, r) => sum + valorDe(r), 0) || 1;
  let cumulative = 0;
  const resultado = rows.map((r) => {
    const valor = valorDe(r);
    cumulative += valor;
    const cumulativoPct = (cumulative / total) * 100;
    const classe = cumulativoPct <= 80 ? "A" : cumulativoPct <= 95 ? "B" : "C";
    return {
      produto: r.product_name,
      categoria: r.category,
      receita: Number(r.receita),
      unidades: Number(r.unidades),
      metrica: useQuantidade ? "quantidade" : "receita",
      valorBase: valor,
      participacaoPct: (valor / total) * 100,
      cumulativoPct,
      classe,
    };
  });

  if (Array.isArray(classes) && classes.length > 0) {
    const setClasses = new Set(classes.map((c) => String(c).toUpperCase()));
    return resultado.filter((r) => setClasses.has(r.classe));
  }
  return resultado;
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

/**
 * Ranking de produtos por vendas x estoque, com sugestão de reposição baseada na
 * velocidade de vendas do período.
 * @param {object} opts
 * @param {Date}   opts.dateFrom
 * @param {Date}   opts.dateTo
 * @param {number} [opts.limit]         Limite de linhas (padrão 50; passe um valor alto/undefined a partir da rota "ver tudo").
 * @param {number} [opts.coverageDays]  Dias de cobertura de estoque alvo para a sugestão de reposição (padrão 30).
 */
async function rankingProdutosXEstoque({ dateFrom, dateTo, limit = 50, coverageDays = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT oi.product_name, oi.sku, oi.category,
            SUM(oi.quantity) AS unidades_vendidas,
            SUM(oi.total_price) AS receita,
            COALESCE(MAX(inv.available_quantity), 0) AS estoque_disponivel,
            MIN(o.creation_date) AS primeira_venda,
            MAX(o.creation_date) AS ultima_venda
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN inventory inv ON inv.sku = oi.sku
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.product_name, oi.sku, oi.category
     ORDER BY unidades_vendidas DESC
     LIMIT $3`,
    [dateFrom || null, dateTo || null, limit || null]
  );

  // Duração do período analisado, em dias, para calcular a velocidade de vendas.
  // Quando não há filtro de data explícito, usamos o intervalo real observado nos dados.
  const periodoMs = dateFrom && dateTo ? dateTo.getTime() - dateFrom.getTime() : null;

  return rows.map((r) => {
    const unidadesVendidas = Number(r.unidades_vendidas);
    const estoqueDisponivel = Number(r.estoque_disponivel);

    let diasPeriodo = periodoMs ? periodoMs / 86400000 : null;
    if (!diasPeriodo && r.primeira_venda && r.ultima_venda) {
      const observado = (new Date(r.ultima_venda).getTime() - new Date(r.primeira_venda).getTime()) / 86400000;
      diasPeriodo = observado > 0 ? observado : 1;
    }
    if (!diasPeriodo || diasPeriodo <= 0) diasPeriodo = 30;

    const velocidadeDiaria = unidadesVendidas / diasPeriodo;
    const estoqueAlvo = velocidadeDiaria * coverageDays;
    const sugestaoReposicao = Math.max(0, Math.ceil(estoqueAlvo - estoqueDisponivel));

    return {
      produto: r.product_name,
      sku: r.sku,
      categoria: r.category,
      unidadesVendidas,
      receita: Number(r.receita),
      estoqueDisponivel,
      velocidadeDiaria: Number(velocidadeDiaria.toFixed(2)),
      sugestaoReposicao,
    };
  });
}

module.exports = {
  receitaVsMeta,
  setRevenueGoal,
  vendaPorCategoria,
  curvaAbcProdutos,
  meiosDePagamento,
  eficienciaFretePorRegiao,
  receitaPorRegiao,
  rankingProdutosXEstoque,
};
