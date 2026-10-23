// Trânsito de entrada: envios do fornecedor até a Zinzane (o frete é nosso e a gente fala com a transportadora).
// O envio nasce aqui (solicitada -> coletada/em trânsito) e se liga sozinho à NF quando ela é registrada na doca (mesa 1).
const { pool } = require("../db");
const { diaLocal } = require("./tempo");
const { addDias, numBR } = require("./transito");

function erro(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const ehGestor = (acc) => (acc.cd_perfis || []).includes("gestor");
const ehFat = (acc) => ehGestor(acc) || (acc.cd_perfis || []).includes("faturamento");
function exigirFat(acc) { if (!ehFat(acc)) throw erro(403, "O trânsito de entrada é da mesa de Faturamento e do consolidado."); }
function exigirGestor(acc) { if (!ehGestor(acc)) throw erro(403, "Só o consolidado (gestor) pode fazer isso."); }

const hoje = () => diaLocal(new Date());
const dataValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const difDias = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const diaLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dstr = (v) => (v ? (v instanceof Date ? diaLocalDate(v) : String(v).slice(0, 10)) : null);
function diasUteisEntre(a, b) {
  let n = 0; const d = new Date(a + "T00:00:00Z"); const fim = new Date(b + "T00:00:00Z");
  while (d < fim) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++; }
  return n;
}
const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
const normNum = (n) => String(n || "").replace(/\D/g, "").replace(/^0+/, "");
const normNome = (x) => semAcento(x).replace(/[^a-z0-9]/g, "");
const nomesParecidos = (a, b) => { const x = normNome(a), y = normNome(b); return x.length >= 4 && y.length >= 4 && (x === y || x.includes(y) || y.includes(x)); };

async function comTransacao(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const COLS = `e.id::int AS id, e.fornecedor, e.numero_nf, e.serie, e.chave_nf, e.volumes, e.peso_kg::float AS peso_kg, e.pecas, e.valor::float AS valor, e.origem_uf, e.origem_cidade,
  e.transportadora_id::int AS transportadora_id, t.nome AS transportadora, t.prazo_corridos, e.status, e.coleta_agendada, e.coleta_data, e.prazo_dias, e.prazo_manual,
  e.previsao_chegada, e.recebida_em, e.nota_id::int AS nota_id, e.vinculo, e.obs, e.criado_por, e.criado_em`;
const FROM = "cd_ent_envios e LEFT JOIN cd_transportadoras t ON t.id = e.transportadora_id";

// situação para o quadro: depende do status e da previsão de chegada na doca
function situacao(n, dia = hoje()) {
  const ag = dstr(n.coleta_agendada), coleta = dstr(n.coleta_data), prev = dstr(n.previsao_chegada);
  const o = { ...n, coleta_agendada: ag, coleta_data: coleta, previsao_chegada: prev, previsao_estimada: null, estimada_vencida: false };
  if (n.status === "cancelada") { o.situacao = "cancelada"; return o; }
  if (n.status === "recebida") {
    const rec = n.recebida_em ? diaLocal(n.recebida_em) : null;
    o.recebida_dia = rec;
    o.situacao = prev && rec && rec > prev ? "recebida_atrasada" : "recebida";
    o.dias_atraso = prev && rec && rec > prev ? difDias(prev, rec) : 0;
    o.dias_transito = coleta && rec ? difDias(coleta, rec) : null;
    return o;
  }
  if (n.status === "em_transito") {
    o.dias_transito = coleta ? difDias(coleta, dia) : null;
    if (!prev) { o.situacao = "sem_previsao"; o.dias_atraso = 0; }
    else if (dia > prev) { o.situacao = "atrasada"; o.dias_atraso = difDias(prev, dia); }
    else if (dia === prev) { o.situacao = "chega_hoje"; o.dias_atraso = 0; }
    else { o.situacao = "no_prazo"; o.dias_atraso = 0; }
    return o;
  }
  // solicitada: ainda não coletou. Previsão só estimada (a partir da coleta agendada)
  o.situacao = ag && dia > ag ? "coleta_atrasada" : "aguardando_coleta";
  o.dias_coleta_atraso = ag && dia > ag ? difDias(ag, dia) : 0;
  o.previsao_estimada = ag && n.prazo_dias !== null && n.prazo_dias !== undefined ? addDias(ag, Number(n.prazo_dias), n.prazo_corridos) : null;
  o.estimada_vencida = !!(o.previsao_estimada && dia > o.previsao_estimada);
  return o;
}

async function evento(db, id, tipo, usuario, detalhe = {}) {
  await db.query("INSERT INTO cd_ent_eventos (envio_id, tipo, usuario, detalhe) VALUES ($1,$2,$3,$4)", [id, tipo, usuario, JSON.stringify(detalhe)]);
}

// prazo (dias) sugerido: média do que esse fornecedor + transportadora já levaram (coleta -> doca) quando há 2+ envios; senão o prazo padrão da transportadora
async function prazoSugerido(db, fornecedor, transportadoraId) {
  if (!transportadoraId) return { prazo: null, origem: null };
  const { rows: t } = await db.query("SELECT prazo_corridos, prazo_padrao FROM cd_transportadoras WHERE id = $1", [transportadoraId]);
  if (!t[0]) return { prazo: null, origem: null };
  const { rows } = await db.query(
    `SELECT coleta_data, recebida_em FROM cd_ent_envios WHERE status = 'recebida' AND transportadora_id = $1 AND lower(fornecedor) = lower($2)
        AND coleta_data IS NOT NULL AND recebida_em IS NOT NULL ORDER BY recebida_em DESC LIMIT 10`, [transportadoraId, fornecedor]);
  const dias = rows.map((r) => { const c = dstr(r.coleta_data), rc = diaLocal(r.recebida_em); return t[0].prazo_corridos ? difDias(c, rc) : diasUteisEntre(c, rc); }).filter((x) => x >= 0);
  if (dias.length >= 2) return { prazo: Math.max(1, Math.round(dias.reduce((a, b) => a + b, 0) / dias.length)), origem: `média dos últimos ${dias.length} envios desse fornecedor com essa transportadora` };
  if (t[0].prazo_padrao !== null && t[0].prazo_padrao !== undefined) return { prazo: Number(t[0].prazo_padrao), origem: "prazo padrão da transportadora" };
  return { prazo: null, origem: null };
}

// recalcula prazo e previsão de chegada
async function recalcular(db, id) {
  const { rows } = await db.query("SELECT e.*, t.prazo_corridos FROM cd_ent_envios e LEFT JOIN cd_transportadoras t ON t.id = e.transportadora_id WHERE e.id = $1", [id]);
  const n = rows[0]; if (!n) return null;
  let prazo = n.prazo_manual ? n.prazo_dias : null, origem = n.prazo_manual ? "informado por você" : null;
  if (!n.prazo_manual) { const s = await prazoSugerido(db, n.fornecedor, n.transportadora_id); prazo = s.prazo; origem = s.origem; }
  const prev = n.coleta_data && prazo !== null && prazo !== undefined ? addDias(dstr(n.coleta_data), Number(prazo), n.prazo_corridos) : null;
  await db.query("UPDATE cd_ent_envios SET prazo_dias = $2, previsao_chegada = $3, atualizado_em = now() WHERE id = $1", [id, prazo, prev]);
  return { prazo_dias: prazo, previsao_chegada: prev, prazo_origem: origem };
}

const EDITAVEIS = { fornecedor: "txt", numero_nf: "txt", serie: "txt", chave_nf: "chave", volumes: "int", peso_kg: "num", pecas: "int", valor: "num", origem_uf: "uf", origem_cidade: "txt", coleta_agendada: "data", obs: "txt" };

function lerCampos(b, parcial) {
  const out = {};
  for (const [k, tipo] of Object.entries(EDITAVEIS)) {
    if (parcial && b[k] === undefined) continue;
    let v;
    if (tipo === "txt") v = txt(b[k]).slice(0, k === "obs" ? 500 : 160) || null;
    else if (tipo === "chave") { v = txt(b[k]).replace(/\s+/g, "") || null; if (v && !/^\d{44}$/.test(v)) throw erro(400, "A chave da NF-e deve ter 44 números."); }
    else if (tipo === "uf") { v = txt(b[k]).toUpperCase() || null; if (v && !UFS.has(v)) throw erro(400, "UF de origem inválida."); }
    else if (tipo === "data") { v = txt(b[k]) || null; if (v && !dataValida(v)) throw erro(400, "Data inválida."); }
    else if (tipo === "int") { v = numBR(b[k]); if (v !== null) { v = Math.round(v); if (v < 0) throw erro(400, `${k}: não pode ser negativo.`); } }
    else { v = numBR(b[k]); if (v !== null && v < 0) throw erro(400, `${k}: não pode ser negativo.`); }
    out[k] = v;
  }
  return out;
}

async function criarEnvio(acc, b = {}) {
  exigirFat(acc);
  const c = lerCampos(b, false);
  if (!c.fornecedor) throw erro(400, "Informe o fornecedor.");
  const tid = b.transportadora_id ? Number(b.transportadora_id) : null;
  if (b.transportadora_id && !Number.isInteger(tid)) throw erro(400, "Transportadora inválida.");
  let pz = null;
  if (b.prazo_dias !== undefined && txt(b.prazo_dias) !== "") { pz = numBR(b.prazo_dias); if (pz === null || pz < 0 || pz > 120 || Math.round(pz) !== pz) throw erro(400, "O prazo deve ser um número inteiro de dias (0 a 120)."); }
  return comTransacao(async (db) => {
    if (tid) { const { rows: t } = await db.query("SELECT id FROM cd_transportadoras WHERE id = $1", [tid]); if (!t[0]) throw erro(404, "Transportadora não encontrada."); }
    if (c.numero_nf) {
      const { rows: dup } = await db.query("SELECT id FROM cd_ent_envios WHERE status <> 'cancelada' AND lower(fornecedor) = lower($1) AND numero_nf = $2 AND coalesce(serie,'') = coalesce($3,'') LIMIT 1", [c.fornecedor, c.numero_nf, c.serie]);
      if (dup[0]) throw erro(409, "Já existe um envio desse fornecedor com essa NF (nº " + c.numero_nf + ").");
    }
    let r;
    try {
      r = await db.query(
        `INSERT INTO cd_ent_envios (fornecedor, numero_nf, serie, chave_nf, volumes, peso_kg, pecas, valor, origem_uf, origem_cidade, transportadora_id, coleta_agendada, obs, prazo_dias, prazo_manual, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [c.fornecedor, c.numero_nf, c.serie, c.chave_nf, c.volumes, c.peso_kg, c.pecas, c.valor, c.origem_uf, c.origem_cidade, tid, c.coleta_agendada, c.obs, pz, pz !== null, acc.email]);
    } catch (e) { if (e.code === "23505") throw erro(409, "Já existe um envio com essa chave de NF-e."); throw e; }
    const id = Number(r.rows[0].id);
    await evento(db, id, "criado", acc.email, { fornecedor: c.fornecedor, numero_nf: c.numero_nf, transportadora_id: tid, coleta_agendada: c.coleta_agendada });
    // se a NF já foi registrada na doca antes de alguém cadastrar o envio, liga agora
    const lig = await ligarNotaExistente(db, id, acc.email);
    if (!lig) await recalcular(db, id);
    return { ok: true, id, vinculado_na_doca: !!lig };
  });
}

async function editarEnvio(acc, id, b = {}) {
  exigirFat(acc);
  return comTransacao(async (db) => {
    const { rows } = await db.query("SELECT * FROM cd_ent_envios WHERE id = $1 FOR UPDATE", [id]);
    const cur = rows[0];
    if (!cur) throw erro(404, "Envio não encontrado.");
    if (cur.status === "cancelada") throw erro(409, "Esse envio foi cancelado.");
    const c = lerCampos(b, true);
    if (c.fornecedor !== undefined && !c.fornecedor) throw erro(400, "Informe o fornecedor.");
    const sets = [], vals = [id], mud = [];
    let recalc = false;
    for (const [k, v] of Object.entries(c)) {
      const atual = cur[k] === null || cur[k] === undefined ? null : (["peso_kg", "valor"].includes(k) ? Number(cur[k]) : (k === "coleta_agendada" ? dstr(cur[k]) : cur[k]));
      if (atual === v) continue;
      vals.push(v); sets.push(`${k} = $${vals.length}`); mud.push({ campo: k, de: atual, para: v });
      if (k === "fornecedor") recalc = true;
    }
    if (b.transportadora_id !== undefined) {
      const tid = b.transportadora_id ? Number(b.transportadora_id) : null;
      if (tid) { const { rows: t } = await db.query("SELECT id FROM cd_transportadoras WHERE id = $1", [tid]); if (!t[0]) throw erro(404, "Transportadora não encontrada."); }
      if ((cur.transportadora_id ? Number(cur.transportadora_id) : null) !== tid) {
        vals.push(tid); sets.push(`transportadora_id = $${vals.length}`);
        if (b.prazo_dias === undefined) { sets.push("prazo_manual = false"); sets.push("prazo_dias = NULL"); }
        mud.push({ campo: "transportadora_id", de: cur.transportadora_id, para: tid }); recalc = true;
      }
    }
    if (b.prazo_dias !== undefined) {
      if (txt(b.prazo_dias) === "") { if (cur.prazo_manual) { sets.push("prazo_manual = false"); mud.push({ campo: "prazo_dias", de: cur.prazo_dias, para: "automático" }); recalc = true; } }
      else {
        const pz = numBR(b.prazo_dias);
        if (pz === null || pz < 0 || pz > 120 || Math.round(pz) !== pz) throw erro(400, "O prazo deve ser um número inteiro de dias (0 a 120).");
        if (!cur.prazo_manual || Number(cur.prazo_dias) !== pz) { vals.push(pz); sets.push(`prazo_dias = $${vals.length}`); sets.push("prazo_manual = true"); mud.push({ campo: "prazo_dias", de: cur.prazo_dias, para: pz }); recalc = true; }
      }
    }
    if (!sets.length) return { ok: true, mudancas: 0 };
    try { await db.query(`UPDATE cd_ent_envios SET ${sets.join(", ")}, atualizado_em = now() WHERE id = $1`, vals); }
    catch (e) { if (e.code === "23505") throw erro(409, "Já existe um envio com essa chave de NF-e."); throw e; }
    await evento(db, id, "editado", acc.email, { mudancas: mud });
    if (recalc && cur.status !== "recebida") await recalcular(db, id);
    return { ok: true, mudancas: mud.length };
  });
}

async function marcarColeta(acc, b = {}) {
  exigirFat(acc);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean))];
  if (!ids.length) throw erro(400, "Selecione ao menos um envio.");
  const data = b.data || hoje();
  if (!dataValida(data)) throw erro(400, "Data de coleta inválida.");
  if (data > hoje()) throw erro(400, "A data de coleta não pode ser futura.");
  return comTransacao(async (db) => {
    const res = [];
    for (const id of ids) {
      const { rows } = await db.query("SELECT * FROM cd_ent_envios WHERE id = $1 FOR UPDATE", [id]);
      const n = rows[0];
      if (!n || n.status === "cancelada") { res.push({ id, ok: false, motivo: "Envio não encontrado." }); continue; }
      const rot = n.numero_nf ? "NF " + n.numero_nf : n.fornecedor;
      if (n.status === "recebida") { res.push({ id, numero: rot, ok: false, motivo: "Já foi recebido na doca." }); continue; }
      if (n.status === "em_transito") { res.push({ id, numero: rot, ok: false, motivo: "Já está em trânsito." }); continue; }
      if (!n.transportadora_id) { res.push({ id, numero: rot, ok: false, motivo: "Defina a transportadora antes de marcar a coleta." }); continue; }
      await db.query("UPDATE cd_ent_envios SET status = 'em_transito', coleta_data = $2, atualizado_em = now() WHERE id = $1", [id, data]);
      const calc = await recalcular(db, id);
      await evento(db, id, "coleta", acc.email, { data, previsao_chegada: calc.previsao_chegada, prazo_dias: calc.prazo_dias });
      res.push({ id, numero: rot, ok: true, previsao_chegada: calc.previsao_chegada, aviso: calc.previsao_chegada ? null : "Sem prazo: informe o prazo do envio para ter previsão de chegada." });
    }
    return { ok: true, resultados: res, coletadas: res.filter((x) => x.ok).length };
  });
}

async function voltarStatus(acc, id) {
  exigirFat(acc);
  return comTransacao(async (db) => {
    const { rows } = await db.query("SELECT * FROM cd_ent_envios WHERE id = $1 FOR UPDATE", [id]);
    const n = rows[0];
    if (!n) throw erro(404, "Envio não encontrado.");
    if (n.status === "em_transito") {
      await db.query("UPDATE cd_ent_envios SET status = 'solicitada', coleta_data = NULL, previsao_chegada = NULL, atualizado_em = now() WHERE id = $1", [id]);
      await evento(db, id, "voltou", acc.email, { de: "em_transito", para: "solicitada" });
      return { ok: true, status: "solicitada" };
    }
    if (n.status === "recebida") throw erro(409, "O envio foi recebido na doca. Para desfazer o vínculo use \"Desvincular da doca\" (só o consolidado).");
    throw erro(409, "Nada para voltar nesse envio.");
  });
}

async function cancelarEnvio(acc, id, motivo) {
  exigirFat(acc);
  const m = txt(motivo).slice(0, 300);
  if (m.length < 3) throw erro(400, "Informe o motivo do cancelamento.");
  return comTransacao(async (db) => {
    const { rows } = await db.query("SELECT status FROM cd_ent_envios WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw erro(404, "Envio não encontrado.");
    if (rows[0].status === "recebida") throw erro(409, "Esse envio já foi recebido na doca; não dá para cancelar.");
    if (rows[0].status === "cancelada") return { ok: true };
    await db.query("UPDATE cd_ent_envios SET status = 'cancelada', atualizado_em = now() WHERE id = $1", [id]);
    await evento(db, id, "cancelado", acc.email, { motivo: m });
    return { ok: true };
  });
}

// liga o envio à NF recebida na doca (marca como recebido na hora em que a nota foi registrada)
async function aplicarVinculo(db, envioId, nota, usuario, vinculo) {
  await db.query("UPDATE cd_ent_envios SET status = 'recebida', recebida_em = $2, nota_id = $3, vinculo = $4, atualizado_em = now() WHERE id = $1", [envioId, nota.criada_em || new Date(), nota.id, vinculo]);
  await evento(db, envioId, "recebida", usuario, { nota_id: Number(nota.id), numero_nf: nota.numero_nf, vinculo });
}

// candidatos entre os envios em aberto para uma NF da doca: pela chave, ou pelo nº da NF + fornecedor parecido (+ série, quando ambos têm)
async function achaEnvio(db, nota) {
  const { rows } = await db.query("SELECT id, fornecedor, numero_nf, serie, chave_nf FROM cd_ent_envios WHERE nota_id IS NULL AND status IN ('solicitada','em_transito')");
  const chave = txt(nota.chave_nf);
  if (chave) { const p = rows.filter((e) => e.chave_nf && e.chave_nf === chave); if (p.length === 1) return p[0]; if (p.length > 1) return null; }
  const num = normNum(nota.numero_nf);
  if (!num) return null;
  const c = rows.filter((e) => normNum(e.numero_nf) === num && nomesParecidos(e.fornecedor, nota.fornecedor) && (!txt(e.serie) || !txt(nota.serie) || normNum(e.serie) === normNum(nota.serie)));
  return c.length === 1 ? c[0] : null;
}

// chamado pela doca ao registrar a NF (dentro da transação dela). Qualquer falha aqui NUNCA derruba o recebimento.
async function vincularNaDoca(db, nota, usuario) {
  try {
    await db.query("SAVEPOINT ent_vinc");
    const e = await achaEnvio(db, nota);
    if (e) await aplicarVinculo(db, e.id, nota, usuario, "automatico");
    await db.query("RELEASE SAVEPOINT ent_vinc");
    return e ? Number(e.id) : null;
  } catch (err) {
    await db.query("ROLLBACK TO SAVEPOINT ent_vinc").catch(() => {});
    console.error("[entrada] vínculo automático falhou:", err.message);
    return null;
  }
}

// o envio foi cadastrado depois da NF já estar na doca: procura a nota
async function ligarNotaExistente(db, envioId, usuario) {
  const { rows: e } = await db.query("SELECT * FROM cd_ent_envios WHERE id = $1", [envioId]);
  const env = e[0]; if (!env || (!env.numero_nf && !env.chave_nf)) return null;
  const { rows: notas } = await db.query(
    `SELECT n.id, n.numero_nf, n.serie, n.fornecedor, n.chave_nf, n.criada_em FROM cd_notas n
      WHERE n.status <> 'cancelada' AND n.criada_em >= now() - interval '120 days' AND NOT EXISTS (SELECT 1 FROM cd_ent_envios x WHERE x.nota_id = n.id)`);
  const chave = txt(env.chave_nf), num = normNum(env.numero_nf);
  let ach = chave ? notas.filter((n) => n.chave_nf && n.chave_nf === chave) : [];
  if (ach.length !== 1) ach = notas.filter((n) => num && normNum(n.numero_nf) === num && nomesParecidos(env.fornecedor, n.fornecedor) && (!txt(env.serie) || !txt(n.serie) || normNum(env.serie) === normNum(n.serie)));
  if (ach.length !== 1) return null;
  await aplicarVinculo(db, envioId, ach[0], usuario, "automatico");
  return Number(ach[0].id);
}

async function vincularManual(acc, id, b = {}) {
  exigirFat(acc);
  const notaId = Number(b.nota_id);
  if (!Number.isInteger(notaId) || notaId <= 0) throw erro(400, "Escolha a NF recebida na doca.");
  return comTransacao(async (db) => {
    const { rows } = await db.query("SELECT * FROM cd_ent_envios WHERE id = $1 FOR UPDATE", [id]);
    const e = rows[0];
    if (!e) throw erro(404, "Envio não encontrado.");
    if (e.status === "cancelada") throw erro(409, "Esse envio foi cancelado.");
    if (e.nota_id) throw erro(409, "Esse envio já está ligado a uma NF da doca.");
    const { rows: n } = await db.query("SELECT id, numero_nf, criada_em FROM cd_notas WHERE id = $1", [notaId]);
    if (!n[0]) throw erro(404, "NF da doca não encontrada.");
    const { rows: ja } = await db.query("SELECT id FROM cd_ent_envios WHERE nota_id = $1", [notaId]);
    if (ja[0]) throw erro(409, "Essa NF da doca já está ligada a outro envio.");
    await aplicarVinculo(db, id, n[0], acc.email, "manual");
    return { ok: true };
  });
}

async function desvincular(acc, id) {
  exigirGestor(acc);
  return comTransacao(async (db) => {
    const { rows } = await db.query("SELECT * FROM cd_ent_envios WHERE id = $1 FOR UPDATE", [id]);
    const e = rows[0];
    if (!e) throw erro(404, "Envio não encontrado.");
    if (!e.nota_id) throw erro(409, "Esse envio não está ligado a nenhuma NF.");
    const novo = e.coleta_data ? "em_transito" : "solicitada";
    await db.query("UPDATE cd_ent_envios SET status = $2, recebida_em = NULL, nota_id = NULL, vinculo = NULL, atualizado_em = now() WHERE id = $1", [id, novo]);
    await evento(db, id, "desvinculado", acc.email, { nota_id: Number(e.nota_id) });
    await recalcular(db, id);
    return { ok: true, status: novo };
  });
}

// notas já registradas na doca que não têm envio ligado (recebidas sem controle de trânsito)
async function semEnvio(acc) {
  exigirFat(acc);
  const { rows } = await pool.query(
    `SELECT n.id::int AS id, n.numero_nf, n.serie, n.fornecedor, n.chave_nf, n.total_pecas_nf, n.volumes_nf, n.criada_em
       FROM cd_notas n
      WHERE n.status <> 'cancelada' AND n.criada_em >= now() - interval '60 days' AND NOT EXISTS (SELECT 1 FROM cd_ent_envios x WHERE x.nota_id = n.id)
      ORDER BY n.criada_em DESC LIMIT 60`);
  return { notas: rows };
}

async function opcoes(acc) {
  exigirFat(acc);
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (lower(f)) f FROM (SELECT fornecedor AS f FROM cd_ent_envios UNION ALL SELECT fornecedor FROM cd_notas) x WHERE f IS NOT NULL AND f <> '' ORDER BY lower(f), f LIMIT 400`);
  return { fornecedores: rows.map((r) => r.f) };
}

async function listarEnvios(acc, f = {}) {
  exigirFat(acc);
  const params = [], w = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (f.status && f.status !== "todos") {
    if (f.status === "abertos") w.push("e.status IN ('solicitada','em_transito')");
    else w.push(`e.status = ${add(f.status)}`);
  } else if (!f.status) w.push("e.status IN ('solicitada','em_transito')");
  else w.push("e.status <> 'cancelada'");
  if (f.transportadora_id) w.push(`e.transportadora_id = ${add(Number(f.transportadora_id) || 0)}`);
  if (f.q) { const p = add("%" + semAcento(f.q) + "%"); w.push(`(lower(e.fornecedor) LIKE ${p} OR lower(coalesce(e.numero_nf,'')) LIKE ${p} OR coalesce(e.chave_nf,'') LIKE ${p})`); }
  const lim = Math.min(Math.max(Number(f.limit) || 300, 1), 1000);
  const { rows } = await pool.query(`SELECT ${COLS} FROM ${FROM} ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY e.id DESC LIMIT ${lim}`, params);
  const dia = hoje();
  return { envios: rows.map((r) => situacao(r, dia)) };
}

async function detalheEnvio(acc, id) {
  exigirFat(acc);
  const { rows } = await pool.query(`SELECT ${COLS} FROM ${FROM} WHERE e.id = $1`, [id]);
  if (!rows[0]) throw erro(404, "Envio não encontrado.");
  const { rows: ev } = await pool.query("SELECT tipo, usuario, detalhe, criado_em FROM cd_ent_eventos WHERE envio_id = $1 ORDER BY id", [id]);
  let nota = null;
  if (rows[0].nota_id) { const { rows: n } = await pool.query("SELECT id::int AS id, numero_nf, serie, fornecedor, total_pecas_nf, volumes_nf, status, etapa_atual, criada_em FROM cd_notas WHERE id = $1", [rows[0].nota_id]); nota = n[0] || null; }
  const sug = await prazoSugerido(pool, rows[0].fornecedor, rows[0].transportadora_id);
  return { envio: situacao(rows[0]), eventos: ev, nota, prazo_sugerido: sug };
}

// para o detalhe da NF na doca: como essa mercadoria chegou (sem valores)
async function envioDaNota(db, notaId) {
  try {
    const { rows } = await db.query(`SELECT ${COLS} FROM ${FROM} WHERE e.nota_id = $1`, [notaId]);
    if (!rows[0]) return null;
    const s = situacao(rows[0]);
    return { id: s.id, transportadora: s.transportadora, coleta_data: s.coleta_data, previsao_chegada: s.previsao_chegada, recebida_em: s.recebida_em, dias_transito: s.dias_transito, dias_atraso: s.dias_atraso, situacao: s.situacao, prazo_dias: s.prazo_dias, vinculo: s.vinculo, origem: [s.origem_cidade, s.origem_uf].filter(Boolean).join(" / ") || null };
  } catch (e) { return null; }
}

// quadro de trânsito de entrada
async function quadro(acc, { dias = 30, transportadora_id, fornecedor } = {}) {
  exigirFat(acc);
  const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const dia = hoje();
  const corte = new Date(Date.now() - d * 86400000).toISOString();
  const params = [corte];
  let extra = "";
  if (transportadora_id) { params.push(Number(transportadora_id) || 0); extra += ` AND e.transportadora_id = $${params.length}`; }
  if (txt(fornecedor)) { params.push("%" + semAcento(fornecedor) + "%"); extra += ` AND lower(e.fornecedor) LIKE $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM ${FROM} WHERE e.status <> 'cancelada' AND (e.status <> 'recebida' OR e.recebida_em >= $1::timestamptz) ${extra} ORDER BY e.id DESC LIMIT 5000`, params);
  const envios = rows.map((r) => situacao(r, dia));
  const por = (s) => envios.filter((n) => n.situacao === s);
  const abertos = envios.filter((n) => n.status !== "recebida");
  const rec = envios.filter((n) => n.status === "recebida");
  const comPrev = rec.filter((n) => n.previsao_chegada);
  const noPrazo = comPrev.filter((n) => n.situacao === "recebida").length;
  const media = (arr) => (arr.length ? Math.round(arr.reduce((a, x) => a + x, 0) / arr.length * 10) / 10 : null);
  const agr = (chave) => {
    const m = {};
    envios.forEach((n) => {
      const k = chave(n);
      const t = m[k] || (m[k] = { nome: k, aguardando: 0, em_transito: 0, atrasados: 0, recebidos: 0, com_prev: 0, no_prazo: 0, prazo: [], real: [] });
      if (n.status === "solicitada") t.aguardando++;
      if (n.status === "em_transito") { t.em_transito++; if (n.situacao === "atrasada") t.atrasados++; }
      if (n.status === "recebida") { t.recebidos++; if (n.previsao_chegada) { t.com_prev++; if (n.situacao === "recebida") t.no_prazo++; } if (n.prazo_dias !== null && n.prazo_dias !== undefined) t.prazo.push(Number(n.prazo_dias)); if (n.dias_transito !== null && n.dias_transito !== undefined) t.real.push(n.dias_transito); }
    });
    return Object.values(m).map((t) => ({ nome: t.nome, aguardando: t.aguardando, em_transito: t.em_transito, atrasados: t.atrasados, recebidos: t.recebidos, no_prazo_pct: t.com_prev ? Math.round(t.no_prazo / t.com_prev * 100) : null, prazo_previsto_medio: media(t.prazo), prazo_real_medio: media(t.real) }))
      .sort((a, b) => (b.atrasados - a.atrasados) || (b.em_transito - a.em_transito) || (b.recebidos - a.recebidos));
  };
  const ordem = {
    atrasados: por("atrasada").sort((a, b) => b.dias_atraso - a.dias_atraso),
    chegam_hoje: por("chega_hoje"),
    em_transito: [...por("no_prazo"), ...por("sem_previsao")].sort((a, b) => String(a.previsao_chegada || "9999").localeCompare(String(b.previsao_chegada || "9999"))),
    aguardando_coleta: [...por("coleta_atrasada"), ...por("aguardando_coleta")].sort((a, b) => String(a.coleta_agendada || "9999").localeCompare(String(b.coleta_agendada || "9999"))),
    recebidos: rec.sort((a, b) => String(b.recebida_dia).localeCompare(String(a.recebida_dia))),
  };
  const { rows: [{ n: semEnv }] } = await pool.query("SELECT count(*)::int AS n FROM cd_notas n WHERE n.status <> 'cancelada' AND n.criada_em >= now() - interval '60 days' AND NOT EXISTS (SELECT 1 FROM cd_ent_envios x WHERE x.nota_id = n.id)");
  return {
    hoje: dia, janela_dias: d,
    kpis: {
      aguardando_coleta: ordem.aguardando_coleta.length, coleta_atrasada: por("coleta_atrasada").length, em_transito: envios.filter((n) => n.status === "em_transito").length,
      atrasados: ordem.atrasados.length, chegam_hoje: ordem.chegam_hoje.length, sem_previsao: por("sem_previsao").length, sem_transportadora: abertos.filter((n) => !n.transportadora_id).length,
      recebidos: rec.length, no_prazo_pct: comPrev.length ? Math.round(noPrazo / comPrev.length * 100) : null, transito_medio_dias: media(rec.filter((n) => n.dias_transito !== null && n.dias_transito !== undefined).map((n) => n.dias_transito)),
      notas_sem_envio: semEnv,
    },
    transportadoras: agr((n) => n.transportadora || "(sem transportadora)"), fornecedores: agr((n) => n.fornecedor).slice(0, 30),
    colunas: Object.fromEntries(Object.entries(ordem).map(([k, v]) => [k, { total: v.length, envios: v.slice(0, 150) }])),
  };
}

// ---- leitura de código de barras (coletor USB): a chave de 44 dígitos já traz CNPJ do emitente, nº e série ----
function dvChave(c43) { let w = 2, s = 0; for (let i = 42; i >= 0; i--) { s += Number(c43[i]) * w; w = w === 9 ? 2 : w + 1; } const r = s % 11; return r < 2 ? 0 : 11 - r; }
const MODELOS = { "55": "NF-e", "65": "NFC-e (cupom)", "57": "CT-e (conhecimento de transporte)", "67": "CT-e OS", "58": "MDF-e (manifesto)" };
function dadosChave(c) {
  return { uf_cod: c.slice(0, 2), emissao_ano_mes: "20" + c.slice(2, 4) + "-" + c.slice(4, 6), cnpj: c.slice(6, 20), modelo: c.slice(20, 22), serie: String(parseInt(c.slice(22, 25), 10)), numero: String(parseInt(c.slice(25, 34), 10)) };
}
// confere a chave (dígito verificador, modelo) e diz o que já existe no sistema com ela: nota na doca, envio, fornecedor conhecido pelo CNPJ
async function consultaChave(acc, raw) {
  const s = txt(raw).replace(/\s+/g, "");
  const m = s.match(/\d{44}/);
  const c = m ? m[0] : (s.replace(/\D/g, "").length === 44 ? s.replace(/\D/g, "") : "");
  if (!c) throw erro(400, "A chave da NF-e tem 44 números.");
  const d = dadosChave(c);
  const out = { chave: c, valida: dvChave(c.slice(0, 43)) === Number(c[43]), ...d, tipo_documento: MODELOS[d.modelo] || "documento modelo " + d.modelo, e_nfe: d.modelo === "55", fornecedor_sugerido: null, nota: null, envio: null, envio_provavel: null };
  if (!out.valida) return out;
  const { rows: n } = await pool.query("SELECT id::int AS id, numero_nf, serie, fornecedor, etapa_atual, status FROM cd_notas WHERE chave_nf = $1 AND status <> 'cancelada' LIMIT 1", [c]);
  if (n[0]) out.nota = n[0];
  const { rows: e } = await pool.query("SELECT e.id::int AS id, e.fornecedor, e.status, e.numero_nf, t.nome AS transportadora FROM cd_ent_envios e LEFT JOIN cd_transportadoras t ON t.id = e.transportadora_id WHERE e.chave_nf = $1 AND e.status <> 'cancelada' LIMIT 1", [c]);
  if (e[0]) out.envio = e[0];
  const { rows: f } = await pool.query(
    `SELECT fornecedor FROM (SELECT fornecedor, criada_em AS t FROM cd_notas WHERE chave_nf IS NOT NULL AND substr(chave_nf, 7, 14) = $1
       UNION ALL SELECT fornecedor, criado_em AS t FROM cd_ent_envios WHERE chave_nf IS NOT NULL AND substr(chave_nf, 7, 14) = $1) x ORDER BY t DESC LIMIT 1`, [d.cnpj]);
  if (f[0]) out.fornecedor_sugerido = f[0].fornecedor;
  if (!out.envio && !out.nota) {
    const p = await achaEnvio(pool, { chave_nf: c, numero_nf: d.numero, serie: d.serie, fornecedor: out.fornecedor_sugerido || "" });
    if (p) { const { rows: pe } = await pool.query("SELECT e.id::int AS id, e.fornecedor, e.status, e.numero_nf, t.nome AS transportadora FROM cd_ent_envios e LEFT JOIN cd_transportadoras t ON t.id = e.transportadora_id WHERE e.id = $1", [p.id]); out.envio_provavel = pe[0] || null; }
  }
  return out;
}

module.exports = { consultaChave, dadosChave, criarEnvio, editarEnvio, marcarColeta, voltarStatus, cancelarEnvio, vincularManual, desvincular, vincularNaDoca, semEnvio, opcoes, listarEnvios, detalheEnvio, envioDaNota, quadro, situacao };
