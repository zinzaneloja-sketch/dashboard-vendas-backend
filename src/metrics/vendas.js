const { pool } = require("../db");
const vtex = require("../connectors/vtex");

// Fuso horário da loja, usado em toda métrica que agrupa/extrai por DIA, DIA DA SEMANA ou
// HORA (Vendas diárias, Vendas por dia da semana, Vendas por hora do dia, Projeção de
// fechamento do dia). `creation_date` é salvo como timestamptz (instante absoluto, sem
// ambiguidade) — o bug que isso corrige é usar 'UTC' como fuso de referência pra "que dia/hora
// é esse instante", quando a loja opera em horário de Brasília (UTC-3, sem horário de verão
// desde 2019). Um pedido feito às 22h de Brasília vira 01h UTC do dia SEGUINTE — com 'UTC'
// como referência, esse pedido caía no dia errado (e na hora errada, e por tabela às vezes no
// dia da semana errado), fazendo o "Vendas diárias" de ontem aparecer menor do que o real (a
// receita da noite migrava pra hoje) e a "Projeção de fechamento do dia" comparar hoje com o
// dia da semana errado perto da virada. Configurável via STORE_TIMEZONE (nome de fuso IANA)
// caso a loja opere em outro fuso; América/São_Paulo é o padrão certo pra essa conta.
const STORE_TZ = process.env.STORE_TIMEZONE || "America/Sao_Paulo";

/**
 * Filtro de status usado por quase toda métrica da aba Vendas (o filtro "Status" no topo da
 * aba, ao lado do período). `pushStatusParam` empilha o valor no array de bind da query e
 * devolve o índice ($N) pra usar em `statusClause`; separados porque algumas queries
 * referenciam a coluna com apelidos diferentes (`status` numa CTE sem alias, `o.status` na
 * query principal) mas precisam ser o MESMO parâmetro — chamar `pushStatusParam` uma vez só
 * e reusar o índice evita duplicar o bind. Sem `statuses` explícito (undefined/[]), cai no
 * comportamento histórico do painel: tudo exceto cancelado — é isso que `IS NULL` cobre.
 */
function pushStatusParam(statuses, params) {
  params.push(Array.isArray(statuses) && statuses.length ? statuses : null);
  return params.length;
}
function statusClause(column, idx) {
  return `(($${idx}::text[] IS NULL AND ${column} NOT IN ('canceled','cancelled')) OR ($${idx}::text[] IS NOT NULL AND ${column} = ANY($${idx}::text[])))`;
}

/**
 * Receita vs. meta cadastrada. Metas são sempre mensais (`revenue_goals` é indexada por
 * mês), mas o card de Vendas usa o filtro de período do topo do painel — que pode ser
 * qualquer intervalo, não só um mês cheio. Por isso: quando vem `dateFrom`/`dateTo` (period
 * filter selecionado pelo usuário), a receita é calculada exatamente nesse intervalo, e a
 * meta usada é a do mês em que esse intervalo COMEÇA (já que uma meta só existe por mês).
 * Sem `dateFrom`/`dateTo` (uso do card de Insights, que não tem filtro de período), cai no
 * comportamento antigo: mês calendário atual (ou `month`, se informado) por inteiro.
 */
async function receitaVsMeta({ dateFrom, dateTo, month, statuses } = {}) {
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

  const revenueParams = [revenueFrom, revenueTo];
  const revenueStatusIdx = pushStatusParam(statuses, revenueParams);
  const { rows: revenueRows } = await pool.query(
    `SELECT COALESCE(SUM(total_value),0) AS receita
     FROM orders
     WHERE creation_date >= $1 AND creation_date < $2 AND ${statusClause("status", revenueStatusIdx)}`,
    revenueParams
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

async function vendaPorCategoria({ dateFrom, dateTo, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `SELECT oi.category, SUM(oi.total_price) AS receita, SUM(oi.quantity) AS unidades
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND ${statusClause("o.status", statusIdx)}
     GROUP BY oi.category
     ORDER BY receita DESC`,
    params
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
async function vendaPorTipo({ dateFrom, dateTo, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
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
       AND ${statusClause("o.status", statusIdx)}
     GROUP BY tipo
     ORDER BY tipo ASC`,
    params
  );
  return rows.map((r) => ({ tipo: r.tipo, receita: Number(r.receita), unidades: Number(r.unidades) }));
}

/**
 * Receita diária no período (usada no gráfico "Vendas diárias" da aba Vendas), com dias
 * sem nenhuma venda preenchidos como zero — sem isso o gráfico "pula" datas e, pior, a
 * comparação com o período anterior (mesmo tamanho, alinhada por posição do dia e não por
 * data de calendário) desalinharia assim que um dos dois períodos tivesse um dia vazio.
 * `dateFrom`/`dateTo` são obrigatórios aqui (vêm sempre do filtro de período do topo do
 * painel). Agrupamos no fuso da loja (STORE_TZ) — não em UTC — pra "ontem" e "hoje" baterem
 * com o calendário de Brasília, não com o calendário UTC (ver comentário de STORE_TZ no topo
 * do arquivo). Devolvemos a data já como string via to_char(): deixar o pg converter um
 * date_trunc(...) (que vira "timestamp sem fuso") de volta pra um JS Date é ambíguo — o driver
 * assumiria o fuso do processo Node — então evitamos isso na raiz.
 */
async function vendaDiaria({ dateFrom, dateTo, statuses } = {}) {
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

  const params = [from, to];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `SELECT to_char(d.dia, 'YYYY-MM-DD') AS data,
            COALESCE(SUM(o.total_value), 0) AS receita,
            COUNT(o.order_id) AS pedidos
     FROM generate_series(
            date_trunc('day', $1::timestamptz AT TIME ZONE '${STORE_TZ}'),
            date_trunc('day', ($2::timestamptz - interval '1 second') AT TIME ZONE '${STORE_TZ}'),
            interval '1 day'
          ) AS d(dia)
     LEFT JOIN orders o
       ON date_trunc('day', o.creation_date AT TIME ZONE '${STORE_TZ}') = d.dia
      AND o.creation_date >= $1::timestamptz AND o.creation_date < $2::timestamptz
      AND ${statusClause("o.status", statusIdx)}
     GROUP BY d.dia
     ORDER BY d.dia ASC`,
    params
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
async function novosRecorrentes({ dateFrom, dateTo, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `WITH primeira_compra AS (
       SELECT client_id, MIN(creation_date) AS primeira_data
       FROM orders
       WHERE client_id IS NOT NULL AND ${statusClause("status", statusIdx)}
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
       AND ${statusClause("o.status", statusIdx)}
     GROUP BY tipo
     ORDER BY tipo ASC`,
    params
  );
  return rows.map((r) => ({ tipo: r.tipo, pedidos: Number(r.pedidos), clientes: Number(r.clientes), receita: Number(r.receita) }));
}

/**
 * Uso de cupons no período: top cupons por nº de pedidos, com receita, desconto concedido
 * (orders.discount_value) e ticket médio de cada um — mesma lógica da aba "Cupons" da
 * planilha de análise. `limit` corta pra não devolver uma cauda longa de cupons usados 1 vez.
 */
async function usoCupons({ dateFrom, dateTo, limit = 20, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  params.push(limit);
  const limitIdx = params.length;
  const { rows } = await pool.query(
    `SELECT coupon_code,
            COUNT(*) AS pedidos,
            COALESCE(SUM(total_value), 0) AS receita,
            COALESCE(SUM(discount_value), 0) AS desconto
     FROM orders
     WHERE coupon_code IS NOT NULL
       AND ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND ${statusClause("status", statusIdx)}
     GROUP BY coupon_code
     ORDER BY pedidos DESC
     LIMIT $${limitIdx}`,
    params
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
async function comparativoCupom({ dateFrom, dateTo, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `SELECT
       CASE WHEN coupon_code IS NULL THEN 'Sem cupom' ELSE 'Com cupom' END AS grupo,
       COUNT(*) AS pedidos,
       COALESCE(SUM(total_value), 0) AS receita,
       COALESCE(SUM(discount_value), 0) AS desconto
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND ${statusClause("status", statusIdx)}
     GROUP BY grupo
     ORDER BY grupo DESC`,
    params
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
async function sazonalidade({ dateFrom, dateTo, statuses } = {}) {
  const porDiaParams = [dateFrom || null, dateTo || null];
  const porDiaStatusIdx = pushStatusParam(statuses, porDiaParams);
  const porHoraParams = [dateFrom || null, dateTo || null];
  const porHoraStatusIdx = pushStatusParam(statuses, porHoraParams);

  const [porDia, porHora] = await Promise.all([
    pool.query(
      `SELECT EXTRACT(DOW FROM creation_date AT TIME ZONE '${STORE_TZ}')::int AS dia_semana,
              COUNT(*) AS pedidos,
              COALESCE(SUM(total_value), 0) AS receita
       FROM orders
       WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
         AND ($2::timestamptz IS NULL OR creation_date < $2)
         AND ${statusClause("status", porDiaStatusIdx)}
       GROUP BY dia_semana
       ORDER BY dia_semana ASC`,
      porDiaParams
    ),
    pool.query(
      `SELECT EXTRACT(HOUR FROM creation_date AT TIME ZONE '${STORE_TZ}')::int AS hora,
              COUNT(*) AS pedidos,
              COALESCE(SUM(total_value), 0) AS receita
       FROM orders
       WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
         AND ($2::timestamptz IS NULL OR creation_date < $2)
         AND ${statusClause("status", porHoraStatusIdx)}
       GROUP BY hora
       ORDER BY hora ASC`,
      porHoraParams
    ),
  ]);
  return {
    porDiaSemana: porDia.rows.map((r) => ({ diaSemana: Number(r.dia_semana), pedidos: Number(r.pedidos), receita: Number(r.receita) })),
    porHora: porHora.rows.map((r) => ({ hora: Number(r.hora), pedidos: Number(r.pedidos), receita: Number(r.receita) })),
  };
}

// Janela de histórico olhada pra trás a partir de hoje pra montar a curva intradiária do
// mesmo dia da semana (ex.: últimas ~12 terças-feiras). Fixa (não usa o filtro de período do
// topo do painel) porque a projeção sempre precisa comparar "hoje" com um passado recente o
// bastante pra não estar desatualizado, mas com amostra suficiente (várias ocorrências do
// mesmo dia da semana) — um período curto escolhido pelo usuário (ex. "7 dias") não teria
// nem uma ocorrência a mais do dia de hoje pra formar a curva.
const PROJECAO_LOOKBACK_DIAS = 84; // ~12 semanas
const PROJECAO_MIN_DIAS_AMOSTRA = 3; // menos que isso, a curva histórica é ruído demais pra confiar
const PROJECAO_MIN_FRACAO_DECORRIDA = 0.02; // <2% do dia típico decorrido: dividir por isso amplificaria qualquer ruído

/**
 * Projeção de fechamento do dia: olha o quanto já foi vendido hoje e estima o total do dia
 * comparando com o quanto historicamente já costuma ter sido vendido, até a hora atual, num
 * dia com o mesmo dia da semana de hoje (ex.: hoje é terça 14h — historicamente, que fração
 * da receita de uma terça-feira típica já aconteceu até as 14h?). A projeção é simplesmente
 * receita de hoje até agora ÷ essa fração.
 *
 * `estado` diz ao frontend o que mostrar:
 *  - "ok": projeção calculada com confiança (amostra e fração decorrida suficientes).
 *  - "cedo_demais": ainda é cedo demais no dia (fração histórica decorrida até agora muito
 *    pequena) — mostrar só a receita de hoje até agora, sem projetar.
 *  - "dados_insuficientes": não há histórico suficiente desse dia da semana na janela de
 *    lookback (loja nova, ou pedidos recém-começaram a ser sincronizados).
 */
async function projecaoFechamentoDia({ statuses } = {}) {
  const params = [];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `WITH params AS (
       SELECT
         -- "hoje" precisa continuar timestamptz (não um timestamp sem fuso) pra comparar
         -- direto com o.creation_date mais abaixo sem cair na pegadinha de comparação
         -- timestamptz x timestamp (que o Postgres resolveria usando o fuso da SESSÃO, não
         -- o '${STORE_TZ}' que usamos aqui) — por isso a dupla conversão AT TIME ZONE: a
         -- primeira lê o instante atual como hora de parede em ${STORE_TZ}, o date_trunc
         -- corta pra meia-noite NESSA hora de parede, e a segunda AT TIME ZONE converte essa
         -- meia-noite de volta pra um instante absoluto (timestamptz) correto.
         date_trunc('day', now() AT TIME ZONE '${STORE_TZ}') AT TIME ZONE '${STORE_TZ}' AS hoje,
         EXTRACT(DOW FROM now() AT TIME ZONE '${STORE_TZ}')::int AS dia_semana_hoje,
         EXTRACT(HOUR FROM now() AT TIME ZONE '${STORE_TZ}')::int AS hora_atual
     ),
     hoje_receita AS (
       SELECT COALESCE(SUM(o.total_value), 0) AS receita, COUNT(*) AS pedidos
       FROM orders o CROSS JOIN params p
       WHERE o.creation_date >= p.hoje
         AND o.creation_date < p.hoje + interval '1 day'
         AND ${statusClause("o.status", statusIdx)}
     ),
     historico AS (
       SELECT date_trunc('day', o.creation_date AT TIME ZONE '${STORE_TZ}') AS dia,
              EXTRACT(HOUR FROM o.creation_date AT TIME ZONE '${STORE_TZ}')::int AS hora,
              o.total_value
       FROM orders o CROSS JOIN params p
       WHERE o.creation_date >= p.hoje - interval '${PROJECAO_LOOKBACK_DIAS} days'
         AND o.creation_date < p.hoje
         AND EXTRACT(DOW FROM o.creation_date AT TIME ZONE '${STORE_TZ}')::int = p.dia_semana_hoje
         AND ${statusClause("o.status", statusIdx)}
     )
     SELECT
       (SELECT dia_semana_hoje FROM params) AS dia_semana,
       (SELECT hora_atual FROM params) AS hora_atual,
       (SELECT receita FROM hoje_receita) AS receita_hoje,
       (SELECT pedidos FROM hoje_receita) AS pedidos_hoje,
       COALESCE(SUM(h.total_value) FILTER (WHERE h.hora <= (SELECT hora_atual FROM params)), 0) AS receita_historica_ate_hora,
       COALESCE(SUM(h.total_value), 0) AS receita_historica_dia_total,
       COUNT(DISTINCT h.dia) AS dias_amostra
     FROM historico h`,
    params
  );

  const row = rows[0] || {};
  const diaSemana = Number(row.dia_semana);
  const horaAtual = Number(row.hora_atual);
  const receitaHoje = Number(row.receita_hoje || 0);
  const pedidosHoje = Number(row.pedidos_hoje || 0);
  const receitaHistoricaAteHora = Number(row.receita_historica_ate_hora || 0);
  const receitaHistoricaDiaTotal = Number(row.receita_historica_dia_total || 0);
  const diasAmostra = Number(row.dias_amostra || 0);
  const fracaoDecorrida = receitaHistoricaDiaTotal > 0 ? receitaHistoricaAteHora / receitaHistoricaDiaTotal : 0;

  let estado = "ok";
  if (diasAmostra < PROJECAO_MIN_DIAS_AMOSTRA || receitaHistoricaDiaTotal <= 0) {
    estado = "dados_insuficientes";
  } else if (fracaoDecorrida < PROJECAO_MIN_FRACAO_DECORRIDA) {
    estado = "cedo_demais";
  }

  return {
    diaSemana,
    horaAtual,
    receitaHoje,
    pedidosHoje,
    percentualDecorrido: fracaoDecorrida * 100,
    projecaoFechamento: estado === "ok" ? receitaHoje / fracaoDecorrida : null,
    mediaHistoricaDiaSemana: diasAmostra > 0 ? receitaHistoricaDiaTotal / diasAmostra : 0,
    diasAmostra,
    estado,
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
async function curvaAbcProdutos({ dateFrom, dateTo, categoria, metric, classes, statuses } = {}) {
  const useQuantidade = metric === "quantidade";
  const categoriaFiltro = categoria && categoria !== "todas" ? categoria : null;

  const params = [dateFrom || null, dateTo || null, categoriaFiltro];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `SELECT oi.product_name, oi.category,
            SUM(oi.total_price) AS receita,
            SUM(oi.quantity) AS unidades
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND ${statusClause("o.status", statusIdx)}
       AND ($3::text IS NULL OR oi.category = $3)
     GROUP BY oi.product_name, oi.category
     ORDER BY ${useQuantidade ? "unidades" : "receita"} DESC`,
    params
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

async function meiosDePagamento({ dateFrom, dateTo, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `SELECT COALESCE(payment_method,'Não informado') AS metodo, COUNT(*) AS pedidos, SUM(total_value) AS receita
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)
       AND ${statusClause("status", statusIdx)}
     GROUP BY metodo
     ORDER BY receita DESC`,
    params
  );
  return rows.map((r) => ({ metodo: r.metodo, pedidos: Number(r.pedidos), receita: Number(r.receita) }));
}

async function eficienciaFretePorRegiao({ dateFrom, dateTo, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
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
       AND ${statusClause("status", statusIdx)}
     GROUP BY regiao
     ORDER BY pedidos DESC`,
    params
  );
  return rows.map((r) => ({
    regiao: r.regiao,
    prazoMedioReal: Number(r.prazo_medio_real),
    prazoMedioPrometido: r.prazo_medio_prometido ? Number(r.prazo_medio_prometido) : null,
    custoMedioFrete: Number(r.custo_medio_frete),
    pedidos: Number(r.pedidos),
  }));
}

async function receitaPorRegiao({ dateFrom, dateTo, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `SELECT COALESCE(o.region_state,'Não informado') AS regiao,
            COALESCE(o.shipping_carrier,'Não informado') AS transportadora,
            COALESCE(oi.category,'Sem categoria') AS categoria,
            SUM(oi.total_price) AS receita
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND ${statusClause("o.status", statusIdx)}
     GROUP BY regiao, transportadora, categoria
     ORDER BY receita DESC`,
    params
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
async function rankingProdutosXEstoque({ dateFrom, dateTo, limit = 50, coverageDays = 30, statuses } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  params.push(limit || null);
  const limitIdx = params.length;
  const { rows } = await pool.query(
    `SELECT oi.product_name, oi.sku, oi.category,
            SUM(oi.quantity) AS unidades_vendidas,
            SUM(oi.total_price) AS receita,
            COALESCE(MAX(inv.available_quantity), 0) AS estoque_disponivel,
            COALESCE(BOOL_OR(inv.has_unlimited_quantity), false) AS estoque_ilimitado,
            MIN(o.creation_date) AS primeira_venda,
            MAX(o.creation_date) AS ultima_venda
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN inventory inv ON inv.sku = oi.sku
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND ${statusClause("o.status", statusIdx)}
     GROUP BY oi.product_name, oi.sku, oi.category
     ORDER BY unidades_vendidas DESC
     LIMIT $${limitIdx}`,
    params
  );

  // Duração do período analisado, em dias, para calcular a velocidade de vendas.
  // Quando não há filtro de data explícito, usamos o intervalo real observado nos dados.
  const periodoMs = dateFrom && dateTo ? dateTo.getTime() - dateFrom.getTime() : null;

  return rows.map((r) => {
    const unidadesVendidas = Number(r.unidades_vendidas);
    const estoqueDisponivel = Number(r.estoque_disponivel);
    const estoqueIlimitado = Boolean(r.estoque_ilimitado);

    let diasPeriodo = periodoMs ? periodoMs / 86400000 : null;
    if (!diasPeriodo && r.primeira_venda && r.ultima_venda) {
      const observado = (new Date(r.ultima_venda).getTime() - new Date(r.primeira_venda).getTime()) / 86400000;
      diasPeriodo = observado > 0 ? observado : 1;
    }
    if (!diasPeriodo || diasPeriodo <= 0) diasPeriodo = 30;

    const velocidadeDiaria = unidadesVendidas / diasPeriodo;
    const estoqueAlvo = velocidadeDiaria * coverageDays;
    // Estoque ilimitado nunca precisa de reposição, independente da conta acima.
    const sugestaoReposicao = estoqueIlimitado ? 0 : Math.max(0, Math.ceil(estoqueAlvo - estoqueDisponivel));

    return {
      produto: r.product_name,
      sku: r.sku,
      categoria: r.category,
      unidadesVendidas,
      receita: Number(r.receita),
      estoqueDisponivel,
      estoqueIlimitado,
      velocidadeDiaria: Number(velocidadeDiaria.toFixed(2)),
      sugestaoReposicao,
    };
  });
}

/**
 * Resolve a foto principal de cada produto de `rows` (cada item precisa de `productId` e
 * `skuRepresentativo`), usando um cache em `product_images` pra não bater na Vtex a cada
 * carregamento do card — só busca de verdade os produtos que ainda não têm foto em cache.
 * Devolve um mapa productId -> URL (ou undefined se não achou). Falha ao buscar a foto de UM
 * produto nunca derruba o card inteiro: ele só fica sem foto até a próxima tentativa (por
 * isso não cacheamos "sem foto" — permite retry no próximo carregamento).
 */
async function resolveProductImages(items) {
  const bySkuRepresentativo = {};
  items.forEach((it) => { if (it.productId) bySkuRepresentativo[it.productId] = it.skuRepresentativo; });
  const productIds = Object.keys(bySkuRepresentativo);
  if (!productIds.length) return {};

  const { rows: cached } = await pool.query(
    `SELECT product_id, image_url FROM product_images WHERE product_id = ANY($1::text[])`,
    [productIds]
  );
  const map = {};
  cached.forEach((r) => { if (r.image_url) map[r.product_id] = r.image_url; });

  const missing = productIds.filter((id) => !map[id]);
  const CONCURRENCIA = 5;
  for (let i = 0; i < missing.length; i += CONCURRENCIA) {
    const lote = missing.slice(i, i + CONCURRENCIA);
    const resultados = await Promise.all(
      lote.map((productId) => vtex.getSkuMainImageUrl(bySkuRepresentativo[productId]).catch(() => null))
    );
    lote.forEach((productId, idx) => { if (resultados[idx]) map[productId] = resultados[idx]; });
  }

  const paraCachear = missing.filter((id) => map[id]);
  if (paraCachear.length) {
    const values = [];
    const params = [];
    paraCachear.forEach((id) => {
      params.push(id, map[id]);
      values.push(`($${params.length - 1}, $${params.length})`);
    });
    await pool
      .query(
        `INSERT INTO product_images (product_id, image_url) VALUES ${values.join(",")}
         ON CONFLICT (product_id) DO UPDATE SET image_url = EXCLUDED.image_url, synced_at = now()`,
        params
      )
      .catch((err) => console.warn("[vendas] Falha ao cachear fotos de produto:", err.message));
  }

  return map;
}

/**
 * Acha o maior prefixo comum a uma lista de nomes e corta no último " - " completo antes
 * dele, pra não cortar no meio de uma palavra. Usado pra tirar um "nome base" de produto a
 * partir dos nomes completos das suas variações (que na Zinzane incluem tamanho e cor no
 * final, ex.: "Blusa Manga 7/8 - Preto G - PRETO" / "... - Preto M - PRETO" -> "Blusa Manga
 * 7/8"). Só usa dado que já temos (product_name salvo do pedido) — nada de campo novo da
 * Vtex. Com uma única variação (produto de tamanho único), devolve o próprio nome, sem cortar
 * nada.
 */
function nomeBaseComum(nomes) {
  const unicos = Array.from(new Set((nomes || []).filter(Boolean)));
  if (!unicos.length) return null;
  if (unicos.length === 1) return unicos[0];
  let prefixo = unicos[0];
  for (let i = 1; i < unicos.length && prefixo; i++) {
    const atual = unicos[i];
    let j = 0;
    while (j < prefixo.length && j < atual.length && prefixo[j] === atual[j]) j++;
    prefixo = prefixo.slice(0, j);
  }
  const corte = prefixo.lastIndexOf(" - ");
  const base = (corte > 0 ? prefixo.slice(0, corte) : prefixo).trim();
  return base || unicos[0];
}

/**
 * Top produtos mais vendidos (por unidades), pra identificação visual rápida — pensado pra
 * mostrar foto + nome + unidades + valor total num card com "ver tudo". Agrupa por PRODUTO
 * (product_id da Vtex), não por SKU, pra não diluir um produto com várias variações de
 * tamanho em várias linhas separadas — confirmado via /api/debug/sample-product-image que
 * nessa loja tamanhos diferentes do mesmo produto/cor têm o MESMO product_id (o que muda é só
 * o SKU e o product_name completo). Uma versão anterior desse agrupamento incluía
 * product_name no GROUP BY, o que na prática desfazia o agrupamento (cada tamanho tem um
 * product_name diferente) — corrigido aqui. `skuRepresentativo` é a variação mais vendida
 * desse produto no período, usada só pra buscar UMA foto (a Vtex associa fotos a SKU, não a
 * produto); `nomesVariacoes` (nomes completos de cada SKU do grupo) alimenta nomeBaseComum
 * pra mostrar um nome sem o tamanho/cor repetido, e `variacoes` diz quantos SKUs distintos
 * venderam nesse produto no período — é o que decide se o card mostra o link "ver tamanhos".
 * `estoqueDisponivel` soma o estoque de TODOS os SKUs (tamanhos) desse product_id na tabela
 * `inventory` (sincronizada da Vtex), pra dar uma visão geral de disponibilidade já na linha
 * agrupada, sem precisar abrir o detalhamento por tamanho. A soma vem de uma subquery
 * pré-agregada por product_id (uma linha por produto) antes do JOIN, exatamente pra não
 * multiplicar as linhas de order_items (o que infla unidades_vendidas/receita) — cada produto
 * tem várias linhas em `inventory` (uma por SKU/tamanho), então um JOIN direto sem pré-agregar
 * contaria cada pedido uma vez por tamanho do produto.
 */
async function produtosMaisVendidos({ dateFrom, dateTo, statuses, limit = 60 } = {}) {
  const params = [dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  params.push(limit || null);
  const limitIdx = params.length;
  const { rows } = await pool.query(
    `SELECT oi.product_id,
            array_agg(DISTINCT oi.product_name) AS nomes_variacoes,
            (array_agg(oi.category ORDER BY oi.quantity DESC, oi.id ASC))[1] AS category,
            SUM(oi.quantity) AS unidades_vendidas,
            SUM(oi.total_price) AS receita,
            (array_agg(oi.sku ORDER BY oi.quantity DESC, oi.id ASC))[1] AS sku_representativo,
            COUNT(DISTINCT oi.sku) AS variacoes,
            COALESCE(MAX(inv.estoque_disponivel), 0) AS estoque_disponivel,
            COALESCE(MAX(inv.tem_ilimitado::int), 0)::boolean AS estoque_ilimitado
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN (
       SELECT product_id, SUM(available_quantity) AS estoque_disponivel, BOOL_OR(has_unlimited_quantity) AS tem_ilimitado
       FROM inventory
       GROUP BY product_id
     ) inv ON inv.product_id = oi.product_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND ${statusClause("o.status", statusIdx)}
     GROUP BY oi.product_id
     ORDER BY unidades_vendidas DESC
     LIMIT $${limitIdx}`,
    params
  );

  const items = rows.map((r) => ({ productId: r.product_id, skuRepresentativo: r.sku_representativo }));
  const imagens = await resolveProductImages(items);

  return rows.map((r) => ({
    produtoId: r.product_id,
    produto: nomeBaseComum(r.nomes_variacoes),
    categoria: r.category,
    unidadesVendidas: Number(r.unidades_vendidas),
    receita: Number(r.receita),
    imagemUrl: imagens[r.product_id] || null,
    variacoes: Number(r.variacoes),
    estoqueDisponivel: Number(r.estoque_disponivel),
    estoqueIlimitado: Boolean(r.estoque_ilimitado),
  }));
}

/**
 * Detalhamento por tamanho/variação de um produto do card "Top produtos mais vendidos" —
 * usado quando o usuário clica num produto com mais de uma variação pra ver quanto vendeu de
 * cada tamanho. Uma linha por SKU (mesmo product_id), com o nome completo daquele SKU (que
 * inclui o tamanho, ex. "Blusa Manga 7/8 - Preto G - PRETO") — sem tentar extrair só a sigla
 * do tamanho pra não arriscar um parsing errado, já que o formato do nome varia entre
 * produtos com cor no nome e produtos "tamanho único". Respeita os mesmos filtros de
 * período/status do card principal. `estoqueDisponivel` vem de um LEFT JOIN direto com
 * `inventory` por SKU (chave primária da tabela, então é um casamento 1:1 — não multiplica
 * as linhas de order_items como aconteceria juntando por product_id, que tem vários SKUs).
 */
async function produtoDetalhePorTamanho({ productId, dateFrom, dateTo, statuses } = {}) {
  if (!productId) return [];
  const params = [String(productId), dateFrom || null, dateTo || null];
  const statusIdx = pushStatusParam(statuses, params);
  const { rows } = await pool.query(
    `SELECT oi.sku, oi.product_name,
            SUM(oi.quantity) AS unidades_vendidas,
            SUM(oi.total_price) AS receita,
            COALESCE(MAX(inv.available_quantity), 0) AS estoque_disponivel,
            COALESCE(BOOL_OR(inv.has_unlimited_quantity), false) AS estoque_ilimitado
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN inventory inv ON inv.sku = oi.sku
     WHERE oi.product_id = $1
       AND ($2::timestamptz IS NULL OR o.creation_date >= $2)
       AND ($3::timestamptz IS NULL OR o.creation_date < $3)
       AND ${statusClause("o.status", statusIdx)}
     GROUP BY oi.sku, oi.product_name
     ORDER BY unidades_vendidas DESC`,
    params
  );
  return rows.map((r) => ({
    sku: r.sku,
    nome: r.product_name,
    unidadesVendidas: Number(r.unidades_vendidas),
    receita: Number(r.receita),
    estoqueDisponivel: Number(r.estoque_disponivel),
    estoqueIlimitado: Boolean(r.estoque_ilimitado),
  }));
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
  projecaoFechamentoDia,
  curvaAbcProdutos,
  meiosDePagamento,
  eficienciaFretePorRegiao,
  receitaPorRegiao,
  rankingProdutosXEstoque,
  produtosMaisVendidos,
  produtoDetalhePorTamanho,
};
