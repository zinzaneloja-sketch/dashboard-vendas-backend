require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const vendas = require("./metrics/vendas");
const logistica = require("./metrics/logistica");
const marketing = require("./metrics/marketing");
const overview = require("./metrics/overview");
const { syncOrders, syncInventory, backfillCategories, backfillOrderFields } = require("./sync/syncVtex");
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

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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
app.get("/api/vendas/receita-vs-meta", requireAuth, handle((req) => vendas.receitaVsMeta({ month: req.query.month })));
app.post("/api/vendas/meta", requireAuth, handle(async (req) => {
  await vendas.setRevenueGoal({ month: new Date(req.body.month), goalValue: Number(req.body.goalValue) });
  return { ok: true };
}));
app.get("/api/vendas/por-categoria", requireAuth, handle((req) => vendas.vendaPorCategoria(parseDateRange(req))));
app.get("/api/vendas/curva-abc", requireAuth, handle((req) => vendas.curvaAbcProdutos({
  ...parseDateRange(req),
  categoria: req.query.categoria,
  metric: req.query.metric,
  classes: req.query.classes ? String(req.query.classes).split(",").map((c) => c.trim()).filter(Boolean) : undefined,
})));
app.get("/api/vendas/categorias", requireAuth, handle(async () => {
  const { rows } = await pool.query(
    "SELECT DISTINCT category FROM order_items WHERE category IS NOT NULL ORDER BY category"
  );
  return { categorias: rows.map((r) => r.category) };
}));
app.get("/api/vendas/meios-pagamento", requireAuth, handle((req) => vendas.meiosDePagamento(parseDateRange(req))));
app.get("/api/vendas/eficiencia-frete-regiao", requireAuth, handle((req) => vendas.eficienciaFretePorRegiao(parseDateRange(req))));
app.get("/api/vendas/receita-por-regiao", requireAuth, handle((req) => vendas.receitaPorRegiao(parseDateRange(req))));
app.get("/api/vendas/giro-estoque", requireAuth, handle((req) => vendas.giroDeEstoque(parseDateRange(req))));
app.get("/api/vendas/ranking-produtos-estoque", requireAuth, handle((req) => vendas.rankingProdutosXEstoque({ ...parseDateRange(req), limit: req.query.limit ? Number(req.query.limit) : undefined })));

// ---- Logística ----
app.get("/api/logistica/sla-entrega", requireAuth, handle((req) => logistica.slaDeEntrega(parseDateRange(req))));
app.get("/api/logistica/eficiencia-frete-regiao", requireAuth, handle((req) => logistica.eficienciaFretePorRegiao(parseDateRange(req))));

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
app.post("/api/sync/orders", requireAuth, requireAdmin, handle(async (req) => {
  await syncOrders({ daysBack: req.body?.daysBack });
  return { ok: true };
}));
app.get("/api/sync/orders", requireAuth, requireAdmin, handle(async (req) => {
  await syncOrders({ daysBack: req.query?.daysBack ? Number(req.query.daysBack) : undefined });
  return { ok: true };
}));
app.post("/api/sync/inventory", requireAuth, requireAdmin, handle(async () => {
  await syncInventory();
  return { ok: true };
}));
app.get("/api/sync/inventory", requireAuth, requireAdmin, handle(async () => {
  await syncInventory();
  return { ok: true };
}));
// Backfill único: recalcula os nomes de categoria dos pedidos já sincronizados
// (corrige o bug em que a categoria ficava salva como ID numérico da Vtex).
app.get("/api/sync/backfill-categories", requireAuth, requireAdmin, handle(async () => {
  await backfillCategories();
  return { ok: true };
}));
// Backfill único: recalcula delivered_at / dias de frete real e prometido de todos os
// pedidos já sincronizados (corrige o bug em que a entrega não era detectada).
app.get("/api/sync/backfill-order-fields", requireAuth, requireAdmin, handle(async () => {
  await backfillOrderFields();
  return { ok: true };
}));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[server] rodando na porta ${PORT}`));

// Sincroniza pedidos a cada 30 minutos e estoque a cada 6 horas.
if (process.env.DISABLE_CRON !== "true") {
  cron.schedule("*/30 * * * *", () => {
    syncOrders().catch((err) => console.error("[cron] erro ao sincronizar pedidos:", err.response?.data || err.message));
  });
  cron.schedule("0 */6 * * *", () => {
    syncInventory().catch((err) => console.error("[cron] erro ao sincronizar estoque:", err.response?.data || err.message));
  });
}
