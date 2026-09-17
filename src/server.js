require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const vendas = require("./metrics/vendas");
const logistica = require("./metrics/logistica");
const marketing = require("./metrics/marketing");
const overview = require("./metrics/overview");
const { syncOrders, syncInventory, backfillCategories } = require("./sync/syncVtex");
const vtex = require("./connectors/vtex");
const { pool } = require("./db");

const app = express();
app.use(cors());
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
  if (!startDate && !endDate) return undefined;
  return [{ startDate: startDate || "30daysAgo", endDate: endDate || "today" }];
}

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.json(result);
    } catch (err) {
      const details = err.response?.data || err.message;
      console.error("[api]", JSON.stringify(details));
      res.status(500).json({ error: err.message, details });
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
app.get("/api/marketing/sessoes-categoria-produto", handle((req) =>
