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

-- Preço de tabela (sem desconto) do item, por unidade, segundo a Vtex (campo listPrice
-- do pedido). Comparado com unit_price pra saber se o item foi vendido em Liquidação
-- (preço com desconto) ou Coleção (preço cheio, sem desconto) — ver extractItems() em
-- syncVtex.js. Pedidos já sincronizados antes dessa coluna existir ficam com ela vazia
-- até rodar "Recalcular pedidos já sincronizados" no Admin (reaproveita o JSON bruto já
-- salvo em orders.raw, sem precisar buscar de novo na Vtex).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS list_unit_price NUMERIC(14,2);

-- Cupom aplicado ao pedido (marketingData.coupon da Vtex), valor de desconto concedido no
-- pedido (totals[].id === "Discounts", inclui cupom + outras promoções de pedido — diferente
-- do desconto por item de list_unit_price acima, que é sobre o preço de tabela do produto),
-- origem de UTM (marketingData.utmSource) e nº de parcelas do pagamento principal. Todos
-- vêm do JSON do pedido que a Vtex já manda e que já guardamos em orders.raw — dá pra
-- popular pedidos antigos com "Recalcular pedidos já sincronizados" no Admin, sem precisar
-- buscar de novo na Vtex.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC(14,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS installments INTEGER;

CREATE INDEX IF NOT EXISTS idx_orders_client_id ON orders (client_id);
CREATE INDEX IF NOT EXISTS idx_orders_coupon_code ON orders (coupon_code);

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

-- Flag "estoque ilimitado" (campo hasUnlimitedQuantity de cada depósito na resposta da Vtex
-- em /api/logistics/pvt/inventory/skus/{id}). Um SKU nesse modo fica sempre disponível pra
-- venda na Vtex independente da quantidade numérica do depósito (a própria Vtex documenta
-- que, nesse caso, "a quantidade disponível nunca diminui, e o SKU nunca fica sem estoque") —
-- por isso available_quantity sozinho não basta pra saber se o produto está "zerado" de
-- verdade: um SKU ilimitado pode ter totalQuantity=0 num depósito e ainda assim estar
-- disponível. Guardamos a flag separada pra exibir "Ilimitado" no painel em vez de "0".
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS has_unlimited_quantity BOOLEAN NOT NULL DEFAULT false;

-- Data prometida de entrega do pedido (shippingEstimateDate da Vtex, ou calculada a partir do
-- shippingEstimate somando dias uteis/corridos a data da compra). E com ela que o painel decide se
-- uma entrega foi no prazo, comparando datas de calendario (entregar no ultimo dia prometido conta
-- como no prazo).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_promised_date TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sync_state (
  key                 TEXT PRIMARY KEY,
  value                TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cache da foto principal de cada produto (buscada sob demanda na Vtex — ver
-- resolveProductImages em metrics/vendas.js), usada no card "Top produtos mais vendidos".
-- Só guarda produtos que já apareceram nesse ranking, não o catálogo inteiro: buscar a foto
-- de TODOS os produtos a cada sync seria centenas de chamadas na Vtex sem necessidade, já
-- que só os mais vendidos aparecem no card.
CREATE TABLE IF NOT EXISTS product_images (
  product_id          TEXT PRIMARY KEY,
  image_url           TEXT,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Limpeza única do cache de fotos gravado com a URL errada: até essa correção,
-- getSkuMainImageUrl (connectors/vtex.js) usava o campo Url que a Vtex devolve pro arquivo
-- do SKU, que aponta pro bucket S3 de upload interno da Vtex (ex.: sincdn.s3.sa-east-1.
-- amazonaws.com) — esse bucket não é acessível publicamente pelo navegador, por isso a foto
-- não aparecia no card mesmo quando a Vtex retornava uma Url preenchida. Confirmado
-- comparando com o site público da Zinzane: lá as fotos são servidas por
-- {conta}.vtexassets.com, a partir do ArchiveId do arquivo — é isso que getSkuMainImageUrl
-- passou a usar. Sem essa limpeza, produtos que já tinham uma foto (errada) cacheada aqui
-- nunca seriam buscados de novo (resolveProductImages só busca o que ainda não está em
-- cache). Idempotente: só apaga o que não é do domínio novo, então não faz nada depois que o
-- cache for todo repovoado com a URL certa.
DELETE FROM product_images WHERE image_url NOT LIKE '%.vtexassets.com/%';

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

-- Acesso por modulo e perfil operacional do CD (usuarios antigos continuam so no painel de vendas).
ALTER TABLE users ADD COLUMN IF NOT EXISTS modules TEXT[] NOT NULL DEFAULT '{vendas}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cd_perfis TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS nome TEXT;

-- ===== Modulo Recebimento / CD: da NF na doca ate o faturamento =====
CREATE TABLE IF NOT EXISTS cd_notas (
  id                  BIGSERIAL PRIMARY KEY,
  numero_nf           TEXT NOT NULL,
  serie               TEXT,
  fornecedor          TEXT NOT NULL,
  chave_nf            TEXT,
  total_pecas_nf      INTEGER NOT NULL DEFAULT 0,
  volumes_nf          INTEGER NOT NULL DEFAULT 0,
  prioridade          TEXT NOT NULL DEFAULT 'normal',
  status              TEXT NOT NULL DEFAULT 'aberta', -- aberta | concluida | cancelada
  etapa_atual         INTEGER NOT NULL DEFAULT 2,
  com_divergencia     BOOLEAN NOT NULL DEFAULT false,
  observacao          TEXT,
  criada_por          TEXT NOT NULL,
  criada_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS cd_notas_chave_uniq ON cd_notas (chave_nf) WHERE chave_nf IS NOT NULL AND status <> 'cancelada';
CREATE UNIQUE INDEX IF NOT EXISTS cd_notas_nf_uniq ON cd_notas (numero_nf, COALESCE(serie, ''), lower(fornecedor)) WHERE status <> 'cancelada';
CREATE INDEX IF NOT EXISTS cd_notas_status_idx ON cd_notas (status, etapa_atual);

CREATE TABLE IF NOT EXISTS cd_nota_itens (
  id                  BIGSERIAL PRIMARY KEY,
  nota_id             BIGINT NOT NULL REFERENCES cd_notas(id) ON DELETE CASCADE,
  modelo              TEXT NOT NULL,
  cor                 TEXT NOT NULL,
  qtd_nf              INTEGER,
  qtd_contada         INTEGER,
  qtd_ficha           INTEGER,
  qtd_checkout        INTEGER,
  amostra_separada    BOOLEAN NOT NULL DEFAULT false,
  cor_definida        TEXT,
  ref_zinzane         TEXT,
  justificativa_confronto TEXT,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cd_nota_itens ADD COLUMN IF NOT EXISTS tamanho TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS cd_nota_itens_nota_idx ON cd_nota_itens (nota_id);

CREATE TABLE IF NOT EXISTS cd_nota_etapas (
  nota_id             BIGINT NOT NULL REFERENCES cd_notas(id) ON DELETE CASCADE,
  etapa               INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pendente', -- pendente | em_andamento | concluida
  liberada_em         TIMESTAMPTZ, -- quando a etapa anterior terminou (comeca a contar a fila)
  iniciada_em         TIMESTAMPTZ,
  iniciada_por        TEXT,
  concluida_em        TIMESTAMPTZ,
  concluida_por       TEXT,
  dados               JSONB NOT NULL DEFAULT '{}'::jsonb,
  divergencia         BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (nota_id, etapa)
);

-- Trilha de auditoria: nada e apagado, cada acao vira um evento.
CREATE TABLE IF NOT EXISTS cd_eventos (
  id                  BIGSERIAL PRIMARY KEY,
  nota_id             BIGINT NOT NULL REFERENCES cd_notas(id) ON DELETE CASCADE,
  etapa               INTEGER,
  tipo                TEXT NOT NULL,
  usuario             TEXT NOT NULL,
  detalhe             JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cd_eventos_nota_idx ON cd_eventos (nota_id, criado_em);

-- Metas de tempo por etapa (minutos), ajustaveis pelo admin.
CREATE TABLE IF NOT EXISTS cd_etapa_config (
  etapa               INTEGER PRIMARY KEY,
  sla_exec_min        INTEGER NOT NULL,
  sla_fila_min        INTEGER NOT NULL
);

-- Marcas de migracoes unicas do modulo CD.
CREATE TABLE IF NOT EXISTS cd_meta (
  chave               TEXT PRIMARY KEY,
  valor               TEXT,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Migracao unica: o processo tinha 15 etapas (2 = abertura dos fardos, 3 = separacao). Como as duas
// acontecem juntas, viraram uma so (etapa 2) e as seguintes foram renumeradas (4..15 -> 3..14).
// Notas que ja existiam sao convertidas; roda uma vez so (marca em cd_meta) e dentro de uma transacao.
async function migrarEtapas14() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(7001)");
    const jaFeito = await c.query("SELECT 1 FROM cd_meta WHERE chave = 'etapas_14'");
    if (jaFeito.rows.length) { await c.query("COMMIT"); return; }

    const { rows: [{ n: temAntigas }] } = await c.query("SELECT count(*)::int AS n FROM cd_nota_etapas WHERE etapa = 15");
    if (temAntigas > 0) {
      // 1) etapa 2 absorve a 3 (status, datas e dados)
      await c.query(`
        UPDATE cd_nota_etapas t2 SET
          status = CASE WHEN t3.status = 'concluida' THEN 'concluida' WHEN t2.status = 'pendente' THEN 'pendente' ELSE 'em_andamento' END,
          iniciada_em = COALESCE(t2.iniciada_em, t3.iniciada_em),
          iniciada_por = COALESCE(t2.iniciada_por, t3.iniciada_por),
          concluida_em = CASE WHEN t3.status = 'concluida' THEN t3.concluida_em ELSE NULL END,
          concluida_por = CASE WHEN t3.status = 'concluida' THEN t3.concluida_por ELSE NULL END,
          dados = COALESCE(t2.dados, '{}'::jsonb) || COALESCE(t3.dados, '{}'::jsonb),
          divergencia = t2.divergencia OR t3.divergencia
        FROM cd_nota_etapas t3
        WHERE t2.nota_id = t3.nota_id AND t2.etapa = 2 AND t3.etapa = 3`);
      await c.query("DELETE FROM cd_nota_etapas WHERE etapa = 3");
      // 2) renumera 4..15 -> 3..14 (passando por negativos para nao colidir na chave primaria)
      await c.query("UPDATE cd_nota_etapas SET etapa = -(etapa - 1) WHERE etapa >= 4");
      await c.query("UPDATE cd_nota_etapas SET etapa = -etapa WHERE etapa < 0");
      // 3) etapa atual das notas e historico (eventos)
      await c.query("UPDATE cd_notas SET etapa_atual = CASE WHEN etapa_atual <= 3 THEN 2 ELSE etapa_atual - 1 END");
      await c.query("UPDATE cd_eventos SET etapa = CASE WHEN etapa = 3 THEN 2 WHEN etapa >= 4 THEN etapa - 1 ELSE etapa END WHERE etapa IS NOT NULL");
      // 4) metas de tempo: as da abertura/separacao antigas deixam de valer (a etapa 2 nova tem meta propria)
      await c.query("DELETE FROM cd_etapa_config WHERE etapa IN (2, 3)");
      await c.query("UPDATE cd_etapa_config SET etapa = -(etapa - 1) WHERE etapa >= 4");
      await c.query("UPDATE cd_etapa_config SET etapa = -etapa WHERE etapa < 0");
      console.log("[migrate] Notas do CD convertidas para o processo de 14 etapas (" + temAntigas + " nota(s)).");
    }
    await c.query("INSERT INTO cd_meta (chave, valor) VALUES ('etapas_14', 'ok')");
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

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
  await migrarEtapas14();
  await seedAdmin();
  console.log("Migração concluída.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Erro na migração:", err);
  process.exit(1);
});
