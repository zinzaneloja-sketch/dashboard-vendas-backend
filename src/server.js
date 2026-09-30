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
} = require("./auth");

const app = express();
app.use(cors()); // o dashboard roda em outro domínio (Artifact/estático), liberamos geral
app.use(express.json());

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
      const result = await fn(req);
      res.json(result);
    } catch (err) {
      const details = err.response?.data || err.message;
      const status = err.status || 500;
      if (status >= 500) console.error("[api]", JSON.stringify(details));
      res.status(status).json({ error: err.message, details });
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
app.post("/api/auth/login", handle(async (req) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    const err = new Error("Informe email e senha.");
    err.status = 400;
    throw err;
  }
  const user = await findUserByEmail(email);
  if (!user) {
    const err = new Error("Email ou senha inválidos.");
    err.status = 401;
    throw err;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const err = new Error("Email ou senha inválidos.");
    err.status = 401;
    throw err;
  }
  const token = signToken(user);
  return { token, user: { id: user.id, email: user.email, role: user.role } };
}));

app.get("/api/auth/me", requireAuth, handle(async (req) => ({ user: req.user })));

app.get("/api/auth/users", requireAuth, requireAdmin, handle(async () => ({ users: await listUsers() })));

app.post("/api/auth/users", requireAuth, requireAdmin, handle(async (req) => {
  const { email, password, role } = req.body || {};
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
  const user = await createUser({ email, password, role });
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
app.get("/api/sync/status", requireAuth, requireAdmin, handle(async () => ({ jobs: await getAllJobStatuses() })));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[server] rodando na porta ${PORT}`));

// Libera qualquer job que ficou marcado "running" de um processo anterior (deploy/restart no
// meio de uma sincronização) — sem isso, o botão "Sincronizar agora" ficaria bloqueado pra
// sempre com "já tem uma sincronização rodando". Ver comentário em jobRunner.js.
reconcileStaleJobsOnBoot().catch((err) => console.error("[server] falha ao reconciliar jobs travados:", err.message));

// Sincroniza pedidos a cada 30 minutos e estoque a cada 6 horas.
if (process.env.DISABLE_CRON !== "true") {
  cron.schedule("*/30 * * * *", () => {
    syncOrders().catch((err) => console.error("[cron] erro ao sincronizar pedidos:", err.response?.data || err.message));
  });
  cron.schedule("0 */6 * * *", () => {
    syncInventory().catch((err) => console.error("[cron] erro ao sincronizar estoque:", err.response?.data || err.message));
  });
}
