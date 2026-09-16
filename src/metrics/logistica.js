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

// Reaproveita a mesma consulta de "Eficiência de Frete por Região" usada em Vendas,
// pois é a mesma métrica solicitada nas duas seções do dashboard.
const { eficienciaFretePorRegiao } = require("./vendas");

module.exports = { slaDeEntrega, eficienciaFretePorRegiao };
