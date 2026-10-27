require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const vendas = require("./metrics/vendas");
const logistica = require("./metrics/logistica");
const marketing = require("./metrics/marketing");
const overview = require("./metrics/overview");
const { syncOrders, syncInventory, syncWarehouses, backfillCategories, backfillOrderFields } = require("./sync/syncVtex");
const { runJobInBackground, getAllJobStatuses, reconcileStaleJobsOnBoot } = require("./sync/jobRunner");
const { pool } = require("./db");
const bcrypt = require("bcryptjs");
const {
  requireAuth,
  requireAdmin,
  signToken,
  findUserByEmail,
  createUser,
  listUsers,
  deleteUser,
  updateUserAccess,
  loadAccess,
  requireModule,
} = require("./auth");
const auth = require("./auth");
const cd = require("./cd/cd");

const app = express();
const seguranca = require("./seguranca");
app.set("trust proxy", 1); // atrás do proxy do Railway: req.ip passa a ser o IP real do visitante
app.disable("x-powered-by");
app.use(seguranca.cabecalhos);
app.use(seguranca.corsMiddleware()); // CORS_ORIGINS restringe os sites que podem chamar a API (ver seguranca.js)
// o envio das NFs de saída (arquivo em base64) tem limite maior e tem o próprio parser na rota
app.use("/api/chamados", express.json({ limit: "10mb" })); // anexos em base64
const jsonPadrao = express.json();
app.use((req, res, next) => (/^\/api\/cd\/transito\/(nfs|simular\/lote|transportadoras\/\d+\/(tabela|prazos))$/.test(req.path) && (req.method === "POST" || req.method === "PUT") ? next() : jsonPadrao(req, res, next)));

function parseDateRange(req) {
  const { dateFrom, dateTo } = req.query;
  return {
    dateFrom: dateFrom ? new Date(dateFrom) : null,
    dateTo: dateTo ? new Date(dateTo) : null,
  };
}

// Filtro de status da aba Vendas (ex.: ?status=invoiced,handling). Sem o parâmetro
// (undefined) cada função de vendas.js cai no comportamento histórico do painel: tudo
// exceto cancelado — ver pushStatusParam/statusClause em vendas.js.
function parseStatusFilter(req) {
  const raw = req.query.status;
  if (!raw) return undefined;
  const list = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function parseGa4DateRanges(req) {
  const { startDate, endDate } = req.query;
  if (!startDate && !endDate) return undefined; // usa default (últimos 30 dias) do connector
  return [{ startDate: startDate || "30daysAgo", endDate: endDate || "today" }];
}

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      res.json(result);
    } catch (err) {
      const details = err.response?.data || err.message;
      const status = err.status || 500;
      if (status >= 500) console.error("[api]", JSON.stringify(details));
      res.status(status).json({ error: err.message, details, ...(err.extra || {}) });
    }
  };
}

const PROCESS_STARTED_AT = new Date().toISOString();
app.get("/health", (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  processStartedAt: PROCESS_STARTED_AT,
  uptimeSeconds: Math.round(process.uptime()),
}));

// ---- DIAGNÓSTICO TEMPORÁRIO: investigar por que nenhum item está sendo classificado
// como Liquidação. Mostra os campos de preço brutos que a Vtex manda pra alguns
// pedidos recentes (reaproveita o JSON já salvo em orders.raw, não busca de novo na
// Vtex). Só admin autenticado consegue chamar. Remover depois de confirmar o campo
// certo pra usar como "preço de tabela".
app.get("/api/debug/sample-item-pricing", requireAuth, requireAdmin, handle(async () => {
  const { rows } = await pool.query(
    "SELECT order_id, raw FROM orders WHERE raw IS NOT NULL ORDER BY creation_date DESC LIMIT 5"
  );
  return rows.map((r) => {
    const raw = typeof r.raw === "string" ? JSON.parse(r.raw) : r.raw;
    const items = (raw.items || []).map((it) => ({
      name: it.name,
      quantity: it.quantity,
      price: it.price,
      listPrice: it.listPrice,
      sellingPrice: it.sellingPrice,
      manualPrice: it.manualPrice,
      priceTags: it.priceTags,
    }));
    return { order_id: r.order_id, items };
  });
}));

// ---- DIAGNÓSTICO TEMPORÁRIO: descobrir qual campo da Vtex identifica o canal de venda
// (App x Site x Vitrine/venda assistida), pra construir a métrica "Canal de venda" sem
// chutar o campo errado (mesmo cuidado do diagnóstico de preço acima). Mostra marketingData,
// origin, callCenterOperatorData, openTextField e salesChannel de alguns pedidos recentes,
// reaproveitando o JSON já salvo em orders.raw — não busca de novo na Vtex. Só admin
// autenticado consegue chamar. Remover depois de confirmar o campo certo.
app.get("/api/debug/sample-order-channel", requireAuth, requireAdmin, handle(async () => {
  const { rows } = await pool.query(
    "SELECT order_id, raw FROM orders WHERE raw IS NOT NULL ORDER BY creation_date DESC LIMIT 8"
  );
  return rows.map((r) => {
    const raw = typeof r.raw === "string" ? JSON.parse(r.raw) : r.raw;
    return {
      order_id: r.order_id,
      salesChannel: raw.salesChannel,
      origin: raw.origin,
      marketingData: raw.marketingData,
      callCenterOperatorData: raw.callCenterOperatorData,
      openTextField: raw.openTextField,
      hostname: raw.hostname,
    };
  });
}));

// ---- DIAGNÓSTICO TEMPORÁRIO: confirmar (a) o formato da resposta da Vtex pra foto de SKU
// (endpoint /api/catalog/pvt/stockkeepingunit/{skuId}/file — ver getSkuMainImageUrl em
// connectors/vtex.js) e (b) quais campos do SKU indicam "mesma referência, tamanho
// diferente" (RefId/ProductRefId/nomes). Chama a Vtex de verdade e devolve a resposta crua
// pra conferência manual. Só admin autenticado consegue chamar.
//
// Dois modos:
//  - ?productId=X (+ opcionalmente dateFrom/dateTo/status, iguais ao filtro do painel):
//    investiga UM produto específico — todas as variações (SKUs) dele, não só a
//    representativa, e marca qual delas é a "representativa" NESSE filtro (a escolhida pra
//    buscar a foto é sempre a mais vendida dentro do período/status selecionado no painel,
//    então pode mudar produto a produto e filtro a filtro). Usado quando um produto
//    específico aparece sem foto no card, tipo "Calça Pantalona Detalhe Vivos".
//  - sem productId: amostra geral do Top 15 (mesmo agrupamento de produtosMaisVendidos),
//    respeitando dateFrom/dateTo/status recebidos (o botão do painel manda os mesmos filtros
//    ativos na aba Vendas).
app.get("/api/debug/sample-product-image", requireAuth, requireAdmin, handle(async (req) => {
  const vtexConn = require("./connectors/vtex");
  const { dateFrom, dateTo } = parseDateRange(req);
  const statuses = parseStatusFilter(req);
  const statusParam = Array.isArray(statuses) && statuses.length ? statuses : null;
  const productId = req.query.productId ? String(req.query.productId).trim() : null;

  if (productId) {
    const statusSqlProduto = `(($4::text[] IS NULL AND o.status NOT IN ('canceled','cancelled')) OR ($4::text[] IS NOT NULL AND o.status = ANY($4::text[])))`;
    const { rows } = await pool.query(
      `SELECT oi.sku, oi.product_name, SUM(oi.quantity) AS unidades_vendidas
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       WHERE oi.product_id = $1
         AND ($2::timestamptz IS NULL OR o.creation_date >= $2)
         AND ($3::timestamptz IS NULL OR o.creation_date < $3)
         AND ${statusSqlProduto}
       GROUP BY oi.sku, oi.product_name
       ORDER BY unidades_vendidas DESC`,
      [productId, dateFrom || null, dateTo || null, statusParam]
    );
    if (!rows.length) {
      return { productId, aviso: "Nenhuma venda desse produto no período/status informado — confira se o productId está certo e se o filtro do painel não está deixando esse produto de fora." };
    }
    const skuRepresentativoAtual = rows[0].sku;
    return Promise.all(
      rows.map(async (r) => {
        const resultado = {
          sku: r.sku,
          nome: r.product_name,
          unidadesVendidas: Number(r.unidades_vendidas),
          ehRepresentativoNesseFiltro: r.sku === skuRepresentativoAtual,
        };
        try {
          resultado.arquivos = await vtexConn.getSkuFiles(r.sku);
        } catch (err) {
          resultado.erroArquivos = err.message;
        }
        return resultado;
      })
    );
  }

  const statusSqlTop15 = `(($3::text[] IS NULL AND o.status NOT IN ('canceled','cancelled')) OR ($3::text[] IS NOT NULL AND o.status = ANY($3::text[])))`;
  const { rows } = await pool.query(
    `SELECT oi.product_id,
            (array_agg(oi.product_name ORDER BY oi.quantity DESC, oi.id ASC))[1] AS product_name,
            SUM(oi.quantity) AS unidades_vendidas,
            (array_agg(oi.sku ORDER BY oi.quantity DESC, oi.id ASC))[1] AS sku_representativo
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND ${statusSqlTop15}
     GROUP BY oi.product_id
     ORDER BY unidades_vendidas DESC
     LIMIT 15`,
    [dateFrom || null, dateTo || null, statusParam]
  );
  return Promise.all(
    rows.map(async (r) => {
      const resultado = {
        productId: r.product_id,
        produto: r.product_name,
        unidadesVendidas: Number(r.unidades_vendidas),
        skuRepresentativo: r.sku_representativo,
      };
      try {
        resultado.arquivos = await vtexConn.getSkuFiles(r.sku_representativo);
      } catch (err) {
        resultado.erroArquivos = err.message;
      }
      try {
        const d = await vtexConn.getSkuDetail(r.sku_representativo);
        resultado.detalheSku = {
          RefId: d.RefId,
          ProductRefId: d.ProductRefId,
          ProductId: d.ProductId,
          ProductName: d.ProductName,
          NameComplete: d.NameComplete,
          SkuName: d.SkuName,
          IsActive: d.IsActive,
        };
      } catch (err) {
        resultado.erroDetalheSku = err.message;
      }
      return resultado;
    })
  );
}));

// ---- DIAGNÓSTICO TEMPORÁRIO: descobrir por que um produto que TEM estoque de verdade
// aparece com "0" no painel (coluna Estoque do card "Top produtos mais vendidos"). O valor
// exibido vem só da tabela `inventory`, que é preenchida pelo job `syncInventory` listando
// SKUs ATIVOS no catálogo (/api/catalog_system/pvt/sku/stockkeepingunitids) — então um SKU
// que nunca aparece nessa listagem (por qualquer motivo: IsActive=false, alguma paginação
// que não cobriu ele, etc.) nunca ganha linha em `inventory` e cai no COALESCE(...,0) do
// card. Esse diagnóstico busca AO VIVO na Vtex (sem depender do cache) pra cada SKU do
// produto: (a) o que está cacheado agora em `inventory`, (b) a resposta crua do endpoint de
// estoque da Vtex (/api/logistics/pvt/inventory/skus/{id} — mostra hasUnlimitedQuantity,
// totalQuantity, reservedQuantity por depósito, útil pra pegar o caso de "estoque
// ilimitado" que zera o totalQuantity) e (c) IsActive/IsAvailable do catálogo (mostra se o
// SKU está marcado inativo, o que o tiraria da sincronização mesmo tendo estoque físico).
// Aceita productId OU productName (busca parcial, case-insensitive, nos pedidos já
// sincronizados) — útil quando só se sabe o nome exibido no painel. Só admin autenticado.
app.get("/api/debug/sample-product-stock", requireAuth, requireAdmin, handle(async (req) => {
  const vtexConn = require("./connectors/vtex");
  const productIdParam = req.query.productId ? String(req.query.productId).trim() : null;
  const productNameParam = req.query.productName ? String(req.query.productName).trim() : null;

  if (!productIdParam && !productNameParam) {
    return { aviso: "Informe productId ou productName." };
  }

  let productId = productIdParam;

  if (!productId) {
    const { rows: candidatos } = await pool.query(
      `SELECT DISTINCT product_id, (array_agg(product_name))[1] AS product_name
       FROM order_items
       WHERE product_name ILIKE '%' || $1 || '%'
       GROUP BY product_id
       LIMIT 10`,
      [productNameParam]
    );
    if (!candidatos.length) {
      return { aviso: "Nenhum produto encontrado com esse nome nos pedidos sincronizados.", productNameBuscado: productNameParam };
    }
    if (candidatos.length > 1) {
      return {
        aviso: "Mais de um produto bateu com esse nome — chame de novo passando productId com um dos IDs abaixo.",
        candidatos: candidatos.map((c) => ({ productId: c.product_id, produto: c.product_name })),
      };
    }
    productId = candidatos[0].product_id;
  }

  const { rows: skuRows } = await pool.query(
    `SELECT DISTINCT oi.sku, oi.product_name
     FROM order_items oi
     WHERE oi.product_id = $1
     ORDER BY oi.sku`,
    [productId]
  );
  if (!skuRows.length) {
    return { aviso: "Nenhum SKU encontrado pra esse productId nos pedidos sincronizados.", productId };
  }

  const { rows: cacheRows } = await pool.query(
    `SELECT sku, available_quantity, has_unlimited_quantity, date_first_available, synced_at, raw->>'IsActive' AS is_active_cache
     FROM inventory WHERE sku = ANY($1::text[])`,
    [skuRows.map((r) => r.sku)]
  );
  const cacheBySku = {};
  cacheRows.forEach((r) => { cacheBySku[r.sku] = r; });

  return Promise.all(
    skuRows.map(async (r) => {
      const resultado = {
        sku: r.sku,
        nome: r.product_name,
        cacheInventoryTable: cacheBySku[r.sku]
          ? {
              availableQuantity: Number(cacheBySku[r.sku].available_quantity),
              hasUnlimitedQuantity: cacheBySku[r.sku].has_unlimited_quantity,
              dateFirstAvailable: cacheBySku[r.sku].date_first_available,
              syncedAt: cacheBySku[r.sku].synced_at,
              isActiveNoUltimoSync: cacheBySku[r.sku].is_active_cache,
            }
          : "SEM CACHE — esse SKU nunca apareceu em /api/catalog_system/pvt/sku/stockkeepingunitids (a listagem que o syncInventory usa pra saber quais SKUs buscar), então nunca foi gravado em `inventory` e por isso o painel mostra 0.",
      };
      try {
        const inv = await vtexConn.getSkuInventory(r.sku);
        resultado.estoqueAoVivoNaVtex = inv;
      } catch (err) {
        resultado.erroEstoqueAoVivo = err.message;
      }
      try {
        const d = await vtexConn.getSkuDetail(r.sku);
        resultado.detalheSkuAoVivo = { IsActive: d.IsActive, IsAvailable: d.IsAvailable, RefId: d.RefId, SkuName: d.SkuName };
      } catch (err) {
        resultado.erroDetalheAoVivo = err.message;
      }
      return resultado;
    })
  );
}));

// ---- Autenticação ----
app.post("/api/auth/login", handle(async (req, res) => {
  try {
    const { email, password } = req.body || {};
    return await auth.fazerLogin(email, password, req.ip);
  } catch (err) { if (err.retryAfter) res.set("Retry-After", String(err.retryAfter)); throw err; }
}));
// O próprio usuário troca a senha (também usada na troca obrigatória do primeiro acesso).
app.post("/api/auth/trocar-senha", requireAuth, handle((req) => auth.trocarSenha(req.user.sub, (req.body || {}).atual, (req.body || {}).nova, req.ip)));

// Perfil sempre lido do banco: se o admin trocar o acesso de alguém, vale na próxima abertura de tela.
app.get("/api/auth/me", requireAuth, handle(async (req) => {
  const user = await loadAccess(req.user.sub);
  if (!user) { const err = new Error("Usuário não encontrado."); err.status = 401; throw err; }
  if ((req.user.tv || 0) !== user.token_version) { const err = new Error("Sessão encerrada. Entre novamente."); err.status = 401; throw err; }
  delete user.token_version;
  return { user };
}));

app.get("/api/auth/users", requireAuth, requireAdmin, handle(async () => ({ users: await listUsers() })));

app.post("/api/auth/users", requireAuth, requireAdmin, handle(async (req) => {
  const { email, password, role, nome, modules, cd_perfis } = req.body || {};
  if (!email || !password) {
    const err = new Error("Informe email e senha.");
    err.status = 400;
    throw err;
  }
  const existing = await findUserByEmail(email);
  if (existing) {
    const err = new Error("Já existe um usuário com esse email.");
    err.status = 409;
    throw err;
  }
  const user = await createUser({ email, password, role, nome, modules, cd_perfis });
  return { user };
}));

app.put("/api/auth/users/:id/acesso", requireAuth, requireAdmin, handle(async (req) => {
  const { role, nome, modules, cd_perfis } = req.body || {};
  if (String(req.user.sub) === String(req.params.id) && role !== "admin") {
    const err = new Error("Você não pode tirar o próprio acesso de administrador.");
    err.status = 400;
    throw err;
  }
  const user = await updateUserAccess(req.params.id, { role, nome, modules, cd_perfis });
  if (!user) { const err = new Error("Usuário não encontrado."); err.status = 404; throw err; }
  return { user };
}));

app.delete("/api/auth/users/:id", requireAuth, requireAdmin, handle(async (req) => {
  if (String(req.user.sub) === String(req.params.id)) {
    const err = new Error("Você não pode remover o próprio acesso.");
    err.status = 400;
    throw err;
  }
  await deleteUser(req.params.id);
  return { ok: true };
}));

// ---- Vendas ----
// Painel de vendas: só quem tem o módulo "vendas" (usuários antigos já nascem com ele).
app.use(["/api/vendas", "/api/logistica", "/api/marketing", "/api/overview"], requireAuth, requireModule("vendas"));

app.get("/api/vendas/receita-vs-meta", requireAuth, handle((req) => vendas.receitaVsMeta({ month: req.query.month, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo, statuses: parseStatusFilter(req) })));
app.post("/api/vendas/meta", requireAuth, handle(async (req) => {
  await vendas.setRevenueGoal({ month: new Date(req.body.month), goalValue: Number(req.body.goalValue) });
  return { ok: true };
}));
app.get("/api/vendas/por-categoria", requireAuth, handle((req) => vendas.vendaPorCategoria({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/por-tipo", requireAuth, handle((req) => vendas.vendaPorTipo({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/venda-diaria", requireAuth, handle((req) => vendas.vendaDiaria({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/novos-recorrentes", requireAuth, handle((req) => vendas.novosRecorrentes({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/cupons", requireAuth, handle((req) => vendas.usoCupons({ ...parseDateRange(req), limit: req.query.limit ? Number(req.query.limit) : undefined, statuses: parseStatusFilter(req) })));
app.get("/api/vendas/comparativo-cupom", requireAuth, handle((req) => vendas.comparativoCupom({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/sazonalidade", requireAuth, handle((req) => vendas.sazonalidade({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
// Sem parseDateRange: a projeção sempre olha pra "hoje" e pra trás numa janela fixa (ver
// PROJECAO_LOOKBACK_DIAS em vendas.js), não pro período selecionado no topo do painel.
app.get("/api/vendas/projecao-fechamento-dia", requireAuth, handle((req) => vendas.projecaoFechamentoDia({ statuses: parseStatusFilter(req) })));
app.get("/api/vendas/curva-abc", requireAuth, handle((req) => vendas.curvaAbcProdutos({
  ...parseDateRange(req),
  categoria: req.query.categoria,
  metric: req.query.metric,
  classes: req.query.classes ? String(req.query.classes).split(",").map((c) => c.trim()).filter(Boolean) : undefined,
  statuses: parseStatusFilter(req),
})));
app.get("/api/vendas/categorias", requireAuth, handle(async () => {
  const { rows } = await pool.query(
    "SELECT DISTINCT category FROM order_items WHERE category IS NOT NULL ORDER BY category"
  );
  return { categorias: rows.map((r) => r.category) };
}));
app.get("/api/vendas/meios-pagamento", requireAuth, handle((req) => vendas.meiosDePagamento({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/eficiencia-frete-regiao", requireAuth, handle((req) => vendas.eficienciaFretePorRegiao({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/receita-por-regiao", requireAuth, handle((req) => vendas.receitaPorRegiao({ ...parseDateRange(req), statuses: parseStatusFilter(req) })));
app.get("/api/vendas/ranking-produtos-estoque", requireAuth, handle((req) => vendas.rankingProdutosXEstoque({ ...parseDateRange(req), limit: req.query.limit ? Number(req.query.limit) : undefined, statuses: parseStatusFilter(req) })));
app.get("/api/vendas/produtos-mais-vendidos", requireAuth, handle((req) => vendas.produtosMaisVendidos({ ...parseDateRange(req), limit: req.query.limit ? Number(req.query.limit) : undefined, statuses: parseStatusFilter(req) })));
app.get("/api/vendas/produtos-mais-vendidos/:productId/tamanhos", requireAuth, handle((req) => vendas.produtoDetalhePorTamanho({ productId: req.params.productId, ...parseDateRange(req), statuses: parseStatusFilter(req) })));

// ---- Logística ----
app.get("/api/logistica/sla-entrega", requireAuth, handle((req) => logistica.slaDeEntrega(parseDateRange(req))));
app.get("/api/logistica/eficiencia-frete-regiao", requireAuth, handle((req) => logistica.eficienciaFretePorRegiao(parseDateRange(req))));
app.get("/api/logistica/lojas", requireAuth, handle((req) => logistica.desempenhoLojas(parseDateRange(req))));
app.get("/api/logistica/lojas-regiao", requireAuth, handle((req) => logistica.lojaPorEstadoDestino(parseDateRange(req))));
// Correção manual do estado (UF) de cada loja/depósito OMNI — a Vtex não retorna
// endereço pros warehouses dessa conta, então esse é o jeito de informar de qual
// estado cada loja realmente despacha (ver nota em syncVtex.js extractWarehouseFields).
app.get("/api/logistica/lojas-estados", requireAuth, handle(() => logistica.listLojaEstados()));
app.post("/api/logistica/lojas-estados", requireAuth, requireAdmin, handle(async (req) => {
  const { warehouseId, state } = req.body || {};
  return logistica.setLojaEstado(warehouseId, state);
}));

// ---- Marketing ----
app.get("/api/marketing/sessoes-categoria-produto", requireAuth, handle((req) => marketing.sessoesPorCategoriaEProduto({ dateRanges: parseGa4DateRanges(req) })));
app.get("/api/marketing/ticket-medio", requireAuth, handle((req) => marketing.ticketMedio(parseDateRange(req))));
app.get("/api/marketing/conversao-origem", requireAuth, handle((req) => marketing.conversaoPorOrigem({ dateRanges: parseGa4DateRanges(req) })));
app.get("/api/marketing/receita-categoria-produto", requireAuth, handle((req) => marketing.receitaPorCategoriaEProduto(parseDateRange(req))));
app.get("/api/marketing/receita-pagamento-regiao", requireAuth, handle((req) => marketing.receitaPorPagamentoERegiao(parseDateRange(req))));

// ---- Overview ----
app.get("/api/overview/receita-dispositivo", requireAuth, handle((req) => overview.receitaPorDispositivo({ dateRanges: parseGa4DateRanges(req), source: req.query.source })));
app.get("/api/overview/taxa-rejeicao", requireAuth, handle((req) => overview.taxaDeRejeicao({ dateRanges: parseGa4DateRanges(req), source: req.query.source })));
app.get("/api/overview/taxa-conversao", requireAuth, handle((req) => overview.taxaDeConversao({ dateRanges: parseGa4DateRanges(req), source: req.query.source })));
app.get("/api/overview/tracking-pedido", requireAuth, handle((req) => overview.trackingDePedido(parseDateRange(req))));
app.get("/api/overview/itens-por-pedido", requireAuth, handle((req) => overview.itensPorPedido(parseDateRange(req))));
app.get("/api/overview/ltv-categoria", requireAuth, handle((req) => overview.ltvPorCategoria(parseDateRange(req))));

// ---- Sync manual (útil para forçar atualização ou popular pela primeira vez) ----
// Aceita GET também (além de POST) para poder disparar direto pelo navegador.
// Restrito ao admin: dispara chamadas pesadas na Vtex e reescreve dados sincronizados.
//
// IMPORTANTE: todas essas rotas disparam o trabalho pesado em segundo plano
// (runJobInBackground) e respondem na hora, em vez de esperar o job inteiro
// terminar. Isso evita "Failed to fetch" no navegador quando a sincronização
// demora mais que o timeout do proxy/Railway (catálogo grande, período histórico
// longo etc.) — o job continua rodando no servidor mesmo depois da resposta ter
// sido enviada. O frontend consulta /api/sync/status pra saber quando terminou.
app.post("/api/sync/orders", requireAuth, requireAdmin, handle(async (req) => {
  const { daysBack, dateFrom, dateTo } = req.body || {};
  return runJobInBackground("orders", () => syncOrders({ daysBack, dateFrom, dateTo }));
}));
app.get("/api/sync/orders", requireAuth, requireAdmin, handle(async (req) => {
  return runJobInBackground("orders", () => syncOrders({
    daysBack: req.query?.daysBack ? Number(req.query.daysBack) : undefined,
    dateFrom: req.query?.dateFrom,
    dateTo: req.query?.dateTo,
  }));
}));
app.post("/api/sync/inventory", requireAuth, requireAdmin, handle(async () => {
  return runJobInBackground("inventory", () => syncInventory());
}));
app.get("/api/sync/inventory", requireAuth, requireAdmin, handle(async () => {
  return runJobInBackground("inventory", () => syncInventory());
}));
// Sincroniza só a lista de lojas/depósitos (warehouses) — já roda sozinho junto com o
// estoque a cada 6h, mas dá pra disparar na hora sem esperar o próximo ciclo.
app.post("/api/sync/warehouses", requireAuth, requireAdmin, handle(async () => {
  return runJobInBackground("warehouses", () => syncWarehouses());
}));
app.get("/api/sync/warehouses", requireAuth, requireAdmin, handle(async () => {
  return runJobInBackground("warehouses", () => syncWarehouses());
}));
// Backfill único: recalcula os nomes de categoria e a loja/depósito (warehouse_id) dos
// itens de todos os pedidos já sincronizados (corrige o bug em que a categoria ficava
// salva como ID numérico da Vtex, e também popula warehouse_id em pedidos sincronizados
// antes dessa coluna existir — rode depois de sincronizar as lojas pelo menos uma vez).
app.get("/api/sync/backfill-categories", requireAuth, requireAdmin, handle(async () => {
  return runJobInBackground("backfill-categories", () => backfillCategories());
}));
// Backfill único: recalcula delivered_at / dias de frete real e prometido de todos os
// pedidos já sincronizados (corrige o bug em que a entrega não era detectada).
app.get("/api/sync/backfill-order-fields", requireAuth, requireAdmin, handle(async () => {
  return runJobInBackground("backfill-order-fields", () => backfillOrderFields());
}));
// Consultado pelo frontend depois de disparar um sync/backfill, pra saber quando o job
// que ficou rodando em segundo plano terminou (e se deu certo ou não).
// ---- Módulo Recebimento / CD ----
const cdAuth = [requireAuth, requireModule("cd")];
const nid = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) { const e = new Error("Endereço não reconhecido pelo servidor (\"" + String(req.params.id).slice(0, 40) + "\"). Provavelmente o servidor está com uma versão antiga: publique src/server.js e src/cd/transito.js."); e.status = 404; throw e; }
  return n;
};
app.get("/api/cd/config", cdAuth, handle(() => cd.configPublica()));
app.put("/api/cd/config/etapas", cdAuth, requireAdmin, handle((req) => cd.salvarConfigEtapas((req.body || {}).etapas)));
app.get("/api/cd/usuarios", cdAuth, handle(async () => {
  const { rows } = await pool.query("SELECT email, nome FROM users WHERE role = 'admin' OR 'cd' = ANY(modules)");
  const usuarios = {};
  for (const r of rows) usuarios[r.email] = r.nome || r.email.split("@")[0];
  return { usuarios };
}));
app.get("/api/cd/painel", cdAuth, handle((req) => cd.painel(req.access)));
app.get("/api/cd/gargalos", cdAuth, handle((req) => cd.gargalos(req.access, { dias: req.query.dias })));
app.get("/api/cd/cores", cdAuth, handle(() => cd.listarCores()));
app.post("/api/cd/cores", cdAuth, handle((req) => cd.criarCor(req.access, req.body || {})));
app.get("/api/cd/fornecedores", cdAuth, handle((req) => cd.fornecedores(req.access, { dias: req.query.dias })));
app.get("/api/cd/notas", cdAuth, handle((req) => cd.listarNotas(req.access, { status: req.query.status, q: req.query.q, limit: req.query.limit })));
app.post("/api/cd/notas", cdAuth, handle((req) => cd.criarNota(req.access, req.body || {})));
app.get("/api/cd/notas/:id", cdAuth, handle((req) => cd.detalheNota(req.access, nid(req))));
app.post("/api/cd/notas/:id/etapas/:n/iniciar", cdAuth, handle((req) => cd.iniciarEtapa(req.access, nid(req), Number(req.params.n))));
app.put("/api/cd/notas/:id/etapas/:n/itens", cdAuth, handle((req) => cd.salvarItens(req.access, nid(req), Number(req.params.n), req.body || {})));
app.post("/api/cd/notas/:id/etapas/:n/conferir", cdAuth, handle((req) => cd.conferirEtapa(req.access, nid(req), Number(req.params.n), (req.body || {}).dados || {})));
app.post("/api/cd/notas/:id/etapas/:n/concluir", cdAuth, handle((req) => cd.concluirEtapa(req.access, nid(req), Number(req.params.n), (req.body || {}).dados || {})));
app.post("/api/cd/notas/:id/recontagens", cdAuth, handle((req) => cd.registrarRecontagem(req.access, nid(req), req.body || {})));
app.post("/api/cd/notas/:id/etiquetas", cdAuth, handle((req) => cd.registrarLoteEtiquetas(req.access, nid(req), req.body || {})));
app.delete("/api/cd/notas/:id/etiquetas/:lid", cdAuth, handle((req) => cd.removerLoteEtiquetas(req.access, nid(req), Number(req.params.lid))));
app.put("/api/cd/notas/:id/ranking", cdAuth, handle((req) => cd.definirRanking(req.access, nid(req), (req.body || {}).ranking)));
// ---- Faturamento e trânsito (aba própria: NFs de saída, tabelas das transportadoras, coleta, entrega) ----
const trn = require("./cd/transito");
const T = "/api/cd/transito";
// diagnóstico: abra /api/cd/versao no navegador para ver se o servidor está com a versão nova do módulo (sem dados sensíveis)
app.get("/api/cd/versao", (req, res) => res.json({ transito: trn.VERSAO || "antiga", recursos: { relatorio: typeof trn.relatorio === "function", modal: typeof trn.normModal === "function", pagamentos: typeof trn.fluxoPagamento === "function", prazos: typeof trn.listarPrazos === "function", lote: typeof trn.simularLote === "function", entrada: typeof ent !== "undefined" && typeof ent.quadro === "function" }, servidor_iniciado_em: PROCESS_STARTED_AT }));
const grande = express.json({ limit: "16mb" }); // até 10 MB de arquivo (o base64 aumenta ~33%)
const grandeTabela = express.json({ limit: "25mb" });
app.get(T + "/quadro", cdAuth, handle((req) => trn.quadro(req.access, { dias: req.query.dias, transportadora_id: req.query.transportadora_id, uf: req.query.uf, modal: req.query.modal })));
app.get(T + "/resumo", cdAuth, handle((req) => trn.resumo(req.access)));
app.get(T + "/pagamentos", cdAuth, handle((req) => trn.fluxoPagamento(req.access, { dias: req.query.dias })));
app.get(T + "/nfs", cdAuth, handle((req) => trn.listarNfs(req.access, req.query)));
app.post(T + "/nfs", cdAuth, grande, handle((req) => trn.enviarNf(req.access, req.body || {})));
app.post(T + "/nfs/excluir", cdAuth, handle((req) => trn.excluirNfs(req.access, req.body || {})));
app.get(T + "/nfs/relatorio", cdAuth, handle((req) => trn.relatorio(req.access, req.query)));
app.get(T + "/nfs/lidas", cdAuth, handle((req) => trn.transportadorasLidas(req.access)));
app.post(T + "/nfs/vincular-lidas", cdAuth, handle((req) => trn.vincularLidas(req.access, req.body || {})));
app.post(T + "/nfs/transportadora", cdAuth, handle((req) => trn.definirTransportadora(req.access, req.body || {})));
app.post(T + "/nfs/coleta", cdAuth, handle((req) => trn.marcarColeta(req.access, req.body || {})));
app.post(T + "/nfs/entrega", cdAuth, handle((req) => trn.marcarEntregue(req.access, req.body || {})));
app.get(T + "/nfs/:id", cdAuth, handle((req) => trn.detalheNf(req.access, nid(req))));
app.put(T + "/nfs/:id", cdAuth, handle((req) => trn.editarNf(req.access, nid(req), req.body || {})));
app.post(T + "/nfs/:id/voltar", cdAuth, handle((req) => trn.voltarStatus(req.access, nid(req), req.body || {})));
app.delete(T + "/nfs/:id", cdAuth, handle((req) => trn.excluirNfs(req.access, { ids: [nid(req)], motivo: (req.body || {}).motivo })));
app.get(T + "/nfs/:id/arquivo", cdAuth, async (req, res) => {
  try {
    const f = await trn.baixarArquivo(req.access, nid(req));
    res.set({ "Content-Type": f.tipo === "pdf" ? "application/pdf" : "application/xml", "Content-Disposition": `attachment; filename="${String(f.nome).replace(/[^\w.\- ]/g, "_")}"` });
    res.send(f.conteudo);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
// Em todo o módulo: guarda o IP no acesso (auditoria) e, enquanto a pessoa não trocar a senha provisória,
// só libera /eu (para a tela saber que precisa trocar). A troca em si é POST /api/auth/trocar-senha.
const exigeTrocaSenha = (req, res, next) => {
  req.access.ip = req.ip;
  if (req.access.trocar_senha && !/\/api\/(chamados|admissao)\/eu\/?$/.test(req.path)) return res.status(403).json({ error: "Troque a sua senha provisória para continuar.", codigo: "trocar_senha" });
  next();
};
const chamadosAuth = [requireAuth, requireModule("chamados"), exigeTrocaSenha];
// ---- Chamados das lojas para o DP ----
const chamados = require("./chamados/chamados");
const CH = "/api/chamados";
app.get(CH + "/eu", chamadosAuth, handle((req) => chamados.eu(req.access)));
app.get(CH + "/assuntos", chamadosAuth, handle((req) => chamados.listarAssuntos(req.access, { todos: req.query.todos === "1", departamento_id: req.query.departamento_id })));
app.post(CH + "/assuntos", chamadosAuth, handle((req) => chamados.salvarAssunto(req.access, null, req.body || {})));
app.put(CH + "/assuntos/:id", chamadosAuth, handle((req) => chamados.salvarAssunto(req.access, nid(req), req.body || {})));
app.get(CH + "/auditoria", chamadosAuth, handle((req) => chamados.listarAuditoria(req.access, req.query || {})));
app.get(CH + "/acessos", chamadosAuth, handle((req) => chamados.listarAcessos(req.access)));
app.post(CH + "/acessos", chamadosAuth, handle((req) => chamados.criarAcesso(req.access, req.body || {})));
app.post(CH + "/acessos/senha", chamadosAuth, handle((req) => chamados.redefinirSenhaAcesso(req.access, req.body || {})));
app.post(CH + "/acessos/bloquear", chamadosAuth, handle((req) => chamados.removerAcesso(req.access, req.body || {})));
app.get(CH + "/lojas", chamadosAuth, handle((req) => chamados.listarLojas(req.access)));
app.post(CH + "/lojas/importar-emails", chamadosAuth, handle((req) => chamados.importarEmailsLojas(req.access, req.body || {})));
app.post(CH + "/lojas", chamadosAuth, handle((req) => chamados.salvarLoja(req.access, null, req.body || {})));
app.put(CH + "/lojas/:id", chamadosAuth, handle((req) => chamados.salvarLoja(req.access, nid(req), req.body || {})));
app.get(CH + "/equipe", chamadosAuth, handle((req) => chamados.listarEquipe(req.access)));
app.post(CH + "/equipe", chamadosAuth, handle((req) => chamados.salvarEquipe(req.access, null, req.body || {})));
app.put(CH + "/equipe/:id", chamadosAuth, handle((req) => chamados.salvarEquipe(req.access, nid(req), req.body || {})));
app.get(CH + "/config", chamadosAuth, handle((req) => chamados.config(req.access)));
app.put(CH + "/config", chamadosAuth, handle((req) => chamados.salvarConfig(req.access, req.body || {})));
app.get(CH + "/indicadores", chamadosAuth, handle((req) => chamados.indicadores(req.access, req.query)));

// ---- Admissão e Rescisão (acompanhamento de etapas e SLA) ----
const admissao = require("./admissao/admissao");
const AD = "/api/admissao";
const admAuth = [requireAuth, requireModule("admissao"), exigeTrocaSenha];
app.get(AD + "/eu", admAuth, handle((req) => admissao.eu(req.access)));
app.get(AD + "/processos", admAuth, handle((req) => admissao.listar(req.access, req.query)));
app.post(AD + "/processos", admAuth, handle((req) => admissao.criar(req.access, req.body || {})));
app.get(AD + "/processos/:id", admAuth, handle((req) => admissao.detalhe(req.access, nid(req))));
app.put(AD + "/processos/:id", admAuth, handle((req) => admissao.editar(req.access, nid(req), req.body || {})));
app.post(AD + "/processos/:id/etapas/:eid/concluir", admAuth, handle((req) => admissao.concluirEtapa(req.access, nid(req), Number(req.params.eid), req.body || {})));
app.post(AD + "/processos/:id/etapas/:eid/dispensar", admAuth, handle((req) => admissao.dispensarEtapa(req.access, nid(req), Number(req.params.eid), req.body || {})));
app.post(AD + "/processos/:id/etapas/:eid/reprovar", admAuth, handle((req) => admissao.reprovarVaga(req.access, nid(req), Number(req.params.eid), req.body || {})));
app.post(AD + "/processos/:id/etapas/:eid/devolver", admAuth, handle((req) => admissao.devolverEtapa(req.access, nid(req), Number(req.params.eid), req.body || {})));
app.post(AD + "/processos/:id/etapas/:eid/tarefa", admAuth, handle((req) => admissao.marcarSubtarefa(req.access, nid(req), Number(req.params.eid), req.body || {})));
app.post(AD + "/processos/:id/encerrar", admAuth, handle((req) => admissao.encerrar(req.access, nid(req), req.body || {})));
app.get(AD + "/mensagens", admAuth, handle((req) => admissao.mensagens(req.access)));
app.put(AD + "/mensagens/:chave", admAuth, handle((req) => admissao.salvarMensagem(req.access, String(req.params.chave), req.body || {})));
app.post(AD + "/processos/:id/voltar-etapa", admAuth, handle((req) => admissao.reabrirEtapa(req.access, nid(req), req.body || {})));
app.post(AD + "/processos/:id/pausar", admAuth, handle((req) => admissao.pausar(req.access, nid(req), req.body || {})));
app.post(AD + "/processos/:id/retomar", admAuth, handle((req) => admissao.retomar(req.access, nid(req))));
app.post(AD + "/processos/:id/responsavel", admAuth, handle((req) => admissao.atribuir(req.access, nid(req), req.body || {})));
app.post(AD + "/processos/:id/notas", admAuth, handle((req) => admissao.nota(req.access, nid(req), req.body || {})));
app.post(AD + "/processos/:id/cancelar", admAuth, handle((req) => admissao.cancelar(req.access, nid(req), req.body || {})));
app.post(AD + "/processos/:id/excluir", admAuth, handle((req) => admissao.excluir(req.access, nid(req), req.body || {})));
app.put(AD + "/processos/:id/prazos", admAuth, handle((req) => admissao.ajustarPrazos(req.access, nid(req), req.body || {})));
app.get(AD + "/etapas-modelo", admAuth, handle((req) => admissao.listarEtapasModelo(req.access, req.query)));
app.post(AD + "/etapas-modelo", admAuth, handle((req) => admissao.salvarEtapaModelo(req.access, null, req.body || {})));
app.put(AD + "/etapas-modelo/:id", admAuth, handle((req) => admissao.salvarEtapaModelo(req.access, nid(req), req.body || {})));
app.put(AD + "/config", admAuth, handle((req) => admissao.salvarConfig(req.access, req.body || {})));
app.get(AD + "/equipe", admAuth, handle((req) => admissao.listarEquipe(req.access)));
app.post(AD + "/equipe", admAuth, handle((req) => admissao.criarEquipe(req.access, req.body || {})));
app.put(AD + "/equipe/:id", admAuth, handle((req) => admissao.editarEquipe(req.access, nid(req), req.body || {})));
app.post(AD + "/equipe/senha", admAuth, handle((req) => admissao.redefinirSenha(req.access, req.body || {})));
app.get(AD + "/indicadores", admAuth, handle((req) => admissao.indicadores(req.access, req.query)));
app.get(CH + "/emails/falhas", chamadosAuth, handle((req) => chamados.emailsFalhos(req.access)));
app.post(CH + "/emails/:id/reenviar", chamadosAuth, handle((req) => chamados.reenviarEmail(req.access, nid(req))));
app.get(CH + "/chamados", chamadosAuth, handle((req) => chamados.listar(req.access, req.query)));
app.post(CH + "/chamados", chamadosAuth, handle((req) => chamados.abrir(req.access, req.body || {})));
app.get(CH + "/chamados/:id", chamadosAuth, handle((req) => chamados.detalhe(req.access, nid(req))));
app.post(CH + "/chamados/:id/mensagens", chamadosAuth, handle((req) => chamados.responder(req.access, nid(req), req.body || {})));
app.post(CH + "/chamados/:id/assumir", chamadosAuth, handle((req) => chamados.assumir(req.access, nid(req), req.body || {})));
app.post(CH + "/chamados/:id/cancelar", chamadosAuth, handle((req) => chamados.cancelar(req.access, nid(req), req.body || {})));
app.post(CH + "/chamados/:id/excluir", chamadosAuth, handle((req) => chamados.excluir(req.access, nid(req), req.body || {})));
app.put(CH + "/chamados/:id/sla", chamadosAuth, handle((req) => chamados.editarSla(req.access, nid(req), req.body || {})));
app.get(CH + "/anexos/:id", chamadosAuth, async (req, res) => {
  try {
    const f = await chamados.baixarAnexo(req.access, nid(req));
    res.set({ "Content-Type": f.tipo || "application/octet-stream", "Content-Disposition": `attachment; filename="${String(f.nome).replace(/[^\w.\- ]/g, "_")}"`, "X-Content-Type-Options": "nosniff" });
    res.send(f.conteudo);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
// ---- Trânsito de entrada (fornecedor -> Zinzane), ligado ao recebimento na doca ----
const ent = require("./cd/entrada");
app.get(T + "/entrada/quadro", cdAuth, handle((req) => ent.quadro(req.access, { dias: req.query.dias, transportadora_id: req.query.transportadora_id, fornecedor: req.query.fornecedor })));
app.get(T + "/entrada/envios", cdAuth, handle((req) => ent.listarEnvios(req.access, req.query)));
app.post(T + "/entrada/envios", cdAuth, handle((req) => ent.criarEnvio(req.access, req.body || {})));
app.get("/api/cd/chave/:chave", cdAuth, handle((req) => ent.consultaChave(req.access, req.params.chave)));
app.get(T + "/entrada/opcoes", cdAuth, handle((req) => ent.opcoes(req.access)));
app.get(T + "/entrada/sem-envio", cdAuth, handle((req) => ent.semEnvio(req.access)));
app.post(T + "/entrada/envios/coleta", cdAuth, handle((req) => ent.marcarColeta(req.access, req.body || {})));
app.get(T + "/entrada/envios/:id", cdAuth, handle((req) => ent.detalheEnvio(req.access, nid(req))));
app.put(T + "/entrada/envios/:id", cdAuth, handle((req) => ent.editarEnvio(req.access, nid(req), req.body || {})));
app.post(T + "/entrada/envios/:id/voltar", cdAuth, handle((req) => ent.voltarStatus(req.access, nid(req))));
app.post(T + "/entrada/envios/:id/cancelar", cdAuth, handle((req) => ent.cancelarEnvio(req.access, nid(req), (req.body || {}).motivo)));
app.post(T + "/entrada/envios/:id/vincular", cdAuth, handle((req) => ent.vincularManual(req.access, nid(req), req.body || {})));
app.post(T + "/entrada/envios/:id/desvincular", cdAuth, handle((req) => ent.desvincular(req.access, nid(req))));
app.get(T + "/transportadoras", cdAuth, handle((req) => trn.listarTransportadoras(req.access)));
app.post(T + "/transportadoras", cdAuth, handle((req) => trn.salvarTransportadora(req.access, null, req.body || {})));
app.put(T + "/transportadoras/:id", cdAuth, handle((req) => trn.salvarTransportadora(req.access, nid(req), req.body || {})));
app.post(T + "/transportadoras/:id/tabela", cdAuth, grandeTabela, handle((req) => trn.importarTabela(req.access, nid(req), req.body || {})));
app.get(T + "/transportadoras/:id/tabela", cdAuth, handle((req) => trn.verTabela(req.access, nid(req), { uf: req.query.uf, modal: req.query.modal })));
app.delete(T + "/transportadoras/:id/tabela", cdAuth, handle((req) => trn.limparTabela(req.access, nid(req), { modal: req.query.modal })));
app.post(T + "/simular/lote", cdAuth, grande, handle((req) => trn.simularLote(req.access, req.body || {})));
app.get(T + "/transportadoras/:id/prazos", cdAuth, handle((req) => trn.listarPrazos(req.access, nid(req))));
app.put(T + "/transportadoras/:id/prazos", cdAuth, grandeTabela, handle((req) => trn.salvarPrazos(req.access, nid(req), req.body || {})));
app.post(T + "/simular", cdAuth, handle((req) => trn.simular(req.access, req.body || {})));
app.post("/api/cd/notas/:id/etapas/:n/reabrir", cdAuth, handle((req) => cd.reabrirEtapa(req.access, nid(req), Number(req.params.n), (req.body || {}).motivo)));
app.post("/api/cd/notas/:id/cancelar", cdAuth, handle((req) => cd.cancelarNota(req.access, nid(req), (req.body || {}).motivo)));
app.post("/api/cd/notas/:id/comentarios", cdAuth, handle((req) => cd.comentar(req.access, nid(req), (req.body || {}).texto, (req.body || {}).etapa)));

app.get("/api/sync/status", requireAuth, requireAdmin, handle(async () => ({ jobs: await getAllJobStatuses() })));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[server] rodando na porta ${PORT}`));

// Libera qualquer job que ficou marcado "running" de um processo anterior (deploy/restart no
// meio de uma sincronização) — sem isso, o botão "Sincronizar agora" ficaria bloqueado pra
// sempre com "já tem uma sincronização rodando". Ver comentário em jobRunner.js.
reconcileStaleJobsOnBoot()
  .then(runPromisedDateBackfillOnce)
  .catch((err) => console.error("[server] falha ao reconciliar jobs travados:", err.message));

// Roda UMA vez por versão (marcado em sync_state) depois dos deploys que corrigiram campos
// derivados do pedido (v2: prazo prometido em dias úteis/corridos + data prometida da Vtex;
// v3: client_id estável em vez do email mascarado da Vtex): reaproveita o `raw` já salvo de
// cada pedido, sem chamar a Vtex, e regrava esses campos nos pedidos antigos. O status aparece em /api/sync/status como "backfill-order-fields".
async function runPromisedDateBackfillOnce() {
  const FLAG = "migr:order_fields_v3";
  const { rows } = await pool.query("SELECT 1 FROM sync_state WHERE key = $1", [FLAG]);
  if (rows.length) return;
  await runJobInBackground("backfill-order-fields", async () => {
    await backfillOrderFields();
    await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, 'done', now())
       ON CONFLICT (key) DO UPDATE SET value = 'done', updated_at = now()`,
      [FLAG]
    );
  });
}

// Sincroniza pedidos a cada 30 minutos e estoque a cada 6 horas.
if (process.env.DISABLE_CRON !== "true") {
  cron.schedule("*/30 * * * *", () => {
    syncOrders().catch((err) => console.error("[cron] erro ao sincronizar pedidos:", err.response?.data || err.message));
  });
  cron.schedule("0 */6 * * *", () => {
    syncInventory().catch((err) => console.error("[cron] erro ao sincronizar estoque:", err.response?.data || err.message));
  });
}
