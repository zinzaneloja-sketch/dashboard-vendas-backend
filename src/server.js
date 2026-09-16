require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const vendas = require("./metrics/vendas");
const logistica = require("./metrics/logistica");
const marketing = require("./metrics/marketing");
const overview = require("./metrics/overview");
const { syncOrders, syncInventory } = require("./sync/syncVtex");

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
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  };
}

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Vendas ----
app.get("/api/vendas/receita-vs-meta", handle((req) => vendas.receitaVsMeta({ month: req.query.month })));
app.post("/api/vendas/meta", handle(async (req) => {
  await vendas.setRevenueGoal({ month: new Date(req.body.month), goalValue: Number(req.body.goalValue) });
  return { ok: true };
}));
app.get("/api/vendas/por-categoria", handle((req) => vendas.vendaPorCategoria(parseDateRange(req))));
app.get("/api/vendas/curva-abc", handle((req) => vendas.curvaAbcProdutos(parseDateRange(req))));
app.get("/api/vendas/meios-pagamento", handle((req) => vendas.meiosDePagamento(parseDateRange(req))));
app.get("/api/vendas/eficiencia-frete-regiao", handle((req) => vendas.eficienciaFretePorRegiao(parseDateRange(req))));
app.get("/api/vendas/receita-por-regiao", handle((req) => vendas.receitaPorRegiao(parseDateRange(req))));
app.get("/api/vendas/giro-estoque", handle((req) => vendas.giroDeEstoque(parseDateRange(req))));
app.get("/api/vendas/ranking-produtos-estoque", handle((req) => vendas.rankingProdutosXEstoque(parseDateRange(req))));

// ---- Logística ----
app.get("/api/logistica/sla-entrega", handle((req) => logistica.slaDeEntrega(parseDateRange(req))));
app.get("/api/logistica/eficiencia-frete-regiao", handle((req) => logistica.eficienciaFretePorRegiao(parseDateRange(req))));

// ---- Marketing ----
app.get("/api/marketing/sessoes-categoria-produto", handle((req) => marketing.sessoesPorCategoriaEProduto({ dateRanges: parseGa4DateRanges(req) })));
app.get("/api/marketing/ticket-medio", handle((req) => marketing.ticketMedio(parseDateRange(req))));
app.get("/api/marketing/conversao-origem", handle((req) => marketing.conversaoPorOrigem({ dateRanges: parseGa4DateRanges(req) })));
app.get("/api/marketing/receita-categoria-produto", handle((req) => marketing.receitaPorCategoriaEProduto(parseDateRange(req))));
app.get("/api/marketing/receita-pagamento-regiao", handle((req) => marketing.receitaPorPagamentoERegiao(parseDateRange(req))));

// ---- Overview ----
app.get("/api/overview/receita-dispositivo", handle((req) => overview.receitaPorDispositivo({ dateRanges: parseGa4DateRanges(req), source: req.query.source })));
app.get("/api/overview/taxa-rejeicao", handle((req) => overview.taxaDeRejeicao({ dateRanges: parseGa4DateRanges(req), source: req.query.source })));
app.get("/api/overview/taxa-conversao", handle((req) => overview.taxaDeConversao({ dateRanges: parseGa4DateRanges(req), source: req.query.source })));
app.get("/api/overview/tracking-pedido", handle((req) => overview.trackingDePedido(parseDateRange(req))));
app.get("/api/overview/itens-por-pedido", handle((req) => overview.itensPorPedido(parseDateRange(req))));
app.get("/api/overview/ltv-categoria", handle((req) => overview.ltvPorCategoria(parseDateRange(req))));

// ---- Sync manual (útil para forçar atualização ou popular pela primeira vez) ----
app.post("/api/sync/orders", handle(async (req) => {
  await syncOrders({ daysBack: req.body?.daysBack });
  return { ok: true };
}));
app.post("/api/sync/inventory", handle(async () => {
  await syncInventory();
  return { ok: true };
}));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[server] rodando na porta ${PORT}`));

// Sincroniza pedidos a cada 30 minutos e estoque a cada 6 horas.
if (process.env.DISABLE_CRON !== "true") {
  cron.schedule("*/30 * * * *", () => {
    syncOrders().catch((err) => console.error("[cron] erro ao sincronizar pedidos:", err));
  });
  cron.schedule("0 */6 * * *", () => {
    syncInventory().catch((err) => console.error("[cron] erro ao sincronizar estoque:", err));
  });
}
