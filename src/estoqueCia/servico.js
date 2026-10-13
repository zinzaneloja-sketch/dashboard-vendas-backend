// Grava e consulta as cargas da planilha de estoque da companhia (menu "Estoque Cia").
//
// Cada upload vira uma "carga" (estoque_cia_cargas) com todos os datasets já calculados
// (estoque_cia_datasets, um JSONB por dataset). O painel sempre lê a carga mais recente,
// a menos que peça uma específica. Também guardamos um histórico enxuto por dia ×
// loja × categoria (estoque_cia_historico) pra acompanhar evolução e cruzar com venda depois.
const { Readable } = require("stream");
const { pool } = require("../db");
const { lerPlanilhaEstoque } = require("./lerPlanilha");
const { processarEstoque, DATASETS } = require("./processar");

// Quantas cargas completas (com todos os datasets) manter. As mais antigas ficam só no
// histórico enxuto — os datasets detalhados de uma carga passam de 10 MB.
const CARGAS_COMPLETAS_MANTIDAS = 15;

function hojeSaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

// "Estoque_Omni_2026-10-13.xlsx", "estoque 13-10-2026.xlsx", "estoque_20261013.xlsx"…
function dataDoNomeDoArquivo(nome) {
  if (!nome) return null;
  let m = nome.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = nome.match(/(\d{2})[-_.](\d{2})[-_.](20\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function validarData(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00Z")) ? s : null;
}

/**
 * Lê a planilha (Buffer), calcula tudo e grava como uma nova carga.
 * Se já existir carga com a mesma data, ela é substituída (reenvio no mesmo dia).
 */
async function importarPlanilha({ buffer, arquivo, dataRef, origem, enviadoPor }) {
  const data = validarData(dataRef) || dataDoNomeDoArquivo(arquivo) || hojeSaoPaulo();
  const lido = await lerPlanilhaEstoque(Readable.from(buffer));
  const { resumo, datasets, historico } = processarEstoque(lido);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM estoque_cia_cargas WHERE data_ref = $1", [data]);
    const { rows } = await client.query(
      `INSERT INTO estoque_cia_cargas (data_ref, arquivo, origem, enviado_por, linhas, pecas, refs, locais, avisos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [data, arquivo || null, origem || null, enviadoPor || null, resumo.linhas, resumo.pecas, resumo.refs, resumo.locais, JSON.stringify(lido.avisos)]
    );
    const cargaId = rows[0].id;
    for (const nome of DATASETS) {
      await client.query(
        "INSERT INTO estoque_cia_datasets (carga_id, nome, payload) VALUES ($1, $2, $3::jsonb)",
        [cargaId, nome, JSON.stringify(datasets[nome])]
      );
    }
    await client.query("DELETE FROM estoque_cia_historico WHERE data_ref = $1", [data]);
    await client.query(
      `INSERT INTO estoque_cia_historico (data_ref, filial, grupo, pecas, refs, valor)
       SELECT $1, x.filial, x.grupo, x.pecas, x.refs, x.valor
       FROM jsonb_to_recordset($2::jsonb) AS x(filial text, grupo text, pecas int, refs int, valor numeric)`,
      [data, JSON.stringify(historico)]
    );
    // Mantém só as N cargas completas mais recentes (o histórico enxuto fica pra sempre)
    await client.query(
      `DELETE FROM estoque_cia_datasets WHERE carga_id IN (
         SELECT id FROM estoque_cia_cargas ORDER BY data_ref DESC, id DESC OFFSET $1)`,
      [CARGAS_COMPLETAS_MANTIDAS]
    );
    await client.query("COMMIT");
    return { cargaId, dataRef: data, ...resumo, avisos: lido.avisos };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listarCargas() {
  const { rows } = await pool.query(
    `SELECT c.id, to_char(c.data_ref, 'YYYY-MM-DD') AS data_ref, c.arquivo, c.origem, c.enviado_por, c.linhas, c.pecas, c.refs, c.locais,
            c.avisos, c.created_at, EXISTS (SELECT 1 FROM estoque_cia_datasets d WHERE d.carga_id = c.id) AS completa
     FROM estoque_cia_cargas c ORDER BY c.data_ref DESC, c.id DESC LIMIT 60`
  );
  return { cargas: rows };
}

async function lerDataset(nome, cargaId) {
  if (!DATASETS.includes(nome)) {
    const err = new Error("Dataset desconhecido: " + nome);
    err.status = 404;
    throw err;
  }
  // Devolve o JSON já pronto como texto (evita o Postgres → objeto JS → JSON de novo em
  // payloads de ~8 MB como sku_loja).
  const { rows } = await pool.query(
    `SELECT c.id, to_char(c.data_ref, 'YYYY-MM-DD') AS data_ref, d.payload::text AS payload
     FROM estoque_cia_cargas c JOIN estoque_cia_datasets d ON d.carga_id = c.id AND d.nome = $1
     WHERE ($2::bigint IS NULL OR c.id = $2)
     ORDER BY c.data_ref DESC, c.id DESC LIMIT 1`,
    [nome, cargaId || null]
  );
  if (!rows.length) return null;
  return rows[0];
}

async function historico({ filial, grupo }) {
  const { rows } = await pool.query(
    `SELECT to_char(data_ref, 'YYYY-MM-DD') AS data_ref, SUM(pecas)::int AS pecas, SUM(valor)::float AS valor
     FROM estoque_cia_historico
     WHERE ($1::text IS NULL OR filial = $1) AND ($2::text IS NULL OR grupo = $2)
     GROUP BY data_ref ORDER BY data_ref`,
    [filial || null, grupo || null]
  );
  return { serie: rows };
}

module.exports = { importarPlanilha, listarCargas, lerDataset, historico, DATASETS };
