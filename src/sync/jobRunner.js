const { pool } = require("../db");

// Guarda o status da execução mais recente de cada job pesado (sync/backfill) na
// tabela sync_state, usando uma chave prefixada pra não colidir com outras chaves
// já usadas ali (ex: "last_order_sync"). Isso permite responder a requisição HTTP
// na hora e deixar o trabalho pesado rodando em segundo plano no servidor, sem o
// navegador (ou o proxy do Railway) derrubar a conexão por demorar demais — que é
// o que causava "Failed to fetch" em sincronizações longas (catálogo grande,
// período histórico extenso etc.), mesmo com o job continuando rodando por trás.
const JOB_KEY_PREFIX = "job_status:";

// Um job "running" só existe de verdade enquanto o PROCESSO Node que o iniciou continua de
// pé — o `Promise.resolve().then(fn)` que atualiza o status pra "ok"/"error" no final vive só
// na memória desse processo. Se o Railway reinicia o servidor no meio de uma sincronização
// (um novo deploy, um restart manual, o processo cair), esse status "running" fica preso pra
// sempre em `sync_state` — ninguém nunca vai atualizá-lo, porque o código que faria isso
// morreu junto com o processo antigo. Sem isso, o botão "Sincronizar agora" fica bloqueado
// pra sempre com "já tem uma sincronização rodando", mesmo não tendo mais nenhuma sincronização
// de verdade em andamento.
//
// Duas defesas: (1) `reconcileStaleJobsOnBoot`, chamada uma vez quando o servidor sobe — todo
// job que já estava "running" nesse ponto é necessariamente órfão de um processo anterior (um
// processo recém-iniciado não pode ter uma Promise em andamento de antes dele existir), então
// marcamos como erro "interrompido por reinício do servidor" e liberamos o botão na hora. (2)
// Como defesa adicional pro caso de travar sem derrubar o processo (um loop preso, por
// exemplo), `runJobInBackground` também ignora um status "running" mais velho que
// STALE_RUNNING_MS e deixa iniciar um novo job por cima dele.
const STALE_RUNNING_MS = 20 * 60 * 1000; // 20 minutos

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
    const rodandoHaMs = current.startedAt ? Date.now() - new Date(current.startedAt).getTime() : Infinity;
    if (rodandoHaMs < STALE_RUNNING_MS) {
      return { started: false, alreadyRunning: true, status: current };
    }
    console.warn(`[job:${jobName}] status "running" preso há ${Math.round(rodandoHaMs / 60000)} min — tratando como travado e iniciando de novo.`);
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

/**
 * Chamada uma vez na subida do servidor (ver server.js). Qualquer job com status "running"
 * já gravado em `sync_state` nesse momento é órfão de um processo anterior que morreu no
 * meio da sincronização (deploy, restart, crash) — o processo atual acabou de nascer, então
 * não pode ter nenhuma Promise de verdade em andamento ainda. Marcamos como erro pra liberar
 * o botão "Sincronizar agora" imediatamente, em vez de deixar preso até completar
 * STALE_RUNNING_MS.
 */
async function reconcileStaleJobsOnBoot() {
  const statuses = await getAllJobStatuses();
  const presos = Object.entries(statuses).filter(([, s]) => s && s.status === "running");
  for (const [jobName, status] of presos) {
    console.warn(`[job:${jobName}] estava "running" na subida do servidor (órfão de um processo anterior) — marcando como interrompido.`);
    await setJobStatus(jobName, {
      status: "error",
      startedAt: status.startedAt,
      finishedAt: new Date().toISOString(),
      error: "Interrompido por reinício do servidor (deploy ou restart) antes de terminar. Clique em sincronizar de novo.",
      result: null,
    });
  }
}

module.exports = { runJobInBackground, getJobStatus, getAllJobStatuses, reconcileStaleJobsOnBoot };
