// Cria o schema do Postgres usado para armazenar os dados sincronizados da Vtex.
// GA4 não precisa de tabelas próprias: consultamos a Data API sob demanda (com cache em memória).
const bcrypt = require("bcryptjs");
const { pool } = require("../db");

const SQL = `
CREATE TABLE IF NOT EXISTS orders (
  order_id            TEXT PRIMARY KEY,
  creation_date       TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL,
  total_value         NUMERIC(14,2) NOT NULL DEFAULT 0,
  shipping_value      NUMERIC(14,2) NOT NULL DEFAULT 0,
  sales_channel       TEXT,
  client_id           TEXT,
  payment_method      TEXT,
  payment_group       TEXT,
  region_state        TEXT,
  region_city         TEXT,
  shipping_carrier    TEXT,
  shipping_promised_days NUMERIC(6,2),
  shipping_actual_days   NUMERIC(6,2),
  delivered_at        TIMESTAMPTZ,
  invoiced_at         TIMESTAMPTZ,
  raw                 JSONB,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id                  BIGSERIAL PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id          TEXT NOT NULL,
  sku                 TEXT,
  product_name        TEXT,
  category            TEXT,
  quantity            NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_price          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_price         NUMERIC(14,2) NOT NULL DEFAULT 0,
  warehouse_id        TEXT
);

-- order_items já existia em produção antes da coluna warehouse_id existir, então o
-- CREATE TABLE IF NOT EXISTS acima não a adiciona sozinho — garantimos aqui, ANTES de
-- qualquer índice que use essa coluna (senão o CREATE INDEX abaixo falha na coluna que
-- ainda não existe nessa tabela já existente).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS warehouse_id TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_creation_date ON orders (creation_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_category ON order_items (category);
CREATE INDEX IF NOT EXISTS idx_order_items_warehouse_id ON order_items (warehouse_id);

-- Lojas/depósitos OMNI cadastrados na Vtex (de onde o estoque do e-commerce é expedido).
-- Sincronizado via syncWarehouses(); guardamos o JSON bruto porque o formato exato do
-- endpoint de configuração de depósitos da Vtex pode variar por conta.
CREATE TABLE IF NOT EXISTS warehouses (
  warehouse_id        TEXT PRIMARY KEY,
  name                TEXT,
  state               TEXT,
  city                TEXT,
  is_active           BOOLEAN,
  raw                 JSONB,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Correção manual do estado de cada loja/depósito OMNI. A API de depósitos da Vtex
-- (/api/logistics/pvt/configuration/warehouses) nessa conta não retorna endereço/UF —
-- isso normalmente só vem cadastrado nos "pickup points", não nos warehouses de estoque —
-- então o estado real de cada loja precisa ser informado manualmente aqui pelo admin
-- (tela "Estados das lojas" no Admin). Quando existir, esse valor tem prioridade sobre
-- warehouses.state nas métricas de logística.
CREATE TABLE IF NOT EXISTS warehouse_state_overrides (
  warehouse_id        TEXT PRIMARY KEY,
  state               TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory (
  product_id          TEXT NOT NULL,
  sku                 TEXT PRIMARY KEY,
  product_name        TEXT,
  category            TEXT,
  available_quantity  NUMERIC(12,2) NOT NULL DEFAULT 0,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Data em que o produto entrou no site (campo "DateFirstAvailable" do catálogo da Vtex),
-- usada pra calcular "tempo até a 1a venda" no lugar do giro de estoque. Guardamos o JSON
-- bruto do SKU junto porque o nome exato do campo pode variar por conta/versão da Vtex —
-- se date_first_available não vier populado, dá pra inspecionar a coluna raw direto no
-- banco pra achar o campo certo sem precisar buscar de novo na Vtex.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS date_first_available TIMESTAMPTZ;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS raw JSONB;

CREATE TABLE IF NOT EXISTS sync_state (
  key                 TEXT PRIMARY KEY,
  value                TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Metas de receita configuráveis manualmente pelo usuário (Vtex não tem conceito de "meta")
CREATE TABLE IF NOT EXISTS revenue_goals (
  month               DATE PRIMARY KEY, -- sempre dia 1 do mês
  goal_value          NUMERIC(14,2) NOT NULL
);

-- Usuários com acesso ao painel (login por email/senha).
CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'viewer', -- 'admin' ou 'viewer'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Garante que o admin master exista. Se ADMIN_PASSWORD não vier configurada,
// gera uma senha aleatória e a imprime UMA vez nos logs do deploy, para que
// o dono da conta consiga recuperá-la ali (nunca fica salva em texto puro).
//
// Se o admin JÁ existir e a variável ADMIN_PASSWORD estiver definida, a senha
// é redefinida para o valor da variável a cada deploy — isso permite trocar a
// senha do admin master a qualquer momento só mudando a variável no Railway,
// e também corrige o caso em que o usuário foi criado antes de ADMIN_PASSWORD
// estar configurada (senha aleatória "perdida" nos logs de um deploy anterior).
async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || "tbarone@zinzane.com.br").toLowerCase();
  const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);

  if (rows.length > 0) {
    if (process.env.ADMIN_PASSWORD) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      await pool.query(
        "UPDATE users SET password_hash = $2, role = 'admin' WHERE email = $1",
        [email, hash]
      );
      console.log("========================================================");
      console.log(`[seed] Senha do admin ${email} redefinida a partir da variável ADMIN_PASSWORD.`);
      console.log("========================================================");
    }
    return;
  }

  const password = process.env.ADMIN_PASSWORD || Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') ON CONFLICT (email) DO NOTHING",
    [email, hash]
  );

  console.log("========================================================");
  console.log(`[seed] Usuário admin criado: ${email}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`[seed] Senha gerada automaticamente: ${password}`);
    console.log("[seed] Guarde essa senha agora — ela não aparece de novo nos logs.");
  } else {
    console.log("[seed] Senha definida pela variável de ambiente ADMIN_PASSWORD.");
  }
  console.log("========================================================");
}

async function migrate() {
  await pool.query(SQL);
  await seedAdmin();
  console.log("Migração concluída.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Erro na migração:", err);
  process.exit(1);
});
