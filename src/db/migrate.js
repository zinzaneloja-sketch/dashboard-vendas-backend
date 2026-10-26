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
ALTER TABLE cd_nota_itens ADD COLUMN IF NOT EXISTS ref_fornecedor TEXT NOT NULL DEFAULT '';

-- Produtos que vieram na propria NF (lidos do PDF/XML na entrada): servem de base para a separacao e a contagem.
CREATE TABLE IF NOT EXISTS cd_nota_nf_itens (
  id                  BIGSERIAL PRIMARY KEY,
  nota_id             BIGINT NOT NULL REFERENCES cd_notas(id) ON DELETE CASCADE,
  ordem               INTEGER NOT NULL DEFAULT 0,
  codigo              TEXT NOT NULL,
  descricao           TEXT,
  qtd                 INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cd_nota_nf_itens_nota_idx ON cd_nota_nf_itens (nota_id);
-- Conjunto: cada unidade da NF vale 2 pecas (fator = 2). valor_unit = preco unitario da NF.
ALTER TABLE cd_nota_nf_itens ADD COLUMN IF NOT EXISTS fator INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cd_nota_nf_itens ADD COLUMN IF NOT EXISTS valor_unit NUMERIC(14,4);
ALTER TABLE cd_notas ADD COLUMN IF NOT EXISTS valor_nf NUMERIC(14,2);

-- Cor pelo catalogo (codigo + nome), no lugar de texto livre. Defeito e conserto fazem parte da contagem.
ALTER TABLE cd_nota_itens ADD COLUMN IF NOT EXISTS cor_codigo TEXT;
ALTER TABLE cd_nota_itens ADD COLUMN IF NOT EXISTS qtd_defeito INTEGER;
ALTER TABLE cd_nota_itens ADD COLUMN IF NOT EXISTS qtd_conserto INTEGER;
CREATE TABLE IF NOT EXISTS cd_cores (
  codigo              TEXT PRIMARY KEY,
  nome                TEXT NOT NULL,
  nome_en             TEXT,
  ativo               BOOLEAN NOT NULL DEFAULT true
);
-- Quem contou cada linha (contagem manual)
ALTER TABLE cd_nota_itens ADD COLUMN IF NOT EXISTS contado_por TEXT;
-- Cor definida pelo Estilo (catalogo): por padrao e a cor da separacao
ALTER TABLE cd_nota_itens ADD COLUMN IF NOT EXISTS cor_def_codigo TEXT;
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

-- Posicao na fila de prioridade informada na entrada da NF (1 = primeira a ser atendida)
ALTER TABLE cd_notas ADD COLUMN IF NOT EXISTS ranking INTEGER;

-- Cada recontagem da etapa de contagem: quem recontou, qual tentativa, quanto deu
CREATE TABLE IF NOT EXISTS cd_recontagens (
  id              BIGSERIAL PRIMARY KEY,
  nota_id         BIGINT NOT NULL REFERENCES cd_notas(id) ON DELETE CASCADE,
  tentativa       INTEGER NOT NULL,
  por             TEXT NOT NULL,
  registrado_por  TEXT NOT NULL,
  metodo          TEXT NOT NULL,
  total           INTEGER NOT NULL,
  contado         INTEGER,
  esperado        INTEGER,
  contadores      TEXT[] NOT NULL DEFAULT '{}',
  obs             TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cd_recontagens ADD COLUMN IF NOT EXISTS itens JSONB;
CREATE INDEX IF NOT EXISTS cd_recontagens_nota_idx ON cd_recontagens (nota_id, tentativa);
-- ===== Faturamento e trânsito (aba própria, independente das notas de entrada) =====
CREATE TABLE IF NOT EXISTS cd_transportadoras (
  id                   BIGSERIAL PRIMARY KEY,
  nome                 TEXT NOT NULL,
  cnpj                 TEXT,
  prazo_corridos       BOOLEAN NOT NULL DEFAULT false,
  ativa                BOOLEAN NOT NULL DEFAULT true,
  tabela_importada_em  TIMESTAMPTZ,
  tabela_importada_por TEXT,
  criada_em            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cd_transportadoras_nome_uq ON cd_transportadoras (lower(nome));
CREATE TABLE IF NOT EXISTS cd_frete_tabela (
  id               BIGSERIAL PRIMARY KEY,
  transportadora_id BIGINT NOT NULL REFERENCES cd_transportadoras(id) ON DELETE CASCADE,
  uf               TEXT NOT NULL,
  cidade           TEXT,
  cidade_norm      TEXT,
  peso_de          NUMERIC(12,3) NOT NULL DEFAULT 0,
  peso_ate         NUMERIC(12,3),
  frete            NUMERIC(12,2),
  frete_kg         NUMERIC(12,4),
  excedente_kg     NUMERIC(12,4),
  adv_pct          NUMERIC(8,4),
  gris_pct         NUMERIC(8,4),
  taxa_fixa        NUMERIC(12,2),
  frete_minimo     NUMERIC(12,2),
  prazo_dias       INTEGER
);
CREATE INDEX IF NOT EXISTS cd_frete_tabela_idx ON cd_frete_tabela (transportadora_id, uf);
CREATE TABLE IF NOT EXISTS cd_fat_nfs (
  id                BIGSERIAL PRIMARY KEY,
  tipo              TEXT NOT NULL,
  arquivo_nome      TEXT,
  tamanho           INTEGER,
  numero            TEXT,
  serie             TEXT,
  chave             TEXT,
  emitida_em        TIMESTAMPTZ,
  destino_nome      TEXT,
  destino_cnpj      TEXT,
  destino_uf        TEXT,
  destino_cidade    TEXT,
  destino_cep       TEXT,
  volumes           INTEGER,
  peso_kg           NUMERIC(12,3),
  valor             NUMERIC(14,2),
  pecas             INTEGER,
  transportadora_xml TEXT,
  transportadora_id BIGINT REFERENCES cd_transportadoras(id) ON DELETE SET NULL,
  frete_previsto    NUMERIC(12,2),
  prazo_dias        INTEGER,
  status            TEXT NOT NULL DEFAULT 'emitida',
  coleta_data       DATE,
  previsao_entrega  DATE,
  entregue_data     DATE,
  entregue_marcada_em TIMESTAMPTZ,
  entregue_por      TEXT,
  recebido_por      TEXT,
  frete_real        NUMERIC(12,2),
  obs               TEXT,
  origem_saida_id   BIGINT,
  enviada_por       TEXT NOT NULL,
  enviada_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cd_fat_nfs_chave_uq ON cd_fat_nfs (chave) WHERE chave IS NOT NULL;
ALTER TABLE cd_fat_nfs ADD COLUMN IF NOT EXISTS prazo_manual BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cd_fat_nfs ADD COLUMN IF NOT EXISTS transportadora_cnpj TEXT;
-- prazos de entrega cadastrados por transportadora (por UF ou cidade) + prazo padrão
ALTER TABLE cd_transportadoras ADD COLUMN IF NOT EXISTS prazo_padrao INTEGER;
-- prazo de pagamento da transportadora (ciclo de fechamento + vencimento)
ALTER TABLE cd_transportadoras ADD COLUMN IF NOT EXISTS pag_ciclo TEXT NOT NULL DEFAULT 'nenhum';
ALTER TABLE cd_transportadoras ADD COLUMN IF NOT EXISTS pag_base TEXT NOT NULL DEFAULT 'emissao';
ALTER TABLE cd_transportadoras ADD COLUMN IF NOT EXISTS pag_fecha_dow INTEGER;
ALTER TABLE cd_transportadoras ADD COLUMN IF NOT EXISTS pag_dias INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cd_transportadoras ADD COLUMN IF NOT EXISTS pag_dia_fixo INTEGER;
-- modal do frete: cada tabela é rodoviária ou aérea; a NF guarda o modal usado
ALTER TABLE cd_frete_tabela ADD COLUMN IF NOT EXISTS modal TEXT NOT NULL DEFAULT 'rodoviario';
ALTER TABLE cd_fat_nfs ADD COLUMN IF NOT EXISTS modal TEXT NOT NULL DEFAULT 'rodoviario';
CREATE INDEX IF NOT EXISTS cd_frete_tabela_modal_idx ON cd_frete_tabela (transportadora_id, modal, uf);
CREATE TABLE IF NOT EXISTS cd_transportadora_prazos (
  id               BIGSERIAL PRIMARY KEY,
  transportadora_id BIGINT NOT NULL REFERENCES cd_transportadoras(id) ON DELETE CASCADE,
  uf               TEXT NOT NULL,
  cidade           TEXT,
  cidade_norm      TEXT,
  prazo_dias       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cd_transportadora_prazos_uq ON cd_transportadora_prazos (transportadora_id, uf, coalesce(cidade_norm, ''));
-- registro das NFs de saída excluídas (a NF some, o rastro fica)
CREATE TABLE IF NOT EXISTS cd_fat_excluidas (
  id          BIGSERIAL PRIMARY KEY,
  nfs_id      BIGINT,
  numero      TEXT,
  serie       TEXT,
  chave       TEXT,
  destino     TEXT,
  status      TEXT,
  arquivo_nome TEXT,
  motivo      TEXT,
  excluida_por TEXT NOT NULL,
  excluida_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cd_fat_nfs_status_idx ON cd_fat_nfs (status, previsao_entrega);
CREATE TABLE IF NOT EXISTS cd_fat_nfs_arq (
  nfs_id   BIGINT PRIMARY KEY REFERENCES cd_fat_nfs(id) ON DELETE CASCADE,
  conteudo BYTEA NOT NULL
);
CREATE TABLE IF NOT EXISTS cd_fat_eventos (
  id        BIGSERIAL PRIMARY KEY,
  nfs_id    BIGINT NOT NULL REFERENCES cd_fat_nfs(id) ON DELETE CASCADE,
  tipo      TEXT NOT NULL,
  usuario   TEXT NOT NULL,
  detalhe   JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cd_fat_eventos_idx ON cd_fat_eventos (nfs_id, id);


-- Lotes de etiquetas: a etiquetagem corre em paralelo com a contagem, lote a lote
CREATE TABLE IF NOT EXISTS cd_etiquetas_lotes (
  id              BIGSERIAL PRIMARY KEY,
  nota_id         BIGINT NOT NULL REFERENCES cd_notas(id) ON DELETE CASCADE,
  qtd             INTEGER NOT NULL,
  por             TEXT NOT NULL,
  registrado_por  TEXT NOT NULL,
  obs             TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cd_etiquetas_lotes_nota_idx ON cd_etiquetas_lotes (nota_id, criado_em);

-- NFs de saida (uma entrada pode gerar dezenas, uma por loja). O arquivo fica em tabela a parte.
CREATE TABLE IF NOT EXISTS cd_nfs_saida (
  id              BIGSERIAL PRIMARY KEY,
  nota_id         BIGINT NOT NULL REFERENCES cd_notas(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,           -- xml | pdf
  arquivo_nome    TEXT NOT NULL,
  tamanho         INTEGER NOT NULL DEFAULT 0,
  numero          TEXT,
  serie           TEXT,
  chave           TEXT,
  destino_nome    TEXT,
  destino_cnpj    TEXT,
  pecas           INTEGER,
  valor           NUMERIC(14,2),
  enviada_por     TEXT NOT NULL,
  enviada_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cd_nfs_saida_nota_idx ON cd_nfs_saida (nota_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS cd_nfs_saida_chave_uq ON cd_nfs_saida (chave) WHERE chave IS NOT NULL;
CREATE TABLE IF NOT EXISTS cd_nfs_saida_arq (
  nfs_id          BIGINT PRIMARY KEY REFERENCES cd_nfs_saida(id) ON DELETE CASCADE,
  conteudo        BYTEA NOT NULL
);
-- Trânsito de entrada: envios do fornecedor até a Zinzane (frete por nossa conta), ligados à NF recebida na doca
CREATE TABLE IF NOT EXISTS cd_ent_envios (
  id                BIGSERIAL PRIMARY KEY,
  fornecedor        TEXT NOT NULL,
  numero_nf         TEXT,
  serie             TEXT,
  chave_nf          TEXT,
  volumes           INTEGER,
  peso_kg           NUMERIC(12,3),
  pecas             INTEGER,
  valor             NUMERIC(14,2),
  origem_uf         TEXT,
  origem_cidade     TEXT,
  transportadora_id BIGINT REFERENCES cd_transportadoras(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'solicitada', -- solicitada | em_transito | recebida | cancelada
  coleta_agendada   DATE,
  coleta_data       DATE,
  prazo_dias        INTEGER,
  prazo_manual      BOOLEAN NOT NULL DEFAULT false,
  previsao_chegada  DATE,
  recebida_em       TIMESTAMPTZ,
  nota_id           BIGINT REFERENCES cd_notas(id) ON DELETE SET NULL,
  vinculo           TEXT, -- automatico | manual
  obs               TEXT,
  criado_por        TEXT NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cd_ent_envios_status_idx ON cd_ent_envios (status, criado_em DESC);
CREATE INDEX IF NOT EXISTS cd_ent_envios_nota_idx ON cd_ent_envios (nota_id);
CREATE UNIQUE INDEX IF NOT EXISTS cd_ent_envios_nota_uq ON cd_ent_envios (nota_id) WHERE nota_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cd_ent_envios_chave_uq ON cd_ent_envios (chave_nf) WHERE chave_nf IS NOT NULL AND status <> 'cancelada';
CREATE TABLE IF NOT EXISTS cd_ent_eventos (
  id        BIGSERIAL PRIMARY KEY,
  envio_id  BIGINT NOT NULL REFERENCES cd_ent_envios(id) ON DELETE CASCADE,
  tipo      TEXT NOT NULL,
  usuario   TEXT NOT NULL,
  detalhe   JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cd_ent_eventos_idx ON cd_ent_eventos (envio_id, id);
`;

// Migracao unica: o processo tinha 15 etapas (2 = abertura dos fardos, 3 = separacao). Como as duas
// acontecem juntas, viraram uma so (etapa 2) e as seguintes foram renumeradas (4..15 -> 3..14).
// Notas que ja existiam sao convertidas; roda uma vez so (marca em cd_meta) e dentro de uma transacao.
// Carga unica do catalogo de cores (codigo + nome) a partir do arquivo cores.json, so quando a tabela esta vazia.
async function semearCores() {
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM cd_cores");
  if (n > 0) return;
  const cores = require("../cd/cores.json");
  for (const c of cores) {
    await pool.query("INSERT INTO cd_cores (codigo, nome, nome_en, ativo) VALUES ($1,$2,$3,$4) ON CONFLICT (codigo) DO NOTHING", [c.codigo, c.nome, c.nome_en || null, c.ativo !== false]);
  }
  console.log("[migrate] Catalogo de cores carregado: " + cores.length + " cores.");
}

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


// Processo de 12 etapas: saem "Preenchimento da ficha" (antiga 4) e "Separacao de 1 peca para o Estilo" (antiga 5,
// que virou uma marcacao dentro da etapa 2). Renumera as etapas seguintes e converte as notas em andamento.
async function migrarEtapas12() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(7002)");
    const jaFeito = await c.query("SELECT 1 FROM cd_meta WHERE chave = 'etapas_12'");
    if (jaFeito.rows.length) { await c.query("COMMIT"); return; }

    const { rows: [{ n: antigas }] } = await c.query("SELECT count(*)::int AS n FROM cd_nota_etapas WHERE etapa = 14");
    if (antigas > 0) {
      // historico das etapas extintas fica, marcado como "etapa antiga" (sem numero)
      await c.query("UPDATE cd_eventos SET detalhe = detalhe || jsonb_build_object('etapa_antiga', etapa), etapa = NULL WHERE etapa IN (4, 5)");
      await c.query("UPDATE cd_eventos SET etapa = etapa - 2 WHERE etapa >= 6");
      await c.query("DELETE FROM cd_nota_etapas WHERE etapa IN (4, 5)");
      await c.query("UPDATE cd_nota_etapas SET etapa = -(etapa - 2) WHERE etapa >= 6");
      await c.query("UPDATE cd_nota_etapas SET etapa = -etapa WHERE etapa < 0");
      await c.query("UPDATE cd_notas SET etapa_atual = CASE WHEN etapa_atual IN (4, 5) THEN 4 WHEN etapa_atual >= 6 THEN etapa_atual - 2 ELSE etapa_atual END");
      // nota que estava na ficha ou na amostra passa a ficar aguardando a referencia Zinzane (nova etapa 4)
      await c.query(`UPDATE cd_nota_etapas e SET liberada_em = now(), status = 'pendente', iniciada_em = NULL, iniciada_por = NULL
                       FROM cd_notas n WHERE e.nota_id = n.id AND e.etapa = 4 AND n.status = 'aberta' AND n.etapa_atual = 4 AND e.status = 'pendente' AND e.liberada_em IS NULL`);
      await c.query("DELETE FROM cd_etapa_config WHERE etapa IN (4, 5)");
      await c.query("UPDATE cd_etapa_config SET etapa = -(etapa - 2) WHERE etapa >= 6");
      await c.query("UPDATE cd_etapa_config SET etapa = -etapa WHERE etapa < 0");
      console.log("[migrate] Notas do CD convertidas para o processo de 12 etapas (" + antigas + " nota(s)).");
    }
    await c.query("INSERT INTO cd_meta (chave, valor) VALUES ('etapas_12', 'ok')");
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}


// O faturamento saiu do fluxo da nota de entrada (uma NF de saida mistura produtos de varias entradas).
// A nota termina no Picking; as NFs de saida vao para a aba Faturamento e transito.
async function migrarFaturamento() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(7004)");
    const jaFeito = await c.query("SELECT 1 FROM cd_meta WHERE chave = 'faturamento_aba'");
    if (jaFeito.rows.length) { await c.query("COMMIT"); return; }
    // NFs de saida ja enviadas dentro das notas passam para a aba nova (sem perder o arquivo)
    await c.query(`INSERT INTO cd_fat_nfs (tipo, arquivo_nome, tamanho, numero, serie, chave, destino_nome, destino_cnpj, pecas, valor, enviada_por, enviada_em, origem_saida_id)
                     SELECT tipo, arquivo_nome, tamanho, numero, serie, chave, destino_nome, destino_cnpj, pecas, valor, enviada_por, enviada_em, id FROM cd_nfs_saida
                     ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO cd_fat_nfs_arq (nfs_id, conteudo)
                     SELECT f.id, a.conteudo FROM cd_fat_nfs f JOIN cd_nfs_saida_arq a ON a.nfs_id = f.origem_saida_id ON CONFLICT DO NOTHING`);
    // notas paradas no antigo faturamento: encerram (o fluxo da nota agora acaba no picking)
    const enc = await c.query("UPDATE cd_notas SET status = 'concluida', concluida_em = COALESCE(concluida_em, now()) WHERE status = 'aberta' AND etapa_atual = 12");
    await c.query("UPDATE cd_eventos SET detalhe = detalhe || jsonb_build_object('etapa_antiga', etapa), etapa = NULL WHERE etapa = 12");
    await c.query("DELETE FROM cd_nota_etapas WHERE etapa = 12");
    await c.query("DELETE FROM cd_etapa_config WHERE etapa = 12");
    await c.query("INSERT INTO cd_meta (chave, valor) VALUES ('faturamento_aba', 'ok')");
    await c.query("COMMIT");
    if (enc.rowCount) console.log("[migrate] " + enc.rowCount + " nota(s) que estavam no faturamento foram encerradas (o fluxo da nota termina no picking).");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Mesas: cada etapa e um perfil. Os perfis agrupados antigos viram as mesas equivalentes (ninguem perde acesso).
async function migrarMesas() {
  const r = await pool.query(
    `UPDATE users SET cd_perfis = (
       SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM (
         SELECT unnest(CASE p
           WHEN 'doca' THEN ARRAY['recebimento','separacao','contagem']
           WHEN 'estilo' THEN ARRAY['referencia']
           WHEN 'cadastro' THEN ARRAY['etiquetas','pedido','entrada','checkout','confronto']
           WHEN 'expedicao' THEN ARRAY['distribuicao','picking','faturamento']
           ELSE ARRAY[p] END) AS x
         FROM unnest(cd_perfis) AS p) q)
     WHERE cd_perfis && ARRAY['doca','estilo','cadastro','expedicao']`);
  if (r.rowCount) console.log("[migrate] Perfis do CD convertidos para mesas (" + r.rowCount + " usuario(s)).");
}

// Contagem, referencia e etiquetas rodam em paralelo: notas que ja estavam na frente liberam as etapas seguintes da frente.
async function migrarParalela() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(7003)");
    const jaFeito = await c.query("SELECT 1 FROM cd_meta WHERE chave = 'paralela_v1'");
    if (jaFeito.rows.length) { await c.query("COMMIT"); return; }
    await c.query(
      `UPDATE cd_nota_etapas e SET liberada_em = now()
         FROM cd_notas n
        WHERE e.nota_id = n.id AND n.status = 'aberta' AND e.status = 'pendente' AND e.liberada_em IS NULL
          AND e.etapa IN (3, 4, 5) AND n.etapa_atual BETWEEN 3 AND 5`);
    await c.query("INSERT INTO cd_meta (chave, valor) VALUES ('paralela_v1', 'ok')");
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


// ---------- Chamados das lojas para o DP ----------
const SEED_ASSUNTOS = [
  // nome, categoria, descricao, SLA 1ª resposta (min úteis), SLA resolução (min úteis; 600 = 1 dia útil), exige colaborador
  ["Contracheque e folha de pagamento", "Folha", "Dúvida sobre valores, descontos, adiantamento ou contracheque não recebido.", 240, 1200, true],
  ["Ajuste de ponto e banco de horas", "Ponto", "Esquecimento de batida, ponto errado, horas extras e saldo do banco de horas.", 240, 1200, true],
  ["Férias", "Férias", "Programação, pedido, recibo e dúvidas sobre férias.", 240, 1800, true],
  ["Atestado médico e afastamento", "Saúde", "Envio de atestado, afastamento, licença e retorno ao trabalho.", 120, 600, true],
  ["Admissão (novo colaborador)", "Admissão", "Documentos e dados para admitir um novo colaborador.", 120, 1200, true],
  ["Demissão e rescisão", "Desligamento", "Pedido de demissão, desligamento, homologação e rescisão.", 120, 1800, true],
  ["Vale-transporte", "Benefícios", "Solicitação, alteração ou problema com o vale-transporte.", 240, 1200, true],
  ["Vale-alimentação / refeição", "Benefícios", "Dúvidas ou problemas com o vale-alimentação ou refeição.", 240, 1200, true],
  ["Plano de saúde e outros benefícios", "Benefícios", "Inclusão, exclusão e dúvidas de plano de saúde e demais benefícios.", 240, 1800, true],
  ["Comissão e metas", "Remuneração", "Dúvidas sobre cálculo de comissão, metas e premiações.", 240, 1800, false],
  ["Escala e jornada de trabalho", "Jornada", "Alterações de escala, folgas, trocas de turno e jornada.", 240, 1200, false],
  ["Advertência e ocorrência disciplinar", "Relações trabalhistas", "Registro, orientação e dúvidas sobre advertências e ocorrências.", 240, 1800, true],
  ["Declarações e documentos", "Documentos", "Declaração de trabalho, de renda, 2ª via de documentos.", 240, 1200, true],
  ["Alteração de dados cadastrais", "Cadastro", "Mudança de endereço, banco, dependentes e outros dados do colaborador.", 240, 1200, true],
  ["Outros assuntos de DP", "Geral", "Qualquer outro assunto de Departamento Pessoal.", 480, 2400, false],
];
// Lojas da relação oficial (planilha Lojas): nome, responsável regional, região, UF, cidade, endereço, CEP.
const SEED_LOJAS = [["PARK MACEIO","Dimy","Nordeste","AL","Maceio","AV COMENDADOR GUSTAVO PAIVA, 5945, LOJA 1066","57038-000"],["MANAUARA","Dimy","Norte","AM","Manaus","AV MARIO YPIRANGA, 1300, ANDAR TACUMA LJ 78","69057-002"],["SUMAUMA","Dimy","Norte","AM","Manaus","AV NOEL NUTELS, 1762, LOJA 3040 3041 E 3042","69095-000"],["PONTA NEGRA","Dimy","Norte","AM","Manaus","AV CORONEL TEIXEIRA, 5705, LOJA L43.2","69037-000"],["OUTLET SALVADOR","Silvia","Nordeste","BA","Camacari","ESTRADA DO COCO, SN, KM 125 OUTLET PREM SALVADOR LOJA","42840-971"],["PARQUE SHOPPING BAHIA","Silvia","Nordeste","BA","Lauro de Freitas","AV SANTOS DUMONT, 4360, LOJA 1032 E 1033","42702-400"],["SALVADOR SHOPPING","Silvia","Nordeste","BA","Salvador","AV TANCREDO NEVES, 2915, LOJA 2005","41820-021"],["SHOPPING BARRA SALVADOR","Silvia","Nordeste","BA","Salvador","AVENIDA CENTENARIO, 2992, LOJA 254","41140-400"],["BELA VISTA","Silvia","Nordeste","BA","Salvador","ALAMEDA EUVALDO LUZ, 92, LJ 57 PISO 1","41098-020"],["SHOPPING PARALELA BAHIA","Silvia","Nordeste","BA","Salvador","AV LUIS VIANA FILHO, 8544, A107 PISO L1","41730-101"],["IGUATEMI SALVADOR","Silvia","Nordeste","BA","Salvador","AVENIDA TANCREDO NEVES, 148, QUADRA A","41820-908"],["OUTLET FORTALEZA","Duda","Nordeste","CE","Caucaia","AV VEREADOR FRANCISCO PESSOA DE LIMA, 445, LOJA 35,36 E 37","61663-020"],["SH IGUATEMI FORTALEZA","Duda","Nordeste","CE","Fortaleza","AV WASHINGTON SOARES, 85, LOJA 96 E 97","60811-341"],["PARK SHOPPING BSB","Silvia","Centro-Oeste","DF","Brasilia","SRIA SMAS TR 1, SN, LOTE A LOJA 218","71219-900"],["TAGUATINGA","Silvia","Centro-Oeste","DF","Brasilia","QS  R 210 LOTE 40, 01, LOJAS 3056/3057/30","71950-904"],["BRASILIA SH","Silvia","Centro-Oeste","DF","Brasilia","SCN QUADRA, 05, BLOCO A LOJA 44C 48C","70715-900"],["CNB","Silvia","Centro-Oeste","DF","Brasilia","SD N CONJUNTO A LOJAS, 2064","70077-900"],["TERRACO SHOPPING BSB","Silvia","Centro-Oeste","DF","Brasilia","SHC AOS EA 02 08 5, SN, LOJA 205","70660-900"],["PATIO DF","Silvia","Centro-Oeste","DF","Brasilia","USUARIO PATIO BRASIL SHOPPING, SN, LOJA 2P 2 PAVIMENTO PARTE LOJA P228","70307-902"],["VENANCIO","Silvia","Centro-Oeste","DF","Brasilia","SCS QD 08 BL0CO B, 60, LOJAS 92 E 93","70333-900"],["JK BRASILIA","Silvia","Centro-Oeste","DF","Brasilia","QUADRA QNM 34  AREA ESPECIAL 1, SN","72145-450"],["ALAMEDA","Silvia","Centro-Oeste","DF","Brasilia","Q CSB 02 LOTES 1 A 4, SN, LOJA T08 - 08A TERREO","72015-901"],["BOULEVARD BRASILIA","Silvia","Centro-Oeste","DF","Brasilia","SETOR STN, SN, CONJUNTO J LOJA T 63 TERREO","70770-100"],["VILA VELHA 2","Duda","Sudeste","ES","Vila Velha","RUA LUCIANO DAS NEVES  SH VILA VELHA, 2418, LOJA 2008 PAV 03","29107-900"],["PRAIA DA COSTA","Duda","Sudeste","ES","Vila Velha","AV OLIVIO LIRA DR, 353, LJ 104 AB L1","29101-950"],["OUTLET PREMIUM","Silvia","Centro-Oeste","GO","Alexania","RODOVIA BR 060, SN, KM 22 OUTLET PREMIUN BRASILIA  LJ 1034","72930-000"],["SHOPPING ILHA","Dimy","Nordeste","MA","Sao Luis","AV DANIEL DE LA TOUCHE, 987, LOJA 211 I PISO L2","65074-115"],["BH SHOPPING","Renata","Sudeste","MG","Belo Horizonte","ROD BR TREZENTOS E CINQUENTA E SEIS, 3049, LOJA BH 21 E 22","30320-900"],["MINAS SHOPPING","Renata","Sudeste","MG","Belo Horizonte","AVENIDA CRISTIANO MACHADO, 4000, LOJA 254 E 255 2 PISO","31910-900"],["DEL REY","Renata","Sudeste","MG","Belo Horizonte","AVENIDA PRESIDENTE CARLOS LUZ, 3001, LOJA 2075","31250-900"],["OUTLET SO MARCAS CONTAGEM","Renata","Sudeste","MG","Contagem","AV CARDEAL EUGENIO PACELLI, 1336, LUC 409","32210-002"],["ITAU POWER","Renata","Sudeste","MG","Contagem","AVENIDA GENERAL DAVID SARNOFF, 5160, LOJA 106","32210-901"],["SERRASUL SHOPPING","Duda","Sudeste","MG","Pouso Alegre","RODOVIA JK BR 459, SN, PISO 1 LJ 92 A 95 106 A 109","37556-140"],["CAMPO GRANDE","Renata","Centro-Oeste","MS","Campo Grande","AVENIDA AFONSO PENA, 4909, L301","79040-010"],["PANTANAL","Renata","Centro-Oeste","MT","Cuiaba","AVENIDA HISTORIADOR RUBENS DE MENDONCA, 3300, ESC N 2097 2098  2 PISO","78050-250"],["METROPOLE ANANINDEUA","Dimy","Norte","PA","Ananindeua","ROD BR-316, 4500, KM 04 207 GH L2","67015-220"],["PATIO BELEM","Dimy","Norte","PA","Belem","TV PADRE EUTIQUIO, 1078, LOJA 132","66023-710"],["BOULEVARD BELEM","Dimy","Norte","PA","Belem","AV VISCONDE DE SOUZA FRANCO, 776, LOJA 222","66053-000"],["MANAIRA","Dimy","Nordeste","PB","Joao Pessoa","R MANOEL ARRUDA CAVALCANTI, 805, SALA T0110 T0111 T0112","58038-680"],["SHOPPING RIO MAR","Dimy","Nordeste","PE","Recife","AVENIDA REPÚBLICA DO LÍBANO, 251, SALAO COMERCIAL N1154 PISO LI","51110-160"],["OUTLET CAMPO LARGO","Tati","Sul","PR","Campo Largo","RODOVIA BR-277, KM 122, 1005 E 1006","83604-175"],["SH PARK SHOPPING BARIGUI","Tati","Sul","PR","Curitiba","R PROFESSOR PEDRO VIRIATO P. SOUZA, 600, LUC 288","81200-100"],["PALLADIUM CURITIBA","Tati","Sul","PR","Curitiba","AV PRESIDENTE KENNEDY, 4121, LOJA 1005","80610-905"],["JOCKEY PLAZA","Tati","Sul","PR","Curitiba","AVENIDA VICTOR FERREIRA DO AMA, 2633, - DE 2361/2362 AO FIM","82810-350"],["PARK SHOPPING JPA","Beth","Sudeste","RJ","Rio de Janeiro","EST DE JACAREPAGUA, 6069, LUC 220 B","22753-033"],["PARK CAMPO GRANDE","Renata","Sudeste","RJ","Rio de Janeiro","ESTRADA DO MONTEIRO, 1200, LOJA 101 C/E/F","23045-830"],["PLAZA NITEROI","Dimy","Sudeste","RJ","Niteroi","R QUINZE DE NOVEMBRO, 8, LOJA 345 E 346","24020-125"],["OUTLET CATARINA","Luciane","Sudeste","SP","Sao Roque","RUA RAFAEL DIAS COSTA, 140, SUC L41 E L42","18132-852"],["SHOPPING TIJUCA 2","Tati","Sudeste","RJ","Rio de Janeiro","AV MARACANA, 987, LOJA 1031 1032 1033","20511-000"],["BARRA SH","Silvia","Sudeste","RJ","Rio de Janeiro","AV DAS AMERICAS, 4666, LOJA 219 C","22640-102"],["LEBLON","Silvia","Sudeste","RJ","Rio de Janeiro","R JOSE LINHARES, 85, LOJA A","22430-220"],["TAUBATE VIA VALE","Bianca","Sudeste","SP","Taubate","AVENIDA DOM PEDRO I, 7181, LOJA 28 - 29 PISO L1","12091-000"],["MOREIRA CESAR","Dimy","Sudeste","RJ","Niteroi","R CORONEL MOREIRA CESAR, 261, LOJA 101 BS","24230-052"],["CABO FRIO","Dimy","Sudeste","RJ","Cabo Frio","RUA HENRIQUE TERRA, 1700","28911-320"],["OUTLET PREMIUM CAXIAS","Bianca","Sudeste","RJ","Duque de Caxias","AV DONA TEREZA CRISTINA, 2000, LOJA 1027 CHACARA RIO PETROPOLIS","25230-480"],["WEST SHOPPING","Renata","Sudeste","RJ","Rio de Janeiro","EST DO MENDANHA, 555, LOJA 184","23087-283"],["OUTLET PREMIUM SAO PAULO","Renata","Sudeste","SP","Itupeva","EST JOAQUIM BUENO NETO, SN, 33 A","13295-000"],["IBIRAPUERA 2","Luciane","Sudeste","SP","Sao Paulo","AVENIDA IBIRAPUERA, 3103, LUC 009 PVMT IBIRAPUERA","04029-902"],["SH RIO SUL","Tati","Sudeste","RJ","Rio de Janeiro","AV LAURO SODRE, 445, LOJA 301 PARTE C LOJA 33 C D","22290-070"],["PARK SHOPPING SAO CAETANO","Luciane","Sudeste","SP","Sao Caetano do Sul","ALAMEDA TERRACOTA, 545, LOJA 1085 E 1086.","09531-190"],["NOVA AMERICA","Bianca","Sudeste","RJ","Rio de Janeiro","AV PASTOR MARTIN LUTHER KING JR, 126, LOJA O BLOCO 1","20765-000"],["MADUREIRA","Bianca","Sudeste","RJ","Rio de Janeiro","ESTRADA DO PORTELA, 222, - ATÉ 279 - LADO ÍMPAR","21351-050"],["SH SP MARKET","Luciane","Sudeste","SP","Sao Paulo","AV DAS NACOES UNIDAS, 22540, UNIDADE A6 10A","04795-921"],["MOOCA","Luciane","Sudeste","SP","Sao Paulo","RUA CAPITAO PACHECO E CHAVES, 313, LOJA 2055 SMO02053","03126-000"],["RIBEIRAO PRETO SHOPPING","Duda","Sudeste","SP","Ribeirao Preto","AV CORONEL FERNANDO FERREIRA LEITE, 1540, LJ LUC 115 E 116","14026-900"],["SH METROPOLITANO","Dimy","Sudeste","RJ","Rio de Janeiro","AV NS PAA10292 PAL38883, 135, LOJA 1096 LOJA 1095B","22775-027"],["RIO DESIGN BARRA","Silvia","Sudeste","RJ","Rio de Janeiro","AV DAS AMERICAS, 7777, LUC 223 A","22793-081"],["VOGUE","Duda","Sudeste","RJ","Rio de Janeiro","AV DAS AMERICAS, 8585, LOJAS 111 112 132 133","22793-081"],["ANALIA FRANCO","Luciane","Sudeste","SP","Sao Paulo","AVENIDA REGENTE FEIJO, 1739, LJ LUC OQ 67 E 68","03342-900"],["DOM PEDRO","Renata","Sudeste","SP","Campinas","AVENIDA GUILHERME CAMPOS, 500, GLEBA 030 QUARTEIRAO 30013 EUC20 PISO TERREO","13087-901"],["SH JUNDIAI SHOPPING","Renata","Sudeste","SP","Jundiai","AV NOVE DE JULHO, 3333, LUC 118 A 121 L1","13208-056"],["BUZIOS","Dimy","Sudeste","RJ","Armacao dos Buzios","",""],["SAARA","Beth","Sudeste","RJ","Rio de Janeiro","R GONCALVES LEDO, 101","20060-020"],["PARK SUL VOLTA REDONDA","Bianca","Sudeste","RJ","Volta Redonda","ROD TANCREDO NEVES, 1189, LOJA 95 96 E 97","27253-005"],["MIDWAY","Dimy","Nordeste","RN","Natal","AV BERNARDO VIEIRA, 3775, BLOCO UNICO LOJA 357A LOJA 358 LOJA 358A BLOCO L3","59015-900"],["PATIO RORAIMA","Dimy","Norte","RR","Boa Vista","AVENIDA JOAO ALENCAR, 2181, LOJA 204 RST","69311-137"],["SH PARK SHOPPING CANOAS","Tati","Sul","RS","Canoas","AV FARROUPILHA, 4545, LUC 2057 B2 B3 D1 A D4 L2","92020-475"],["SH BARRA SHOPPING SUL","Tati","Sul","RS","Porto Alegre","AV DIARIO DE NOTICIAS, 300, LUC 1015 E 1016","90810-080"],["FLORIPA","Tati","Sul","SC","Florianopolis","ROD VIRGILIO VARZEA, 587, AREA 2 LOJA 237 L2","88032-000"],["IGUATEMI","Tati","Sudeste","RJ","Rio de Janeiro","R BARAO DE SAO FRANCISCO, 236, LOJA 1 017 1 PISO","20560-032"],["COPACABANA 897","Duda","Sudeste","RJ","Rio de Janeiro","AV NOSSA SENHORA DE COPACABANA, 897, LOJA A","22050-002"],["SULACAP T","Beth","Sudeste","RJ","Rio de Janeiro","AV MARECHAL FONTENELE, 3545, LOTE 1 LJ 223, 224, 225 E 226","21750-000"],["TOP SHOPPING","Bianca","Sudeste","RJ","Nova Iguacu","AV GOVERNADOR ROBERTO SILVEIRA, 540, LOJA 316","26210-210"],["GRAND PLAZA","Luciane","Sudeste","SP","Santo Andre","AV INDUSTRIAL, 600, LOJA 531 532","09080-500"],["SANTA URSULA RIBEIRAO","Duda","Sudeste","SP","Ribeirao Preto","R SAO JOSE, 933, LOJA 45 E 46","14010-160"],["AMERICAS SHOPPING","Renata","Sudeste","RJ","Rio de Janeiro","AV DAS AMERICAS, 15500, LOJA 139 LOJA 140","22790-702"],["RECREIO","Renata","Sudeste","RJ","Rio de Janeiro","AV DAS AMERICAS, 19019, LOJA 109A21","22790-703"],["SH GOLDEN SQUARE","Luciane","Sudeste","SP","Sao Bernardo do Campo","AV KENNEDY, 700, LOJA 134A 134B","09726-253"],["SH TAQUARA PLAZA","Tati","Sudeste","RJ","Rio de Janeiro","EST RODRIGUES CALDAS, 127, SUC 201B PISO 2","22713-372"],["SH MOGI SHOPPING","Renata","Sudeste","SP","Mogi das Cruzes","AV VEREADOR NARCISO YAGUE GUIMARAES, 1001, LUC 328","08780-910"],["CAXIAS","Renata","Sudeste","RJ","Duque de Caxias","ROD WASHINGTON LUIZ, 2895, LOJA 203 A","25085-008"],["ILHA PLAZA","Beth","Sudeste","RJ","Rio de Janeiro","AV MAESTRO PAULO SILVA, 400, LOJA C PAV L3 ESP COM 35","21920-445"],["SH VILA OLIMPIA","Luciane","Sudeste","SP","Sao Paulo","R OLIMPIADAS, 360, LUC 238 A 241 PISO 1","04551-000"],["OUTLET PREMIUM ITAQUA","Renata","Sudeste","SP","Itaquaquecetuba","EST SAO BENTO, 9550, LT GL H LOJA 102","08599-450"],["PURPOSE AEROTOWN","Duda","Sudeste","RJ","Rio de Janeiro","AV AYRTON SENNA, 2541, BLC A1 LOJAS 24 E 25","22775-002"],["AEROTOWN","Duda","Sudeste","RJ","Rio de Janeiro","AV AYRTON SENNA, 2541, BLC A1 LOJAS 24 E 25","22775-002"]];

// Departamentos que atendem as lojas (cada um com equipe, assuntos e e-mail próprios).
const SEED_DEPARTAMENTOS = [["dp", "DP", 1], ["logistica", "Logística", 2], ["manutencao", "Manutenção", 3]];
// Almoxarifado (Logística): insumos de uso da loja, que não são mercadoria para venda.
const SEED_ALMOXARIFADO = [
  ["Almoxarifado: solicitação de insumos", "Almoxarifado", "Pedido de insumos e materiais de uso da loja: papel higiênico, papel toalha, detergente, sabão, sacos de lixo, copos, material de limpeza, material de escritório e similares. Informe os itens e as quantidades.", 240, 1800, false],
  ["Almoxarifado: falta ou divergência de insumos recebidos", "Almoxarifado", "Insumos que chegaram faltando, em quantidade diferente do pedido, danificados ou trocados.", 240, 1800, false],
];
const SEED_ASSUNTOS_LOGISTICA = [
  // nome, categoria, descricao, SLA 1ª resposta (min úteis), SLA resolução (min úteis; 600 = 1 dia útil), exige colaborador
  ["Falta ou divergência no recebimento", "Recebimento", "Mercadoria recebida diferente da nota ou do romaneio: faltou peça, sobrou peça ou veio item errado.", 240, 1200, false],
  ["Reposição de produtos (ressuprimento)", "Reposição", "Pedido de reposição de grade, tamanho ou cor em falta na loja.", 240, 1800, false],
  ["Avaria ou extravio no transporte", "Transporte", "Caixa danificada, peça avariada ou volume extraviado na entrega.", 240, 1800, false],
  ["Devolução de mercadoria ao CD", "Devolução", "Solicitação de coleta e devolução de mercadoria ao Centro de Distribuição.", 240, 1800, false],
  ["Transferência entre lojas", "Transferência", "Envio ou recebimento de peças entre lojas.", 240, 1800, false],
  ["Atraso ou rastreio de entrega", "Transporte", "Acompanhamento e previsão de chegada de mercadoria em trânsito.", 120, 600, false],
  ["Etiquetas, cabides e embalagens", "Materiais", "Falta de etiquetas, cabides, sacolas ou outros materiais de embalagem.", 240, 1800, false],
  ...SEED_ALMOXARIFADO,
  ["Outros assuntos de Logística", "Geral", "Qualquer outro assunto de Logística.", 480, 2400, false],
];
const SEED_ASSUNTOS_MANUTENCAO = [
  ["Ar-condicionado", "Climatização", "Não gela, vazamento, barulho ou limpeza do ar-condicionado.", 120, 1200, false],
  ["Iluminação e parte elétrica", "Elétrica", "Lâmpadas, spots, trilhos, tomadas e quadro de energia.", 120, 1200, false],
  ["Hidráulica e vazamentos", "Hidráulica", "Vazamento, infiltração, vaso, pia, torneira ou ralo entupido.", 120, 900, false],
  ["Vitrine, mobiliário e araras", "Mobiliário", "Reparo de araras, prateleiras, balcão, provador, espelhos e vitrine.", 240, 1800, false],
  ["Fachada, letreiro e comunicação visual", "Fachada", "Letreiro apagado ou danificado, adesivos e placas.", 240, 2400, false],
  ["Pintura, piso e pequenas reformas", "Reformas", "Pintura, piso, forro e pequenos reparos de obra.", 480, 3000, false],
  ["Segurança, alarme, câmeras e fechaduras", "Segurança", "Alarme, CFTV, porta de aço, fechaduras e chaves.", 120, 1200, false],
  ["Limpeza e controle de pragas", "Limpeza", "Limpeza pesada, dedetização e controle de pragas.", 240, 1200, false],
  ["Outros assuntos de Manutenção", "Geral", "Qualquer outro assunto de Manutenção.", 480, 2400, false],
];

async function migrarChamados() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS ch_assuntos (
  id                 BIGSERIAL PRIMARY KEY,
  nome               TEXT NOT NULL,
  categoria          TEXT,
  descricao          TEXT,
  sla_resposta_min   INTEGER NOT NULL DEFAULT 240,
  sla_resolucao_min  INTEGER NOT NULL DEFAULT 1200,
  exige_colaborador  BOOLEAN NOT NULL DEFAULT false,
  ativo              BOOLEAN NOT NULL DEFAULT true,
  ordem              INTEGER NOT NULL DEFAULT 0,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ch_lojas (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  codigo        TEXT,
  email         TEXT NOT NULL,
  emails_copia  TEXT[] NOT NULL DEFAULT '{}',
  ativa         BOOLEAN NOT NULL DEFAULT true,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ch_lojas_email_uq ON ch_lojas (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS ch_lojas_nome_uq ON ch_lojas (lower(nome));
ALTER TABLE ch_lojas ALTER COLUMN email DROP NOT NULL;
ALTER TABLE ch_lojas ADD COLUMN IF NOT EXISTS regional TEXT;
ALTER TABLE ch_lojas ADD COLUMN IF NOT EXISTS regiao TEXT;
ALTER TABLE ch_lojas ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE ch_lojas ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE ch_lojas ADD COLUMN IF NOT EXISTS endereco TEXT;
ALTER TABLE ch_lojas ADD COLUMN IF NOT EXISTS cep TEXT;
-- Segurança de acesso: troca de senha obrigatória, encerramento de sessões e auditoria.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trocar_senha BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS senha_alterada_em TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS ch_auditoria (
  id          BIGSERIAL PRIMARY KEY,
  quando      TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario     TEXT,
  papel       TEXT,
  acao        TEXT NOT NULL,
  chamado_id  BIGINT,
  anexo_id    BIGINT,
  alvo        TEXT,
  detalhe     TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS ch_auditoria_quando_idx ON ch_auditoria (quando DESC);
CREATE INDEX IF NOT EXISTS ch_auditoria_chamado_idx ON ch_auditoria (chamado_id);
CREATE INDEX IF NOT EXISTS ch_auditoria_usuario_idx ON ch_auditoria (lower(usuario));
CREATE TABLE IF NOT EXISTS ch_equipe (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  nome       TEXT,
  papel      TEXT NOT NULL DEFAULT 'dp',      -- 'dp' (atende) ou 'gestor' (atende + configura)
  ativo      BOOLEAN NOT NULL DEFAULT true,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ch_equipe_email_uq ON ch_equipe (lower(email));
CREATE TABLE IF NOT EXISTS ch_config (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS ch_chamados (
  id                    BIGSERIAL PRIMARY KEY,
  protocolo             TEXT UNIQUE,
  loja_id               BIGINT NOT NULL REFERENCES ch_lojas(id),
  assunto_id            BIGINT REFERENCES ch_assuntos(id) ON DELETE SET NULL,
  assunto_nome          TEXT NOT NULL,
  descricao             TEXT NOT NULL,
  prioridade            TEXT NOT NULL DEFAULT 'normal',
  colaborador           TEXT,
  data_ref              DATE,
  status                TEXT NOT NULL DEFAULT 'aberto',  -- aberto | em_atendimento | aguardando_loja | resolvido | cancelado
  aberto_por            TEXT,
  atribuido_a           TEXT,
  sla_resposta_min      INTEGER NOT NULL,
  sla_resolucao_min     INTEGER NOT NULL,
  primeira_resposta_em  TIMESTAMPTZ,
  resolvido_em          TIMESTAMPTZ,
  reaberturas           INTEGER NOT NULL DEFAULT 0,
  pausado_desde         TIMESTAMPTZ,
  pausa_acum_min        NUMERIC(12,1) NOT NULL DEFAULT 0,
  cc_emails             TEXT[] NOT NULL DEFAULT '{}',
  ultima_msg_autor      TEXT,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ch_chamados_loja_idx ON ch_chamados (loja_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ch_chamados_status_idx ON ch_chamados (status, criado_em DESC);
CREATE TABLE IF NOT EXISTS ch_mensagens (
  id           BIGSERIAL PRIMARY KEY,
  chamado_id   BIGINT NOT NULL REFERENCES ch_chamados(id) ON DELETE CASCADE,
  autor_email  TEXT NOT NULL,
  autor_nome   TEXT,
  autor_tipo   TEXT NOT NULL,                      -- loja | dp
  texto        TEXT NOT NULL,
  interno      BOOLEAN NOT NULL DEFAULT false,     -- nota interna do DP: a loja não vê e não recebe e-mail
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ch_mensagens_chamado_idx ON ch_mensagens (chamado_id, criado_em);
CREATE TABLE IF NOT EXISTS ch_anexos (
  id           BIGSERIAL PRIMARY KEY,
  chamado_id   BIGINT NOT NULL REFERENCES ch_chamados(id) ON DELETE CASCADE,
  mensagem_id  BIGINT REFERENCES ch_mensagens(id) ON DELETE CASCADE,
  nome         TEXT NOT NULL,
  tipo         TEXT,
  tamanho      INTEGER NOT NULL,
  conteudo     BYTEA NOT NULL,
  criado_por   TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ch_anexos_chamado_idx ON ch_anexos (chamado_id);
CREATE TABLE IF NOT EXISTS ch_eventos (
  id          BIGSERIAL PRIMARY KEY,
  chamado_id  BIGINT NOT NULL REFERENCES ch_chamados(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,
  usuario     TEXT,
  detalhe     JSONB,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ch_eventos_chamado_idx ON ch_eventos (chamado_id, criado_em);
CREATE TABLE IF NOT EXISTS ch_emails (
  id              BIGSERIAL PRIMARY KEY,
  chamado_id      BIGINT REFERENCES ch_chamados(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  destino         TEXT NOT NULL,
  assunto         TEXT,
  status          TEXT NOT NULL,                   -- enviado | falhou | pulado
  erro            TEXT,
  provedor_id     TEXT,
  conteudo_html   TEXT,
  conteudo_texto  TEXT,
  tentativas      INTEGER NOT NULL DEFAULT 1,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ch_emails_chamado_idx ON ch_emails (chamado_id);
`);
  // ---- Departamentos (DP, Logística, Manutenção): colunas, preenchimento dos dados que já existiam (tudo era do DP) e índices ----
  await pool.query(`
CREATE TABLE IF NOT EXISTS ch_departamentos (
  id      BIGSERIAL PRIMARY KEY,
  codigo  TEXT NOT NULL,
  nome    TEXT NOT NULL,
  emails  TEXT NOT NULL DEFAULT '',
  ativo   BOOLEAN NOT NULL DEFAULT true,
  ordem   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ch_departamentos_codigo_uq ON ch_departamentos (codigo);
`);
  for (const [codigo, nome, ordem] of SEED_DEPARTAMENTOS) await pool.query("INSERT INTO ch_departamentos (codigo, nome, ordem) VALUES ($1,$2,$3) ON CONFLICT (codigo) DO NOTHING", [codigo, nome, ordem]);
  await pool.query(`
ALTER TABLE ch_assuntos  ADD COLUMN IF NOT EXISTS departamento_id BIGINT REFERENCES ch_departamentos(id);
ALTER TABLE ch_equipe    ADD COLUMN IF NOT EXISTS departamento_id BIGINT REFERENCES ch_departamentos(id);
ALTER TABLE ch_chamados  ADD COLUMN IF NOT EXISTS departamento_id BIGINT REFERENCES ch_departamentos(id);
UPDATE ch_assuntos SET departamento_id = (SELECT id FROM ch_departamentos WHERE codigo = 'dp') WHERE departamento_id IS NULL;
UPDATE ch_equipe   SET departamento_id = (SELECT id FROM ch_departamentos WHERE codigo = 'dp') WHERE departamento_id IS NULL;
UPDATE ch_chamados SET departamento_id = (SELECT id FROM ch_departamentos WHERE codigo = 'dp') WHERE departamento_id IS NULL;
ALTER TABLE ch_assuntos ALTER COLUMN departamento_id SET NOT NULL;
ALTER TABLE ch_equipe   ALTER COLUMN departamento_id SET NOT NULL;
ALTER TABLE ch_chamados ALTER COLUMN departamento_id SET NOT NULL;
DROP INDEX IF EXISTS ch_assuntos_nome_uq;
CREATE UNIQUE INDEX IF NOT EXISTS ch_assuntos_dep_nome_uq ON ch_assuntos (departamento_id, lower(nome));
CREATE INDEX IF NOT EXISTS ch_chamados_dep_idx ON ch_chamados (departamento_id, status);
`);
  // e-mails de aviso que já estavam cadastrados para o DP passam para o departamento DP
  await pool.query(`UPDATE ch_departamentos d SET emails = c.valor FROM ch_config c WHERE c.chave = 'dp_emails' AND d.codigo = 'dp' AND d.emails = '' AND coalesce(c.valor,'') <> ''`);
  const { rows: dps } = await pool.query("SELECT id::int AS id, codigo FROM ch_departamentos");
  const depId = Object.fromEntries(dps.map((d) => [d.codigo, d.id]));
  const semearAssuntos = async (codigo, lista) => {
    const { rows: n } = await pool.query("SELECT count(*)::int AS n FROM ch_assuntos WHERE departamento_id = $1", [depId[codigo]]);
    if (n[0].n) return false;
    let ordem = 0;
    for (const [nome, cat, desc, r, s, ex] of lista) {
      await pool.query("INSERT INTO ch_assuntos (nome, categoria, descricao, sla_resposta_min, sla_resolucao_min, exige_colaborador, ordem, departamento_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [nome, cat, desc, r, s, ex, ++ordem, depId[codigo]]);
    }
    return true;
  };
  if (await semearAssuntos("dp", SEED_ASSUNTOS)) console.log("[chamados] Assuntos iniciais do DP criados (edite os prazos no painel).");
  if (await semearAssuntos("logistica", SEED_ASSUNTOS_LOGISTICA)) console.log("[chamados] Assuntos iniciais de Logística criados.");
  // Almoxarifado entra uma única vez nos bancos que já tinham a Logística (depois disso o gestor edita ou desativa à vontade).
  {
    const { rows: fl } = await pool.query("SELECT 1 FROM ch_config WHERE chave = 'seed_almoxarifado'");
    if (!fl.length) {
      const { rows: mx } = await pool.query("SELECT coalesce(max(ordem),0)::int AS m FROM ch_assuntos WHERE departamento_id = $1", [depId.logistica]);
      let ordem = mx[0].m, criados = 0;
      for (const [nome, cat, desc, r, s2, ex] of SEED_ALMOXARIFADO) {
        const ins = await pool.query("INSERT INTO ch_assuntos (nome, categoria, descricao, sla_resposta_min, sla_resolucao_min, exige_colaborador, ordem, departamento_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [nome, cat, desc, r, s2, ex, ++ordem, depId.logistica]);
        criados += ins.rowCount;
      }
      if (criados) {
        await pool.query("UPDATE ch_assuntos SET ordem = $2 WHERE departamento_id = $1 AND nome = 'Outros assuntos de Logística'", [depId.logistica, ordem + 1]);
        console.log("[chamados] Assuntos de Almoxarifado adicionados à Logística.");
      }
      await pool.query("INSERT INTO ch_config (chave, valor) VALUES ('seed_almoxarifado','1') ON CONFLICT (chave) DO NOTHING");
    }
  }
  if (await semearAssuntos("manutencao", SEED_ASSUNTOS_MANUTENCAO)) console.log("[chamados] Assuntos iniciais de Manutenção criados.");
  // Lojas: insere as que ainda não existem (pelo nome) e completa os dados de cadastro das que já existem.
  let novas = 0;
  for (const [nome, regional, regiao, uf, cidade, endereco, cep] of SEED_LOJAS) {
    const r = await pool.query(
      `INSERT INTO ch_lojas (nome, regional, regiao, uf, cidade, endereco, cep) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (lower(nome)) DO UPDATE SET regional = COALESCE(ch_lojas.regional, EXCLUDED.regional), regiao = COALESCE(ch_lojas.regiao, EXCLUDED.regiao),
         uf = COALESCE(ch_lojas.uf, EXCLUDED.uf), cidade = COALESCE(ch_lojas.cidade, EXCLUDED.cidade), endereco = COALESCE(ch_lojas.endereco, EXCLUDED.endereco), cep = COALESCE(ch_lojas.cep, EXCLUDED.cep)
       RETURNING (xmax = 0) AS nova`,
      [nome, regional || null, regiao || null, uf || null, cidade || null, endereco || null, cep || null]);
    if (r.rows[0] && r.rows[0].nova) novas++;
  }
  if (novas) console.log("[chamados] " + novas + " loja(s) cadastrada(s) a partir da relação oficial (cadastre o e-mail de cada uma em Cadastros > Lojas).");
}


// ---------- Admissão e Rescisão ----------
// nome, descrição, área, prazo (minutos úteis; 600 = 1 dia útil)
const SEED_ETAPAS_ADM = {
  admissao: [
    ["Solicitação recebida e validada", "Vaga aprovada e dados do candidato, cargo, local, horário e data de início confirmados.", "Gestor / DP", 300],
    ["Documentos do candidato recebidos e conferidos", "Documentos pessoais, dados bancários, dependentes e demais documentos exigidos.", "DP", 1800],
    ["Exame admissional (ASO)", "Exame agendado, realizado e atestado de saúde ocupacional recebido.", "Saúde ocupacional", 1800],
    ["Cadastro na folha e registro no eSocial", "Cadastro do colaborador na folha e envio do registro ao eSocial antes do início das atividades.", "DP", 600],
    ["Contrato e documentos assinados", "Contrato de trabalho e termos assinados pelo colaborador.", "DP", 600],
    ["Benefícios e ponto", "Vale-transporte, vale-alimentação ou refeição, plano de saúde e cadastro no ponto.", "DP", 600],
    ["Integração, uniforme e acessos", "Integração, entrega de uniforme e liberação de acessos e sistemas.", "Loja / DP", 600],
  ],
  rescisao: [
    ["Comunicação recebida e motivo validado", "Pedido de demissão ou dispensa, tipo de rescisão, aviso prévio e data do término do contrato.", "Gestor / DP", 300],
    ["Exame demissional (ASO)", "Exame demissional agendado e realizado.", "Saúde ocupacional", 1200],
    ["Baixa em benefícios, ponto e acessos", "Cancelamento de vale-transporte, vale-alimentação ou refeição, plano de saúde, ponto e acessos.", "DP / Loja", 600],
    ["Cálculo das verbas rescisórias", "Cálculo do TRCT: saldo de salário, férias, 13º, aviso prévio, FGTS e descontos.", "DP / Contabilidade", 1200],
    ["Conferência e aprovação do cálculo", "Gestor confere e aprova o cálculo antes do pagamento.", "Gestor", 300],
    ["Pagamento e entrega dos documentos", "Pagamento das verbas e entrega do TRCT, guias do FGTS e do seguro-desemprego.", "Financeiro / DP", 900],
    ["Baixa na carteira, eSocial e arquivo", "Baixa na CTPS digital, envio do desligamento ao eSocial e arquivo do dossiê.", "DP", 600],
  ],
};
async function migrarAdmissao() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS adm_equipe (
      id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, nome TEXT, papel TEXT NOT NULL DEFAULT 'analista' CHECK (papel IN ('analista','gestor')),
      ativo BOOLEAN NOT NULL DEFAULT true, criado_em TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS adm_equipe_email_uq ON adm_equipe (lower(email));
    CREATE TABLE IF NOT EXISTS adm_etapas_modelo (
      id BIGSERIAL PRIMARY KEY, tipo TEXT NOT NULL CHECK (tipo IN ('admissao','rescisao')), nome TEXT NOT NULL, descricao TEXT, area TEXT,
      prazo_min INT NOT NULL CHECK (prazo_min > 0), ordem INT NOT NULL DEFAULT 0, ativo BOOLEAN NOT NULL DEFAULT true);
    CREATE UNIQUE INDEX IF NOT EXISTS adm_etapas_modelo_uq ON adm_etapas_modelo (tipo, lower(nome));
    CREATE TABLE IF NOT EXISTS adm_config (chave TEXT PRIMARY KEY, valor TEXT);
    CREATE SEQUENCE IF NOT EXISTS adm_proto_seq;
    CREATE TABLE IF NOT EXISTS adm_processos (
      id BIGSERIAL PRIMARY KEY, protocolo TEXT NOT NULL UNIQUE, tipo TEXT NOT NULL CHECK (tipo IN ('admissao','rescisao')),
      colaborador TEXT NOT NULL, cpf TEXT, cargo TEXT, loja_id BIGINT REFERENCES ch_lojas(id), unidade TEXT NOT NULL, subtipo TEXT,
      data_prevista DATE NOT NULL, observacao TEXT, responsavel TEXT,
      status TEXT NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento','pausado','concluido','cancelado')),
      sla_total_min INT NOT NULL CHECK (sla_total_min > 0), criado_por TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      concluido_em TIMESTAMPTZ, cancelado_motivo TEXT, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS adm_processos_status_idx ON adm_processos (status, criado_em DESC);
    CREATE INDEX IF NOT EXISTS adm_processos_cpf_idx ON adm_processos (cpf) WHERE cpf IS NOT NULL;
    CREATE TABLE IF NOT EXISTS adm_proc_etapas (
      id BIGSERIAL PRIMARY KEY, processo_id BIGINT NOT NULL REFERENCES adm_processos(id) ON DELETE CASCADE, modelo_id BIGINT,
      nome TEXT NOT NULL, descricao TEXT, area TEXT, ordem INT NOT NULL, prazo_min INT NOT NULL CHECK (prazo_min > 0),
      status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','concluida','dispensada')),
      concluida_em TIMESTAMPTZ, concluida_por TEXT, obs TEXT);
    CREATE INDEX IF NOT EXISTS adm_proc_etapas_proc_idx ON adm_proc_etapas (processo_id, ordem);
    CREATE TABLE IF NOT EXISTS adm_pausas (
      id BIGSERIAL PRIMARY KEY, processo_id BIGINT NOT NULL REFERENCES adm_processos(id) ON DELETE CASCADE,
      inicio TIMESTAMPTZ NOT NULL DEFAULT now(), fim TIMESTAMPTZ, motivo TEXT, usuario TEXT);
    CREATE INDEX IF NOT EXISTS adm_pausas_proc_idx ON adm_pausas (processo_id);
    CREATE TABLE IF NOT EXISTS adm_eventos (
      id BIGSERIAL PRIMARY KEY, processo_id BIGINT NOT NULL REFERENCES adm_processos(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL, usuario TEXT, detalhe JSONB, criado_em TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS adm_eventos_proc_idx ON adm_eventos (processo_id, criado_em);
  `);
  // etapas sugeridas: só entram quando o tipo ainda não tem nenhuma (depois o gestor edita à vontade)
  for (const tipo of Object.keys(SEED_ETAPAS_ADM)) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM adm_etapas_modelo WHERE tipo = $1", [tipo]);
    if (rows[0].n) continue;
    let ordem = 0;
    for (const [nome, desc, area, prazo] of SEED_ETAPAS_ADM[tipo]) {
      await pool.query("INSERT INTO adm_etapas_modelo (tipo, nome, descricao, area, prazo_min, ordem) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [tipo, nome, desc, area, prazo, ++ordem]);
    }
    console.log("[admissao] Etapas iniciais de " + tipo + " criadas (edite os prazos no painel).");
  }
}

async function migrate() {
  await pool.query(SQL);
  await migrarEtapas14();
  await migrarEtapas12();
  await migrarMesas();
  await migrarParalela();
  await migrarFaturamento();
  await migrarChamados();
  await migrarAdmissao();
  await semearCores();
  await seedAdmin();
  console.log("Migração concluída.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Erro na migração:", err);
  process.exit(1);
});
