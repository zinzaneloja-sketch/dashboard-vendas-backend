const { pool } = require("../db");

// Guarda o status da execução mais recente de cada job pesado (sync/backfill) na
// tabela sync_state, usando uma chave prefixada pra não colidir com outras chaves
// já usadas ali (ex: "last_order_sync"). Isso permite responder a requisição HTTP
// na hora e deixar o trabalho pesado rodando em segundo plano no servidor, sem o
// navegador (ou o proxy do Railway) derrubar a conexão por demorar demais — que é
// o que causava "Failed to fetch" em sincronizações longas (catálogo grande,
// período histórico extenso etc.), mesmo com o job continuando rodando por trás.
const JOB_KEY_PREFIX = "job_status:";

async function setJobStatus(jobName, status) {
  const key = JOB_KEY_PREFIX + jobName;
  await pool.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(status)]
  );
}

async function getJobStatus(jobName) {
  const key = JOB_KEY_PREFIX + jobName;
  const { rows } = await pool.query("SELECT value FROM sync_state WHERE key = $1", [key]);
  if (!rows.length) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

async function getAllJobStatuses() {
  const { rows } = await pool.query("SELECT key, value FROM sync_state WHERE key LIKE $1", [JOB_KEY_PREFIX + "%"]);
  const out = {};
  for (const row of rows) {
    const jobName = row.key.slice(JOB_KEY_PREFIX.length);
    try {
      out[jobName] = JSON.parse(row.value);
    } catch {
      out[jobName] = null;
    }
  }
  return out;
}

/**
 * Dispara `fn` em segundo plano (sem `await`) e devolve na hora — a requisição HTTP
 * que chamou isso responde imediatamente, e `fn` continua rodando no processo do
 * servidor depois da resposta já ter sido enviada. Se um job com esse nome já
 * estiver "running", não inicia outro em paralelo (evita duas sincronizações do
 * mesmo tipo pisando uma na outra) — devolve started:false nesse caso.
 */
async function runJobInBackground(jobName, fn) {
  const current = await getJobStatus(jobName);
  if (current && current.status === "running") {
    return { started: false, alreadyRunning: true, status: current };
  }

  const startedAt = new Date().toISOString();
  await setJobStatus(jobName, { status: "running", startedAt, finishedAt: null, error: null, result: null });

  Promise.resolve()
    .then(fn)
    .then(async (result) => {
      await setJobStatus(jobName, {
        status: "ok",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: null,
        result: result === undefined ? null : result,
      });
    })
    .catch(async (err) => {
      console.error(`[job:${jobName}] falhou:`, err.response?.data || err.message);
      await setJobStatus(jobName, {
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: err.message,
        result: null,
      }).catch(() => {});
    });

  return { started: true, alreadyRunning: false };
}

module.exports = { runJobInBackground, getJobStatus, getAllJobStatuses };
