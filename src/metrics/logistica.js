const { pool } = require("../db");

async function slaDeEntrega({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE shipping_actual_days IS NOT NULL) AS entregues,
       COUNT(*) FILTER (WHERE shipping_actual_days IS NOT NULL AND shipping_actual_days <= shipping_promised_days) AS no_prazo,
       AVG(shipping_actual_days) AS prazo_medio_real,
       AVG(shipping_promised_days) AS prazo_medio_prometido
     FROM orders
     WHERE ($1::timestamptz IS NULL OR creation_date >= $1)
       AND ($2::timestamptz IS NULL OR creation_date < $2)`,
    [dateFrom || null, dateTo || null]
  );
  const r = rows[0];
  const entregues = Number(r.entregues) || 0;
  const noPrazo = Number(r.no_prazo) || 0;
  return {
    entregues,
    noPrazoPct: entregues > 0 ? (noPrazo / entregues) * 100 : null,
    prazoMedioReal: r.prazo_medio_real ? Number(r.prazo_medio_real) : null,
    prazoMedioPrometido: r.prazo_medio_prometido ? Number(r.prazo_medio_prometido) : null,
  };
}

/**
 * Desempenho por loja/depósito OMNI: receita, unidades e pedidos atendidos por cada
 * loja física de onde o estoque do e-commerce é expedido. `warehouse_id` vem de
 * `shippingData.logisticsInfo` de cada pedido (ver syncVtex.js); itens sem loja
 * identificada (pedido sincronizado antes do backfill, ou sem OMNI) caem em "Não
 * identificado" em vez de sumir da soma.
 */
async function desempenhoLojas({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(oi.warehouse_id, '(sem-loja)') AS warehouse_id,
            COALESCE(w.name, oi.warehouse_id, 'Não identificado') AS loja,
            COALESCE(ov.state, w.state) AS loja_estado,
            SUM(oi.total_price) AS receita,
            SUM(oi.quantity) AS unidades,
            COUNT(DISTINCT oi.order_id) AS pedidos
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN warehouses w ON w.warehouse_id = oi.warehouse_id
     LEFT JOIN warehouse_state_overrides ov ON ov.warehouse_id = oi.warehouse_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.warehouse_id, w.name, w.state, ov.state
     ORDER BY receita DESC`,
    [dateFrom || null, dateTo || null]
  );
  const total = rows.reduce((sum, r) => sum + Number(r.receita), 0) || 1;
  return rows.map((r) => ({
    loja: r.loja,
    lojaEstado: r.loja_estado || null,
    receita: Number(r.receita),
    unidades: Number(r.unidades),
    pedidos: Number(r.pedidos),
    participacaoPct: (Number(r.receita) / total) * 100,
  }));
}

/**
 * Cruza cada loja/depósito com o estado de entrega dos pedidos que ela atendeu — permite
 * ver, por exemplo, se a loja de SP está mandando mais produto pra fora de SP do que
 * pra dentro. `mesmoEstado` compara o estado cadastrado da loja com o estado de destino
 * do pedido (region_state); vem null quando a loja não tem estado cadastrado na Vtex.
 */
async function lojaPorEstadoDestino({ dateFrom, dateTo } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(oi.warehouse_id, '(sem-loja)') AS warehouse_id,
            COALESCE(w.name, oi.warehouse_id, 'Não identificado') AS loja,
            COALESCE(ov.state, w.state) AS loja_estado,
            COALESCE(o.region_state, 'Não informado') AS estado_destino,
            SUM(oi.total_price) AS receita,
            SUM(oi.quantity) AS unidades,
            COUNT(DISTINCT oi.order_id) AS pedidos
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN warehouses w ON w.warehouse_id = oi.warehouse_id
     LEFT JOIN warehouse_state_overrides ov ON ov.warehouse_id = oi.warehouse_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY oi.warehouse_id, w.name, w.state, ov.state, o.region_state
     ORDER BY loja, receita DESC`,
    [dateFrom || null, dateTo || null]
  );
  return rows.map((r) => ({
    loja: r.loja,
    lojaEstado: r.loja_estado || null,
    estadoDestino: r.estado_destino,
    receita: Number(r.receita),
    unidades: Number(r.unidades),
    pedidos: Number(r.pedidos),
    mesmoEstado: r.loja_estado ? r.loja_estado === r.estado_destino : null,
  }));
}

/**
 * Lista todas as lojas/depósitos OMNI já conhecidos (sincronizados da Vtex ou apenas
 * vistos em pedidos), com o estado que a Vtex informou (quase sempre vazio, ver nota em
 * syncVtex.js) e o estado corrigido manualmente, se houver. Usado pela tela de admin
 * "Estados das lojas" — como a Vtex não expõe UF pros warehouses dessa conta, esse é o
 * jeito de informar (uma vez) de qual estado cada loja física realmente despacha.
 */
async function listLojaEstados() {
  const { rows } = await pool.query(
    `SELECT w.warehouse_id, w.name, w.city, w.state AS vtex_state, ov.state AS override_state
     FROM warehouses w
     LEFT JOIN warehouse_state_overrides ov ON ov.warehouse_id = w.warehouse_id
     UNION
     SELECT DISTINCT oi.warehouse_id, oi.warehouse_id AS name, NULL AS city, NULL AS vtex_state, ov.state AS override_state
     FROM order_items oi
     LEFT JOIN warehouses w ON w.warehouse_id = oi.warehouse_id
     LEFT JOIN warehouse_state_overrides ov ON ov.warehouse_id = oi.warehouse_id
     WHERE oi.warehouse_id IS NOT NULL AND w.warehouse_id IS NULL
     ORDER BY name`,
    []
  );
  return rows.map((r) => ({
    warehouseId: r.warehouse_id,
    nome: r.name || r.warehouse_id,
    cidade: r.city || null,
    estadoVtex: r.vtex_state || null,
    estadoManual: r.override_state || null,
    estadoAtual: r.override_state || r.vtex_state || null,
  }));
}

/** Define (ou remove, se state for vazio) a correção manual de estado de uma loja/depósito. */
async function setLojaEstado(warehouseId, state) {
  if (!warehouseId) {
    const err = new Error("Informe a loja (warehouseId).");
    err.status = 400;
    throw err;
  }
  const uf = (state || "").trim().toUpperCase();
  if (!uf) {
    await pool.query("DELETE FROM warehouse_state_overrides WHERE warehouse_id = $1", [warehouseId]);
    return { warehouseId, state: null };
  }
  if (!/^[A-Z]{2}$/.test(uf)) {
    const err = new Error("Estado inválido — use a sigla de 2 letras (ex: SP, RJ).");
    err.status = 400;
    throw err;
  }
  await pool.query(
    `INSERT INTO warehouse_state_overrides (warehouse_id, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (warehouse_id) DO UPDATE SET state = $2, updated_at = now()`,
    [warehouseId, uf]
  );
  return { warehouseId, state: uf };
}

// Reaproveita a mesma consulta de "Eficiência de Frete por Região" usada em Vendas,
// pois é a mesma métrica solicitada nas duas seções do dashboard.
const { eficienciaFretePorRegiao } = require("./vendas");

module.exports = {
  slaDeEntrega,
  eficienciaFretePorRegiao,
  desempenhoLojas,
  lojaPorEstadoDestino,
  listLojaEstados,
  setLojaEstado,
};
