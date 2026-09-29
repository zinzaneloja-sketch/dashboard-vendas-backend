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
 * Divide as vendas do período entre "Liquidação" (item vendido com desconto em relação
 * ao preço de tabela da Vtex) e "Coleção" (vendido a preço cheio, sem desconto). Usa
 * order_items.list_unit_price (preço de tabela) vs unit_price (preço efetivamente
 * cobrado) por item — ver extractItems() em syncVtex.js. Pedidos sincronizados antes
 * dessa coluna existir têm list_unit_price vazio; nesse caso tratamos como "Coleção"
 * (sem desconto) até rodar o backfill, pra não empurrar tudo pro lado errado.
 */
async function vendaPorTipo({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT
       CASE WHEN COALESCE(oi.list_unit_price, oi.unit_price) > oi.unit_price + 0.01
            THEN 'Liquidação' ELSE 'Coleção' END AS tipo,
       SUM(oi.total_price) AS receita,
       SUM(oi.quantity) AS unidades
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY tipo
     ORDER BY tipo ASC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({ tipo: r.tipo, receita: Number(r.receita), unidades: Number(r.unidades) }));
}

/**
 * Receita diária no período (usada no gráfico "Vendas diárias" da aba Vendas), com dias
 * sem nenhuma venda preenchidos como zero — sem isso o gráfico "pula" datas e, pior, a
 * comparação com o período anterior (mesmo tamanho, alinhada por posição do dia e não por
 * data de calendário) desalinharia assim que um dos dois períodos tivesse um dia vazio.
 * `dateFrom`/`dateTo` são obrigatórios aqui (vêm sempre do filtro de período do topo do
 * painel). Agrupamos em UTC e devolvemos a data já como string via to_char(): deixar o
 * pg converter um date_trunc(...) (que vira "timestamp sem fuso") de volta pra um JS Date
 * é ambíguo — o driver assumiria o fuso do processo Node — então evitamos isso na raiz.
 */
async function vendaDiaria({ dateFrom, dateTo } = {}) {
  if (!dateFrom || !dateTo) {
    const err = new Error("dateFrom e dateTo são obrigatórios para venda diária");
    err.status = 400;
    throw err;
  }
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  const dias = (to.getTime() - from.getTime()) / 86400000;
  if (!(dias > 0) || dias > 366) {
    const err = new Error("Período inválido para venda diária (intervalo deve ser positivo e de até 366 dias)");
    err.status = 400;
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT to_char(d.dia, 'YYYY-MM-DD') AS data,
            COALESCE(SUM(o.total_value), 0) AS receita,
            COUNT(o.order_id) AS pedidos
     FROM generate_series(
            date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC'),
            date_trunc('day', ($2::timestamptz - interval '1 second') AT TIME ZONE 'UTC'),
            interval '1 day'
          ) AS d(dia)
     LEFT JOIN orders o
       ON date_trunc('day', o.creation_date AT TIME ZONE 'UTC') = d.dia
      AND o.creation_date >= $1::timestamptz AND o.creation_date < $2::timestamptz
      AND o.status NOT IN ('canceled','cancelled')
     GROUP BY d.dia
     ORDER BY d.dia ASC`,
    [from, to]
  );

  return rows.map((r) => ({ data: r.data, receita: Number(r.receita), pedidos: Number(r.pedidos) }));
}

/**
 * Separa pedidos do período entre clientes "Novo" (esse é o primeiro pedido não cancelado
 * da vida do cliente, considerando TODO o histórico já sincronizado — não só o período
 * selecionado) e "Recorrente" (cliente já tinha comprado antes). Pedidos sem client_id
 * (checkout sem identificação) caem em "Não identificado" à parte, sem contaminar a conta
 * de clientes únicos dos outros dois grupos. Olhar o histórico completo (e não só o período)
 * evita o viés óbvio de período curto: numa janela de 7 dias quase todo mundo pareceria
 * "novo" se a comparação fosse só dentro do próprio período.
 */
async function novosRecorrentes({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `WITH primeira_compra AS (
       SELECT client_id, MIN(creation_date) AS primeira_data
       FROM orders
       WHERE client_id IS NOT NULL AND status NOT IN ('canceled','cancelled')
       GROUP BY client_id
     )
     SELECT
       CASE
         WHEN o.client_id IS NULL THEN 'Não identificado'
         WHEN o.creation_date <= pc.primeira_data THEN 'Novo'
         ELSE 'Recorrente'
       END AS tipo,
       COUNT(DISTINCT o.order_id) AS pedidos,
       COUNT(DISTINCT o.client_id) AS clientes,
       COALESCE(SUM(o.total_value), 0) AS receita
     FROM orders o
     LEFT JOIN primeira_compra pc ON pc.client_id = o.client_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY tipo
     ORDER BY tipo ASC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({ tipo: r.tipo, pedidos: Number(r.pedidos), clientes: Number(r.clientes), receita: Number(r.receita) }));
}

/**
 * Uso de cupons no período: top cupons por nº de pedidos, com receita, desconto concedido
 * (orders.discount_value) e ticket médio de cada um — mesma lógica da aba "Cupons" da
 * planilha de análise. `limit` corta pra não devolver uma cauda longa de cupons usados 1 vez.
 */
async function usoCupons({ dateFrom, dateTo, limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT coupon_code,
            COUNT(*) AS pedidos,
            COALESCE(SUM(total_value), 0) AS receita,
            COALESCE(SUM(discount_value), 0) AS desconto
     FROM orders
     WHERE coupon_code IS NOT NULL
       AND ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND status NOT IN ('canceled','cancelled')
     GROUP BY coupon_code
     ORDER BY pedidos DESC
     LIMIT $3`,
    [dateFrom || null, dateTo || null, limit]
  );
  return rows.map((r) => ({
    cupom: r.coupon_code,
    pedidos: Number(r.pedidos),
    receita: Number(r.receita),
    desconto: Number(r.desconto),
    ticketMedio: Number(r.pedidos) ? Number(r.receita) / Number(r.pedidos) : 0,
  }));
}

/**
 * Compara pedidos com e sem cupom no período: volume, receita e ticket médio de cada grupo.
 * Serve pra responder "cupom tá canibalizando ticket médio ou trazendo pedido incremental?".
 */
async function comparativoCupom({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT
       CASE WHEN coupon_code IS NULL THEN 'Sem cupom' ELSE 'Com cupom' END AS grupo,
       COUNT(*) AS pedidos,
       COALESCE(SUM(total_value), 0) AS receita,
       COALESCE(SUM(discount_value), 0) AS desconto
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND status NOT IN ('canceled','cancelled')
     GROUP BY grupo
     ORDER BY grupo DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({
    grupo: r.grupo,
    pedidos: Number(r.pedidos),
    receita: Number(r.receita),
    desconto: Number(r.desconto),
    ticketMedio: Number(r.pedidos) ? Number(r.receita) / Number(r.pedidos) : 0,
  }));
}

/**
 * Sazonalidade: receita por dia da semana e por hora do dia dentro do período. Agrupamos em
 * UTC com to_char()/extract() diretamente no SQL (mesmo motivo do padrão já usado em
 * vendaDiaria: evitar que o pg converta uma data "sem fuso" de volta pra um JS Date de forma
 * ambígua). `diaSemana` sai como número ISO-like do Postgres (0=domingo..6=sábado, via
 * EXTRACT(DOW)) pro frontend decidir o rótulo em pt-BR.
 */
async function sazonalidade({ dateFrom, dateTo } = {}) {
  const [porDia, porHora] = await Promise.all([
    pool.query(
      `SELECT EXTRACT(DOW FROM creation_date AT TIME ZONE 'UTC')::int AS dia_semana,
              COUNT(*) AS pedidos,
              COALESCE(SUM(total_value), 0) AS receita
       FROM orders
       WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
         AND ($2::timestamptz IS NULL OR creation_date < $2)
         AND status NOT IN ('canceled','cancelled')
       GROUP BY dia_semana
       ORDER BY dia_semana ASC`,
      [dateFrom || null, dateTo || null]
    ),
    pool.query(
      `SELECT EXTRACT(HOUR FROM creation_date AT TIME ZONE 'UTC')::int AS hora,
              COUNT(*) AS pedidos,
              COALESCE(SUM(total_value), 0) AS receita
       FROM orders
       WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
         AND ($2::timestamptz IS NULL OR creation_date < $2)
         AND status NOT IN ('canceled','cancelled')
       GROUP BY hora
       ORDER BY hora ASC`,
      [dateFrom || null, dateTo || null]
    ),
  ]);
  return {
    porDiaSemana: porDia.rows.map((r) => ({ diaSemana: Number(r.dia_semana), pedidos: Number(r.pedidos), receita: Number(r.receita) })),
    porHora: porHora.rows.map((r) => ({ hora: Number(r.hora), pedidos: Number(r.pedidos), receita: Number(r.receita) })),
  };
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
  vendaPorTipo,
  vendaDiaria,
  novosRecorrentes,
  usoCupons,
  comparativoCupom,
  sazonalidade,
  curvaAbcProdutos,
  meiosDePagamento,
  eficienciaFretePorRegiao,
  receitaPorRegiao,
  rankingProdutosXEstoque,
};
