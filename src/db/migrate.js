// Cria o schema do Postgres usado para armazenar os dados sincronizados da Vtex.
// GA4 não precisa de tabelas próprias: consultamos a Data API sob demanda (com cache em memória).
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
  total_price         NUMERIC(14,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orders_creation_date ON orders (creation_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_category ON order_items (category);

CREATE TABLE IF NOT EXISTS inventory (
  product_id          TEXT NOT NULL,
  sku                 TEXT PRIMARY KEY,
  product_name        TEXT,
  category            TEXT,
  available_quantity  NUMERIC(12,2) NOT NULL DEFAULT 0,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
`;

async function migrate() {
  await pool.query(SQL);
  console.log("Migração concluída.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Erro na migração:", err);
  process.exit(1);
});
