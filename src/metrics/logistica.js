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
            w.state AS loja_estado,
            SUM(oi.total_price) AS receita,
            SUM(oi.quantity) AS unidades,
            COUNT(DISTINCT oi.order_id) AS pedidos
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN warehouses w ON w.warehouse_id = oi.warehouse_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY warehouse_id, loja, loja_estado
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
            w.state AS loja_estado,
            COALESCE(o.region_state, 'Não informado') AS estado_destino,
            SUM(oi.total_price) AS receita,
            SUM(oi.quantity) AS unidades,
            COUNT(DISTINCT oi.order_id) AS pedidos
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     LEFT JOIN warehouses w ON w.warehouse_id = oi.warehouse_id
     WHERE ($1::timestamptz IS NULL OR o.creation_date >= $1)
       AND ($2::timestamptz IS NULL OR o.creation_date < $2)
       AND o.status NOT IN ('canceled','cancelled')
     GROUP BY warehouse_id, loja, loja_estado, estado_destino
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

// Reaproveita a mesma consulta de "Eficiência de Frete por Região" usada em Vendas,
// pois é a mesma métrica solicitada nas duas seções do dashboard.
const { eficienciaFretePorRegiao } = require("./vendas");

module.exports = { slaDeEntrega, eficienciaFretePorRegiao, desempenhoLojas, lojaPorEstadoDestino };
