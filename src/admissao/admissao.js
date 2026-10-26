// Admissão e Rescisão: controle de cada admissão ou rescisão de colaborador, etapa a etapa, com prazos (SLA) em
// minutos úteis (expediente de tempo.js), por etapa e total. O relógio pode ser pausado quando o processo
// depende de terceiros (ex.: o colaborador ainda não entregou os documentos).
// Papéis: analista (conduz os processos), gestor (também mexe em etapas, prazos, equipe e cancela).
// O administrador do sistema (users.role = 'admin') é gestor.
// Dados pessoais: só o mínimo (nome, CPF, cargo, local, datas, tipo). Sem salário, sem documentos.
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { minutosUteis, diaLocal, expediente } = require("../cd/tempo");
const auditoria = require("../auditoria");
const audit = (acc, acao, o = {}) => auditoria.registrar({ usuario: acc && acc.email, papel: acc && (acc.role === "admin" ? "admin" : acc.papel), acao, ip: acc && acc.ip, ...o });

function erro(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e; }
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const em = (v) => txt(v).toLowerCase();
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 160;
const TIPOS = ["admissao", "rescisao"];
const TIPO_ROT = { admissao: "Admissão", rescisao: "Rescisão" };
const PREFIXO = { admissao: "ADM", rescisao: "RES" };
const SUBTIPOS = {
  admissao: ["CLT prazo indeterminado", "Contrato de experiência", "Aprendiz", "Estágio", "Temporário"],
  rescisao: ["Dispensa sem justa causa", "Pedido de demissão", "Término de contrato de experiência", "Acordo entre as partes (art. 484-A)", "Dispensa por justa causa", "Término de contrato temporário ou aprendiz", "Outros"],
};
const DIA_MIN = 600;                // 1 dia útil = 10 h de expediente
const PRAZO_LEGAL_DIAS = 10;        // art. 477, §6º da CLT: pagamento das verbas e documentos até 10 dias corridos do término do contrato
const RISCO = 0.8;                  // 80% do prazo usado = em risco
const ABERTOS = ["em_andamento", "pausado"];

async function comTransacao(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

// ---------- quem é a pessoa ----------
async function papelDe(acc) {
  if (acc.role === "admin") return { papel: "gestor", admin: true, nome: acc.nome || acc.email, email: em(acc.email) };
  const { rows } = await pool.query("SELECT nome, papel, ativo FROM adm_equipe WHERE lower(email) = $1", [em(acc.email)]);
  if (!rows[0] || !rows[0].ativo) throw erro(403, "Seu usuário não está na equipe de Admissão e Rescisão. Peça ao gestor para cadastrar.");
  return { papel: rows[0].papel === "gestor" ? "gestor" : "analista", admin: false, nome: rows[0].nome || acc.nome || acc.email, email: em(acc.email) };
}
function exigirGestor(p) { if (p.papel !== "gestor") throw erro(403, "Só o gestor pode fazer isso."); }
function exigirAdmin(p) { if (!p.admin) throw erro(403, "Só o administrador pode fazer isso."); }

// ---------- datas e CPF ----------
const dstr = (v) => (v ? (v instanceof Date ? diaLocal(v) : String(v).slice(0, 10)) : null);
const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00Z").getTime());
const somaDias = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);
function cpfDigitos(v) { return txt(v).replace(/\D/g, ""); }
function cpfValido(c) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) { let s = 0; for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i); const d = ((s * 10) % 11) % 10; if (d !== Number(c[t])) return false; }
  return true;
}
const cpfMasc = (c) => (c && c.length === 11 ? `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**` : null);
const cpfFmt = (c) => (c && c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : null);

// ---------- SLA ----------
// minutos úteis entre a e b, descontando as pausas
function usado(a, b, pausas) {
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (!(tb > ta)) return 0;
  let m = minutosUteis(a, b);
  for (const p of pausas) {
    const pi = Math.max(new Date(p.inicio).getTime(), ta), pf = Math.min(p.fim ? new Date(p.fim).getTime() : tb, tb);
    if (pf > pi) m -= minutosUteis(new Date(pi), new Date(pf));
  }
  return Math.max(0, Math.round(m * 10) / 10);
}
function situacaoRelogio(dec, meta, { pausado = false } = {}) {
  if (dec > meta) return "estourado";
  if (pausado) return "pausado";
  return dec >= meta * RISCO ? "risco" : "ok";
}
const GRAV = { estourado: 0, risco: 1, ok: 2, pausado: 3 };
const pior = (...s) => s.filter((x) => x in GRAV).sort((a, b) => GRAV[a] - GRAV[b])[0] || "ok";

// Prazo "de calendário": admissão = data de início do colaborador; rescisão = 10 dias corridos do fim do contrato (CLT art. 477 §6º).
function prazoData(proc, agora) {
  const limite = proc.tipo === "admissao" ? dstr(proc.data_prevista) : somaDias(dstr(proc.data_prevista), PRAZO_LEGAL_DIAS);
  const rotulo = proc.tipo === "admissao" ? "Início do colaborador" : "Prazo legal de pagamento";
  const hoje = diaLocal(agora);
  if (proc.status === "cancelado") return { rotulo, limite, situacao: "cancelado", dias: null };
  if (proc.status === "concluido") {
    const fim = diaLocal(proc.concluido_em);
    return { rotulo, limite, situacao: fim <= limite ? "cumprido" : "descumprido", dias: diasEntre(fim, limite) };
  }
  const dias = diasEntre(hoje, limite);
  return { rotulo, limite, situacao: dias < 0 ? "estourado" : dias <= 2 ? "risco" : "ok", dias };
}

function monta(proc, etapasRows, pausas, agora = new Date()) {
  const etapas = etapasRows.slice().sort((a, b) => a.ordem - b.ordem || a.id - b.id);
  const aberto = ABERTOS.includes(proc.status);
  const fimTotal = proc.status === "concluido" ? proc.concluido_em : proc.status === "cancelado" ? proc.atualizado_em : agora;
  const atual = aberto || proc.status === "concluido" ? etapas.find((e) => e.status === "pendente") : null;
  let ini = proc.criado_em;
  const lista = etapas.map((e) => {
    const inicio = ini;
    let o = { id: e.id, nome: e.nome, descricao: e.descricao, area: e.area, ordem: e.ordem, prazo_min: e.prazo_min, status: e.status, obs: e.obs, concluida_em: e.concluida_em, concluida_por: e.concluida_por, iniciada_em: null, decorrido: null, restante: null, situacao: "aguardando", atual: false };
    if (e.status === "concluida" || e.status === "dispensada") {
      o.iniciada_em = inicio;
      if (e.status === "concluida") { o.decorrido = usado(inicio, e.concluida_em, pausas); o.restante = Math.round((e.prazo_min - o.decorrido) * 10) / 10; o.situacao = o.decorrido <= e.prazo_min ? "cumprida" : "descumprida"; }
      else o.situacao = "dispensada";
      ini = e.concluida_em;
    } else if (atual && e.id === atual.id && proc.status !== "cancelado") {
      o.atual = true; o.iniciada_em = inicio;
      o.decorrido = usado(inicio, fimTotal, pausas); o.restante = Math.round((e.prazo_min - o.decorrido) * 10) / 10;
      o.situacao = situacaoRelogio(o.decorrido, e.prazo_min, { pausado: proc.status === "pausado" });
    } else if (proc.status === "cancelado") o.situacao = "cancelada";
    return o;
  });
  const decTot = usado(proc.criado_em, fimTotal, pausas);
  const total = { meta: proc.sla_total_min, decorrido: decTot, restante: Math.round((proc.sla_total_min - decTot) * 10) / 10, situacao: "ok" };
  if (proc.status === "concluido") total.situacao = decTot <= proc.sla_total_min ? "cumprido" : "descumprido";
  else if (proc.status === "cancelado") total.situacao = "cancelado";
  else total.situacao = situacaoRelogio(decTot, proc.sla_total_min, { pausado: proc.status === "pausado" });
  const pd = prazoData(proc, agora);
  const ea = lista.find((e) => e.atual);
  const situacao = aberto ? pior(total.situacao, ea ? ea.situacao : "ok", pd.situacao === "estourado" ? "estourado" : pd.situacao === "risco" ? "risco" : null) : proc.status;
  const feitas = lista.filter((e) => e.status !== "pendente").length;
  const pa = pausas.find((p) => !p.fim);
  return {
    id: proc.id, protocolo: proc.protocolo, tipo: proc.tipo, tipo_rotulo: TIPO_ROT[proc.tipo], colaborador: proc.colaborador, cpf_mascarado: cpfMasc(proc.cpf), cargo: proc.cargo,
    loja_id: proc.loja_id, unidade: proc.unidade, subtipo: proc.subtipo, data_prevista: dstr(proc.data_prevista), observacao: proc.observacao,
    responsavel: proc.responsavel, responsavel_nome: proc.responsavel_nome || null, status: proc.status, criado_por: proc.criado_por, criado_em: proc.criado_em, concluido_em: proc.concluido_em, cancelado_motivo: proc.cancelado_motivo,
    sla_total_min: proc.sla_total_min, total, prazo_data: pd, situacao, progresso: { feitas, total: lista.length },
    etapa_atual: ea ? { id: ea.id, nome: ea.nome, area: ea.area, ordem: ea.ordem, prazo_min: ea.prazo_min, decorrido: ea.decorrido, restante: ea.restante, situacao: ea.situacao } : null,
    pausa: pa ? { desde: pa.inicio, motivo: pa.motivo } : null, etapas: lista,
  };
}

const COLS = `p.id::int AS id, p.protocolo, p.tipo, p.colaborador, p.cpf, p.cargo, p.loja_id::int AS loja_id, p.unidade, p.subtipo, p.data_prevista, p.observacao, p.responsavel, p.status,
  p.sla_total_min, p.criado_por, p.criado_em, p.concluido_em, p.cancelado_motivo, p.atualizado_em, r.nome AS responsavel_nome`;
const FROM = "FROM adm_processos p LEFT JOIN adm_equipe r ON lower(r.email) = lower(p.responsavel)";

async function carregarLista(where, params, limite = 2000) {
  const { rows } = await pool.query(`SELECT ${COLS} ${FROM} ${where ? "WHERE " + where : ""} ORDER BY p.criado_em DESC LIMIT ${Number(limite) || 2000}`, params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: et } = await pool.query("SELECT id::int AS id, processo_id::int AS processo_id, nome, descricao, area, ordem, prazo_min, status, concluida_em, concluida_por, obs FROM adm_proc_etapas WHERE processo_id = ANY($1::bigint[])", [ids]);
  const { rows: ps } = await pool.query("SELECT processo_id::int AS processo_id, inicio, fim, motivo FROM adm_pausas WHERE processo_id = ANY($1::bigint[]) ORDER BY inicio", [ids]);
  const agora = new Date();
  return rows.map((r) => monta(r, et.filter((e) => e.processo_id === r.id), ps.filter((x) => x.processo_id === r.id), agora));
}
async function carregarUm(id, c = pool) {
  const { rows } = await c.query(`SELECT ${COLS} ${FROM} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw erro(404, "Processo não encontrado.");
  const { rows: et } = await c.query("SELECT id::int AS id, nome, descricao, area, ordem, prazo_min, status, concluida_em, concluida_por, obs FROM adm_proc_etapas WHERE processo_id = $1", [id]);
  const { rows: ps } = await c.query("SELECT inicio, fim, motivo FROM adm_pausas WHERE processo_id = $1 ORDER BY inicio", [id]);
  return { raw: rows[0], etapas: et, pausas: ps };
}
async function evento(c, processoId, tipo, usuario, detalhe) {
  await c.query("INSERT INTO adm_eventos (processo_id, tipo, usuario, detalhe) VALUES ($1,$2,$3,$4)", [processoId, tipo, usuario || null, detalhe ? JSON.stringify(detalhe) : null]);
}

// ---------- /eu ----------
async function responsaveis() {
  const { rows } = await pool.query(`SELECT email, coalesce(nome, email) AS nome FROM adm_equipe WHERE ativo
    UNION SELECT email, coalesce(nome, email) FROM users WHERE role = 'admin' ORDER BY 2`);
  const vistos = new Set();
  return rows.filter((r) => (vistos.has(r.email.toLowerCase()) ? false : vistos.add(r.email.toLowerCase())));
}
async function eu(acc) {
  const p = await papelDe(acc);
  const { rows: lj } = await pool.query("SELECT id::int AS id, nome FROM ch_lojas WHERE ativa ORDER BY nome");
  return { nome: p.nome, email: p.email, papel: p.papel, admin: !!p.admin, tipos: TIPO_ROT, subtipos: SUBTIPOS, prazo_legal_dias: PRAZO_LEGAL_DIAS,
    expediente: { inicio_min: expediente.inicioMin, fim_min: expediente.fimMin, dias: expediente.dias }, lojas: lj, responsaveis: await responsaveis(), trocar_senha: !!acc.trocar_senha };
}

// ---------- processos ----------
async function totalPadrao(tipo, c = pool) {
  const { rows: cf } = await c.query("SELECT valor FROM adm_config WHERE chave = $1", ["sla_total_" + tipo]);
  const v = Number(cf[0] && cf[0].valor);
  if (v > 0) return Math.round(v);
  const { rows } = await c.query("SELECT coalesce(sum(prazo_min),0)::int AS s FROM adm_etapas_modelo WHERE tipo = $1 AND ativo", [tipo]);
  return rows[0].s;
}
async function criar(acc, b = {}) {
  const p = await papelDe(acc);
  const tipo = txt(b.tipo);
  if (!TIPOS.includes(tipo)) throw erro(400, "Escolha se é admissão ou rescisão.");
  const colaborador = txt(b.colaborador).slice(0, 120);
  if (colaborador.length < 3) throw erro(400, "Informe o nome do colaborador.");
  const cpf = cpfDigitos(b.cpf);
  if (cpf && !cpfValido(cpf)) throw erro(400, "CPF inválido. Confira os números.");
  const dataPrev = txt(b.data_prevista);
  if (!dataOk(dataPrev)) throw erro(400, tipo === "admissao" ? "Informe a data de início do colaborador." : "Informe a data do término do contrato.");
  const subtipo = txt(b.subtipo).slice(0, 80);
  if (tipo === "rescisao" && !subtipo) throw erro(400, "Informe o tipo de rescisão.");
  const cargo = txt(b.cargo).slice(0, 100);
  let lojaId = Number(b.loja_id) || null, unidade = txt(b.unidade).slice(0, 120);
  if (lojaId) { const { rows } = await pool.query("SELECT nome FROM ch_lojas WHERE id = $1", [lojaId]); if (!rows[0]) throw erro(400, "Loja não encontrada."); unidade = rows[0].nome; }
  if (!unidade) throw erro(400, "Informe a loja ou o local de trabalho.");
  let resp = em(b.responsavel) || p.email;
  const { rows: rr } = await pool.query("SELECT 1 FROM adm_equipe WHERE lower(email) = $1 AND ativo UNION SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [resp]);
  if (!rr[0]) throw erro(400, "O responsável precisa ser da equipe.");
  if (cpf) {
    const { rows: dup } = await pool.query("SELECT protocolo FROM adm_processos WHERE cpf = $1 AND tipo = $2 AND status IN ('em_andamento','pausado') LIMIT 1", [cpf, tipo]);
    if (dup[0]) throw erro(409, `Já existe um processo de ${TIPO_ROT[tipo].toLowerCase()} em andamento para esse CPF (${dup[0].protocolo}).`);
  }
  const info = await comTransacao(async (c) => {
    const { rows: md } = await c.query("SELECT id, nome, descricao, area, prazo_min, ordem FROM adm_etapas_modelo WHERE tipo = $1 AND ativo ORDER BY ordem, id", [tipo]);
    if (!md.length) throw erro(400, "Não há etapas ativas para esse tipo. Cadastre as etapas em Cadastros.");
    const total = await totalPadrao(tipo, c);
    const { rows } = await c.query(`INSERT INTO adm_processos (protocolo, tipo, colaborador, cpf, cargo, loja_id, unidade, subtipo, data_prevista, observacao, responsavel, sla_total_min, criado_por)
      VALUES ('tmp-' || nextval('adm_proto_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::int AS id`,
      [tipo, colaborador, cpf || null, cargo || null, lojaId, unidade, subtipo || null, dataPrev, txt(b.observacao).slice(0, 1000) || null, resp, total, p.email]);
    const id = rows[0].id, protocolo = `${PREFIXO[tipo]}-${new Date().getFullYear()}-${String(id).padStart(5, "0")}`;
    await c.query("UPDATE adm_processos SET protocolo = $2 WHERE id = $1", [id, protocolo]);
    let o = 0;
    for (const m of md) await c.query("INSERT INTO adm_proc_etapas (processo_id, modelo_id, nome, descricao, area, ordem, prazo_min) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, m.id, m.nome, m.descricao, m.area, ++o, m.prazo_min]);
    await evento(c, id, "criado", p.email, { tipo, responsavel: resp });
    return { id, protocolo };
  });
  audit(acc, "adm_criado", { papel: p.papel, alvo: info.protocolo, detalhe: TIPO_ROT[tipo] + " · " + unidade });
  return { ok: true, id: info.id, protocolo: info.protocolo };
}

async function listar(acc, f = {}) {
  await papelDe(acc);
  const w = [], v = [];
  const add = (x) => { v.push(x); return "$" + v.length; };
  if (TIPOS.includes(f.tipo)) w.push(`p.tipo = ${add(f.tipo)}`);
  if (f.status === "abertos" || !f.status) w.push("p.status IN ('em_andamento','pausado')");
  else if (f.status === "fechados") w.push("p.status IN ('concluido','cancelado')");
  else if (["em_andamento", "pausado", "concluido", "cancelado"].includes(f.status)) w.push(`p.status = ${add(f.status)}`);
  if (Number(f.loja_id)) w.push(`p.loja_id = ${add(Number(f.loja_id))}`);
  if (f.responsavel === "eu") w.push(`lower(p.responsavel) = ${add(em(acc.email))}`);
  else if (f.responsavel === "sem") w.push("p.responsavel IS NULL");
  else if (f.responsavel && String(f.responsavel).includes("@")) w.push(`lower(p.responsavel) = ${add(em(f.responsavel))}`);
  if (dataOk(txt(f.de))) w.push(`p.criado_em >= ${add(f.de + "T00:00:00-03:00")}`);
  if (dataOk(txt(f.ate))) w.push(`p.criado_em < ${add(f.ate + "T00:00:00-03:00")}::timestamptz + interval '1 day'`);
  if (txt(f.q)) { const q = add("%" + txt(f.q).toLowerCase() + "%"); w.push(`(lower(p.protocolo) LIKE ${q} OR lower(p.colaborador) LIKE ${q} OR lower(coalesce(p.cargo,'')) LIKE ${q} OR lower(p.unidade) LIKE ${q})`); }
  let lista = await carregarLista(w.join(" AND "), v);
  if (f.sla === "estourado") lista = lista.filter((x) => x.situacao === "estourado");
  else if (f.sla === "risco") lista = lista.filter((x) => x.situacao === "risco");
  else if (f.sla === "atencao") lista = lista.filter((x) => x.situacao === "estourado" || x.situacao === "risco");
  const ab = lista.filter((x) => ABERTOS.includes(x.status));
  const fe = lista.filter((x) => !ABERTOS.includes(x.status));
  ab.sort((a, b) => (GRAV[a.situacao] ?? 9) - (GRAV[b.situacao] ?? 9) || (a.prazo_data.limite < b.prazo_data.limite ? -1 : 1));
  const ordenada = ab.concat(fe);
  const contagem = {}; lista.forEach((x) => { contagem[x.status] = (contagem[x.status] || 0) + 1; });
  const lim = Math.min(Number(f.limite) || 300, 1000);
  return { processos: ordenada.slice(0, lim).map((x) => ({ ...x, etapas: undefined })), total: ordenada.length, contagem };
}

async function detalhe(acc, id) {
  const p = await papelDe(acc);
  const { raw, etapas, pausas } = await carregarUm(id);
  audit(acc, "adm_ver", { papel: p.papel, alvo: raw.protocolo, detalhe: raw.colaborador }); // quem leu os dados pessoais (LGPD)
  const proc = monta(raw, etapas, pausas);
  proc.cpf = cpfFmt(raw.cpf);
  const { rows: ev } = await pool.query("SELECT tipo, usuario, detalhe, criado_em FROM adm_eventos WHERE processo_id = $1 ORDER BY criado_em, id", [id]);
  const { rows: ps } = await pool.query("SELECT inicio, fim, motivo, usuario FROM adm_pausas WHERE processo_id = $1 ORDER BY inicio", [id]);
  return { processo: proc, eventos: ev, pausas: ps };
}

async function editar(acc, id, b = {}) {
  const p = await papelDe(acc);
  const { raw } = await carregarUm(id);
  if (!ABERTOS.includes(raw.status) && !p.admin && p.papel !== "gestor") throw erro(409, "Processo encerrado. Só o gestor altera.");
  if (raw.status === "cancelado") throw erro(409, "Processo cancelado não pode ser editado.");
  const sets = [], v = [id];
  const set = (col, val) => { v.push(val); sets.push(`${col} = $${v.length}`); };
  if (b.colaborador !== undefined) { const n = txt(b.colaborador).slice(0, 120); if (n.length < 3) throw erro(400, "Informe o nome do colaborador."); set("colaborador", n); }
  if (b.cpf !== undefined) { const c = cpfDigitos(b.cpf); if (c && !cpfValido(c)) throw erro(400, "CPF inválido. Confira os números."); set("cpf", c || null); }
  if (b.cargo !== undefined) set("cargo", txt(b.cargo).slice(0, 100) || null);
  if (b.subtipo !== undefined) set("subtipo", txt(b.subtipo).slice(0, 80) || null);
  if (b.observacao !== undefined) set("observacao", txt(b.observacao).slice(0, 1000) || null);
  if (b.data_prevista !== undefined) { if (!dataOk(txt(b.data_prevista))) throw erro(400, "Data inválida."); set("data_prevista", txt(b.data_prevista)); }
  if (b.loja_id !== undefined || b.unidade !== undefined) {
    const lojaId = Number(b.loja_id) || null; let un = txt(b.unidade).slice(0, 120);
    if (lojaId) { const { rows } = await pool.query("SELECT nome FROM ch_lojas WHERE id = $1", [lojaId]); if (!rows[0]) throw erro(400, "Loja não encontrada."); un = rows[0].nome; }
    if (!un) throw erro(400, "Informe a loja ou o local de trabalho.");
    set("loja_id", lojaId); set("unidade", un);
  }
  if (!sets.length) throw erro(400, "Nada para alterar.");
  await pool.query(`UPDATE adm_processos SET ${sets.join(", ")}, atualizado_em = now() WHERE id = $1`, v);
  await evento(pool, id, "editado", p.email, { campos: Object.keys(b).filter((k) => ["colaborador", "cpf", "cargo", "subtipo", "observacao", "data_prevista", "loja_id", "unidade"].includes(k)) });
  audit(acc, "adm_editado", { papel: p.papel, alvo: raw.protocolo });
  return { ok: true };
}

// etapa atual = a primeira pendente; as etapas vão em ordem
async function etapaAtual(c, id, etapaId) {
  const { raw, etapas, pausas } = await carregarUm(id, c);
  if (!ABERTOS.includes(raw.status)) throw erro(409, raw.status === "concluido" ? "Processo já concluído." : "Processo cancelado.");
  if (raw.status === "pausado") throw erro(409, "O processo está pausado. Retome antes de avançar.");
  const ord = etapas.slice().sort((a, b) => a.ordem - b.ordem || a.id - b.id);
  const atual = ord.find((e) => e.status === "pendente");
  if (!atual || atual.id !== Number(etapaId)) throw erro(409, "Só a etapa atual pode ser concluída. Atualize a tela.");
  const idx = ord.indexOf(atual);
  const ini = idx === 0 ? raw.criado_em : ord[idx - 1].concluida_em;
  return { raw, ord, atual, ini, ultima: idx === ord.length - 1, pausas };
}
function quando(b, ini) {
  if (!b.concluida_em) return new Date();
  const d = new Date(b.concluida_em);
  if (isNaN(d.getTime())) throw erro(400, "Data e hora inválidas.");
  if (d.getTime() > Date.now() + 60000) throw erro(400, "A conclusão não pode estar no futuro.");
  if (d.getTime() < new Date(ini).getTime()) throw erro(400, "A conclusão não pode ser anterior ao início da etapa.");
  return d;
}
async function concluirEtapa(acc, id, etapaId, b = {}) {
  const p = await papelDe(acc);
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const e = await etapaAtual(c, id, etapaId);
    const quand = quando(b, e.ini);
    await c.query("UPDATE adm_proc_etapas SET status = 'concluida', concluida_em = $2, concluida_por = $3, obs = $4 WHERE id = $1", [e.atual.id, quand, p.email, txt(b.obs).slice(0, 500) || null]);
    if (e.ultima) await c.query("UPDATE adm_processos SET status = 'concluido', concluido_em = $2, atualizado_em = now() WHERE id = $1", [id, quand]);
    else await c.query("UPDATE adm_processos SET atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "etapa_concluida", p.email, { etapa: e.atual.nome, ordem: e.atual.ordem, quando: quand, obs: txt(b.obs).slice(0, 500) || null, final: e.ultima });
    return { protocolo: e.raw.protocolo, final: e.ultima, etapa: e.atual.nome };
  });
  audit(acc, r.final ? "adm_concluido" : "adm_etapa_concluida", { papel: p.papel, alvo: r.protocolo, detalhe: r.etapa });
  return { ok: true, concluido: r.final };
}
async function dispensarEtapa(acc, id, etapaId, b = {}) {
  const p = await papelDe(acc);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Explique por que a etapa não se aplica (mínimo 5 letras).");
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const e = await etapaAtual(c, id, etapaId);
    await c.query("UPDATE adm_proc_etapas SET status = 'dispensada', concluida_em = $2, concluida_por = $3, obs = $4 WHERE id = $1", [e.atual.id, e.ini, p.email, motivo]);
    if (e.ultima) await c.query("UPDATE adm_processos SET status = 'concluido', concluido_em = now(), atualizado_em = now() WHERE id = $1", [id]);
    else await c.query("UPDATE adm_processos SET atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "etapa_dispensada", p.email, { etapa: e.atual.nome, ordem: e.atual.ordem, motivo, final: e.ultima });
    return { protocolo: e.raw.protocolo, etapa: e.atual.nome, final: e.ultima };
  });
  audit(acc, "adm_etapa_dispensada", { papel: p.papel, alvo: r.protocolo, detalhe: r.etapa });
  return { ok: true, concluido: r.final };
}
// desfaz a última etapa concluída ou dispensada (engano de clique)
async function reabrirEtapa(acc, id, b = {}) {
  const p = await papelDe(acc);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Explique por que a etapa volta (mínimo 5 letras).");
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const { raw, etapas } = await carregarUm(id, c);
    if (raw.status === "cancelado") throw erro(409, "Processo cancelado.");
    if (raw.status === "concluido" && p.papel !== "gestor") throw erro(403, "Só o gestor reabre um processo concluído.");
    const feitas = etapas.filter((e) => e.status !== "pendente").sort((a, b2) => b2.ordem - a.ordem || b2.id - a.id);
    if (!feitas.length) throw erro(409, "Nenhuma etapa concluída para voltar.");
    const ult = feitas[0];
    await c.query("UPDATE adm_proc_etapas SET status = 'pendente', concluida_em = NULL, concluida_por = NULL, obs = NULL WHERE id = $1", [ult.id]);
    await c.query("UPDATE adm_processos SET status = CASE WHEN status = 'concluido' THEN 'em_andamento' ELSE status END, concluido_em = NULL, atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "etapa_reaberta", p.email, { etapa: ult.nome, ordem: ult.ordem, motivo });
    return { protocolo: raw.protocolo, etapa: ult.nome };
  });
  audit(acc, "adm_etapa_reaberta", { papel: p.papel, alvo: r.protocolo, detalhe: r.etapa });
  return { ok: true };
}
async function pausar(acc, id, b = {}) {
  const p = await papelDe(acc);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Diga o que está sendo aguardado (mínimo 5 letras).");
  const protocolo = await comTransacao(async (c) => {
    const { rows } = await c.query("SELECT protocolo, status FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw erro(404, "Processo não encontrado.");
    if (rows[0].status !== "em_andamento") throw erro(409, "Só dá para pausar um processo em andamento.");
    await c.query("INSERT INTO adm_pausas (processo_id, motivo, usuario) VALUES ($1,$2,$3)", [id, motivo, p.email]);
    await c.query("UPDATE adm_processos SET status = 'pausado', atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "pausado", p.email, { motivo });
    return rows[0].protocolo;
  });
  audit(acc, "adm_pausado", { papel: p.papel, alvo: protocolo, detalhe: motivo });
  return { ok: true };
}
async function retomar(acc, id) {
  const p = await papelDe(acc);
  const protocolo = await comTransacao(async (c) => {
    const { rows } = await c.query("SELECT protocolo, status FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw erro(404, "Processo não encontrado.");
    if (rows[0].status !== "pausado") throw erro(409, "O processo não está pausado.");
    await c.query("UPDATE adm_pausas SET fim = now() WHERE processo_id = $1 AND fim IS NULL", [id]);
    await c.query("UPDATE adm_processos SET status = 'em_andamento', atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "retomado", p.email, null);
    return rows[0].protocolo;
  });
  audit(acc, "adm_retomado", { papel: p.papel, alvo: protocolo });
  return { ok: true };
}
async function atribuir(acc, id, b = {}) {
  const p = await papelDe(acc);
  const email = em(b.responsavel);
  const { rows: rr } = await pool.query("SELECT 1 FROM adm_equipe WHERE lower(email) = $1 AND ativo UNION SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [email]);
  if (!rr[0]) throw erro(400, "O responsável precisa ser da equipe.");
  const { raw } = await carregarUm(id);
  if (!ABERTOS.includes(raw.status)) throw erro(409, "Processo encerrado.");
  await pool.query("UPDATE adm_processos SET responsavel = $2, atualizado_em = now() WHERE id = $1", [id, email]);
  await evento(pool, id, "responsavel", p.email, { de: raw.responsavel, para: email });
  audit(acc, "adm_responsavel", { papel: p.papel, alvo: raw.protocolo, detalhe: email });
  return { ok: true };
}
async function nota(acc, id, b = {}) {
  const p = await papelDe(acc);
  const t = txt(b.texto).slice(0, 1000);
  if (t.length < 2) throw erro(400, "Escreva a anotação.");
  const { rows } = await pool.query("SELECT 1 FROM adm_processos WHERE id = $1", [id]);
  if (!rows[0]) throw erro(404, "Processo não encontrado.");
  await evento(pool, id, "nota", p.email, { texto: t, nome: p.nome });
  return { ok: true };
}
async function cancelar(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Informe o motivo do cancelamento (mínimo 5 letras).");
  const protocolo = await comTransacao(async (c) => {
    const { rows } = await c.query("SELECT protocolo, status FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw erro(404, "Processo não encontrado.");
    if (!ABERTOS.includes(rows[0].status)) throw erro(409, "Só dá para cancelar um processo em andamento.");
    await c.query("UPDATE adm_pausas SET fim = now() WHERE processo_id = $1 AND fim IS NULL", [id]);
    await c.query("UPDATE adm_processos SET status = 'cancelado', cancelado_motivo = $2, atualizado_em = now() WHERE id = $1", [id, motivo]);
    await evento(c, id, "cancelado", p.email, { motivo });
    return rows[0].protocolo;
  });
  audit(acc, "adm_cancelado", { papel: p.papel, alvo: protocolo, detalhe: motivo });
  return { ok: true };
}
// Exclusão definitiva: só o administrador e digitando o protocolo (serve para limpar testes). A auditoria guarda quem excluiu.
async function excluir(acc, id, b = {}) {
  const p = await papelDe(acc); exigirAdmin(p);
  const { rows } = await pool.query("SELECT protocolo, colaborador FROM adm_processos WHERE id = $1", [id]);
  if (!rows[0]) throw erro(404, "Processo não encontrado.");
  if (txt(b.confirmar).toUpperCase() !== rows[0].protocolo.toUpperCase()) throw erro(400, "Digite o protocolo do processo para confirmar a exclusão.");
  await pool.query("DELETE FROM adm_processos WHERE id = $1", [id]);
  audit(acc, "adm_excluido", { papel: p.papel, alvo: rows[0].protocolo, detalhe: "excluído definitivamente" });
  return { ok: true };
}
// ajusta os prazos de UM processo (total e/ou etapas ainda não concluídas)
async function ajustarPrazos(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Informe o motivo do ajuste (mínimo 5 letras).");
  const r = await comTransacao(async (c) => {
    const { raw, etapas } = await carregarUm(id, c);
    if (!ABERTOS.includes(raw.status)) throw erro(409, "Processo encerrado.");
    const antes = { total: raw.sla_total_min, etapas: {} }, depois = { total: raw.sla_total_min, etapas: {} };
    if (b.total_min !== undefined) {
      const t = Math.round(Number(b.total_min)); if (!(t > 0)) throw erro(400, "Informe o prazo total maior que zero.");
      await c.query("UPDATE adm_processos SET sla_total_min = $2 WHERE id = $1", [id, t]); depois.total = t;
    }
    for (const it of Array.isArray(b.etapas) ? b.etapas : []) {
      const e = etapas.find((x) => x.id === Number(it.id));
      if (!e) throw erro(400, "Etapa não encontrada.");
      if (e.status !== "pendente") continue;
      const pm = Math.round(Number(it.prazo_min)); if (!(pm > 0)) throw erro(400, "Os prazos das etapas precisam ser maiores que zero.");
      if (pm !== e.prazo_min) { await c.query("UPDATE adm_proc_etapas SET prazo_min = $2 WHERE id = $1", [e.id, pm]); antes.etapas[e.nome] = e.prazo_min; depois.etapas[e.nome] = pm; }
    }
    await c.query("UPDATE adm_processos SET atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "prazos_alterados", p.email, { de: antes, para: depois, motivo });
    return raw.protocolo;
  });
  audit(acc, "adm_prazos_alterados", { papel: p.papel, alvo: r, detalhe: motivo });
  return { ok: true };
}

// ---------- cadastros: etapas ----------
async function listarEtapasModelo(acc, f = {}) {
  await papelDe(acc);
  const { rows } = await pool.query("SELECT id::int AS id, tipo, nome, descricao, area, prazo_min, ordem, ativo FROM adm_etapas_modelo " + (TIPOS.includes(f.tipo) ? "WHERE tipo = $1 " : "") + "ORDER BY tipo, ordem, id", TIPOS.includes(f.tipo) ? [f.tipo] : []);
  const cfg = {};
  for (const t of TIPOS) { const { rows: c } = await pool.query("SELECT valor FROM adm_config WHERE chave = $1", ["sla_total_" + t]); cfg[t] = { definido: Number(c[0] && c[0].valor) || null, soma: rows.filter((r) => r.tipo === t && r.ativo).reduce((s, r) => s + r.prazo_min, 0) }; }
  return { etapas: rows, totais: cfg };
}
async function salvarEtapaModelo(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const nome = txt(b.nome).slice(0, 140);
  if (nome.length < 3) throw erro(400, "Informe o nome da etapa.");
  const prazo = Math.round(Number(b.prazo_min));
  if (!(prazo > 0)) throw erro(400, "Informe o prazo da etapa (maior que zero).");
  const area = txt(b.area).slice(0, 60) || null, desc = txt(b.descricao).slice(0, 400) || null;
  try {
    if (id) {
      const { rows } = await pool.query("UPDATE adm_etapas_modelo SET nome=$2, descricao=$3, area=$4, prazo_min=$5, ordem=COALESCE($6, ordem), ativo=COALESCE($7, ativo) WHERE id=$1 RETURNING id", [id, nome, desc, area, prazo, b.ordem === undefined ? null : Math.round(Number(b.ordem)), b.ativo === undefined ? null : !!b.ativo]);
      if (!rows[0]) throw erro(404, "Etapa não encontrada.");
    } else {
      const tipo = txt(b.tipo); if (!TIPOS.includes(tipo)) throw erro(400, "Escolha o tipo (admissão ou rescisão).");
      const { rows: mx } = await pool.query("SELECT coalesce(max(ordem),0)::int AS m FROM adm_etapas_modelo WHERE tipo = $1", [tipo]);
      await pool.query("INSERT INTO adm_etapas_modelo (tipo, nome, descricao, area, prazo_min, ordem) VALUES ($1,$2,$3,$4,$5,$6)", [tipo, nome, desc, area, prazo, b.ordem === undefined || b.ordem === "" ? mx[0].m + 1 : Math.round(Number(b.ordem))]);
    }
  } catch (e) { if (e.code === "23505") throw erro(409, "Já existe uma etapa com esse nome nesse tipo."); throw e; }
  audit(acc, "adm_etapa_modelo", { papel: p.papel, alvo: nome, detalhe: id ? "editada" : "criada" });
  return { ok: true };
}
async function salvarConfig(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  for (const t of TIPOS) {
    if (b["sla_total_" + t] === undefined) continue;
    const v = b["sla_total_" + t];
    if (v === null || v === "") { await pool.query("DELETE FROM adm_config WHERE chave = $1", ["sla_total_" + t]); continue; }
    const n = Math.round(Number(v)); if (!(n > 0)) throw erro(400, "O prazo total precisa ser maior que zero.");
    await pool.query("INSERT INTO adm_config (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", ["sla_total_" + t, String(n)]);
  }
  audit(acc, "adm_config", { papel: p.papel, detalhe: "prazo total" });
  return { ok: true };
}

// ---------- equipe e acessos ----------
async function garantirAcesso(email, nome, senha) {
  const e = em(email);
  const { rows } = await pool.query("SELECT id FROM users WHERE lower(email) = $1", [e]);
  if (rows[0]) {
    await pool.query("UPDATE users SET modules = (SELECT array_agg(DISTINCT x) FROM unnest(modules || ARRAY['admissao']) x), nome = COALESCE(nome, $2) WHERE id = $1", [rows[0].id, nome || null]);
    if (senha) {
      if (String(senha).length < 8) throw erro(400, "A senha precisa de pelo menos 8 caracteres.");
      await pool.query("UPDATE users SET password_hash = $2, trocar_senha = true, token_version = token_version + 1 WHERE id = $1", [rows[0].id, await bcrypt.hash(String(senha), 10)]);
    }
    return { criado: false };
  }
  if (!senha) throw erro(400, "Esse e-mail ainda não tem usuário no sistema: informe uma senha inicial (mínimo 8 caracteres).");
  if (String(senha).length < 8) throw erro(400, "A senha precisa de pelo menos 8 caracteres.");
  await pool.query("INSERT INTO users (email, password_hash, role, nome, modules, cd_perfis, trocar_senha) VALUES ($1,$2,'viewer',$3,ARRAY['admissao'],'{}', true)", [e, await bcrypt.hash(String(senha), 10), nome || null]);
  return { criado: true };
}
async function listarEquipe(acc) {
  const p = await papelDe(acc); exigirGestor(p);
  const { rows } = await pool.query(`SELECT e.id::int AS id, e.email, e.nome, e.papel, e.ativo, (u.id IS NOT NULL AND ('admissao' = ANY(u.modules) OR u.role = 'admin')) AS tem_acesso
    FROM adm_equipe e LEFT JOIN users u ON lower(u.email) = lower(e.email) ORDER BY e.ativo DESC, e.papel, e.nome NULLS LAST, e.email`);
  const { rows: ad } = await pool.query("SELECT email, nome FROM users WHERE role = 'admin' ORDER BY email");
  return { equipe: rows, administradores: ad };
}
async function criarEquipe(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.email), nome = txt(b.nome).slice(0, 100) || null, papel = txt(b.papel) === "gestor" ? "gestor" : "analista";
  if (!emailValido(email)) throw erro(400, "Informe um e-mail válido.");
  const ac = await garantirAcesso(email, nome, b.senha ? String(b.senha) : undefined);
  await pool.query(`INSERT INTO adm_equipe (email, nome, papel, ativo) VALUES ($1,$2,$3,true)
    ON CONFLICT (lower(email)) DO UPDATE SET papel = EXCLUDED.papel, ativo = true, nome = COALESCE(EXCLUDED.nome, adm_equipe.nome)`, [email, nome, papel]);
  audit(acc, ac.criado ? "acesso_criado" : "acesso_liberado", { papel: p.papel, alvo: email, detalhe: "Admissão e Rescisão · " + papel });
  return { ok: true, acesso_criado: ac.criado };
}
async function editarEquipe(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const { rows } = await pool.query("SELECT email FROM adm_equipe WHERE id = $1", [id]);
  if (!rows[0]) throw erro(404, "Pessoa não encontrada.");
  const email = em(rows[0].email);
  if (email === p.email && (b.ativo === false || (b.papel && b.papel !== "gestor"))) throw erro(400, "Você não pode tirar o seu próprio acesso de gestor.");
  await pool.query("UPDATE adm_equipe SET nome = COALESCE($2, nome), papel = COALESCE($3, papel), ativo = COALESCE($4, ativo) WHERE id = $1", [id, b.nome === undefined ? null : txt(b.nome) || null, b.papel ? (b.papel === "gestor" ? "gestor" : "analista") : null, b.ativo === undefined ? null : !!b.ativo]);
  if (b.ativo === false) await pool.query("UPDATE users SET modules = array_remove(modules, 'admissao'), token_version = token_version + 1 WHERE lower(email) = $1 AND role <> 'admin'", [email]);
  if (b.ativo === true) await garantirAcesso(email, null, undefined);
  audit(acc, b.ativo === false ? "acesso_bloqueado" : "acesso_alterado", { papel: p.papel, alvo: email, detalhe: "Admissão e Rescisão" });
  return { ok: true };
}
async function redefinirSenha(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.email), senha = String(b.senha || "");
  if (senha.length < 8) throw erro(400, "A senha precisa de pelo menos 8 caracteres.");
  const { rows } = await pool.query("SELECT u.id, u.role FROM users u JOIN adm_equipe e ON lower(e.email) = lower(u.email) WHERE lower(u.email) = $1", [email]);
  if (!rows[0]) throw erro(404, "Pessoa não encontrada na equipe.");
  if (rows[0].role === "admin" && email !== p.email) throw erro(403, "A senha de um administrador só ele mesmo redefine.");
  await pool.query("UPDATE users SET password_hash = $2, trocar_senha = $3, token_version = token_version + 1, senha_alterada_em = now() WHERE id = $1", [rows[0].id, await bcrypt.hash(senha, 10), email !== p.email]);
  audit(acc, "senha_redefinida", { papel: p.papel, alvo: email });
  return { ok: true };
}

// ---------- indicadores ----------
const media = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);
const pct = (ok, tot) => (tot ? Math.round((ok / tot) * 1000) / 10 : null);
async function indicadores(acc, f = {}) {
  await papelDe(acc);
  const hoje = diaLocal(new Date());
  const ate = dataOk(txt(f.ate)) ? f.ate : hoje;
  const de = dataOk(txt(f.de)) ? f.de : somaDias(ate, -(Number(f.dias) > 0 ? Number(f.dias) : 90));
  const w = [`p.criado_em >= $1`, `p.criado_em < $2::timestamptz + interval '1 day'`], v = [de + "T00:00:00-03:00", ate + "T00:00:00-03:00"];
  if (TIPOS.includes(f.tipo)) { v.push(f.tipo); w.push(`p.tipo = $${v.length}`); }
  if (Number(f.loja_id)) { v.push(Number(f.loja_id)); w.push(`p.loja_id = $${v.length}`); }
  if (f.responsavel && String(f.responsavel).includes("@")) { v.push(em(f.responsavel)); w.push(`lower(p.responsavel) = $${v.length}`); }
  const per = await carregarLista(w.join(" AND "), v, 5000);
  // abertos agora: independem do período (mas respeitam tipo, loja e responsável)
  const w2 = ["p.status IN ('em_andamento','pausado')"], v2 = [];
  if (TIPOS.includes(f.tipo)) { v2.push(f.tipo); w2.push(`p.tipo = $${v2.length}`); }
  if (Number(f.loja_id)) { v2.push(Number(f.loja_id)); w2.push(`p.loja_id = $${v2.length}`); }
  if (f.responsavel && String(f.responsavel).includes("@")) { v2.push(em(f.responsavel)); w2.push(`lower(p.responsavel) = $${v2.length}`); }
  const abertos = await carregarLista(w2.join(" AND "), v2, 5000);
  const conc = per.filter((x) => x.status === "concluido");
  const validos = per.filter((x) => x.status !== "cancelado");
  const kpis = {
    abertos_agora: abertos.length, pausados: abertos.filter((x) => x.status === "pausado").length,
    estourados: abertos.filter((x) => x.situacao === "estourado").length, em_risco: abertos.filter((x) => x.situacao === "risco").length,
    sem_responsavel: abertos.filter((x) => !x.responsavel).length,
    novos: per.length, admissoes: per.filter((x) => x.tipo === "admissao").length, rescisoes: per.filter((x) => x.tipo === "rescisao").length,
    concluidos: conc.length, cancelados: per.filter((x) => x.status === "cancelado").length,
    no_prazo_total_pct: pct(conc.filter((x) => x.total.situacao === "cumprido").length, conc.length),
    tempo_medio_conclusao_min: media(conc.map((x) => x.total.decorrido)),
    admissoes_antes_inicio_pct: pct(conc.filter((x) => x.tipo === "admissao" && x.prazo_data.situacao === "cumprido").length, conc.filter((x) => x.tipo === "admissao").length),
    rescisoes_prazo_legal_pct: pct(conc.filter((x) => x.tipo === "rescisao" && x.prazo_data.situacao === "cumprido").length, conc.filter((x) => x.tipo === "rescisao").length),
  };
  // por etapa (nome + tipo): tempo médio, % no prazo, estouradas agora (gargalo)
  const mapaEt = new Map();
  const chaveEt = (tipo, e) => tipo + "|" + e.ordem + "|" + e.nome;
  validos.concat(abertos.filter((a) => !validos.some((x) => x.id === a.id))).forEach((proc) => proc.etapas.forEach((e) => {
    const k = chaveEt(proc.tipo, e);
    if (!mapaEt.has(k)) mapaEt.set(k, { tipo: proc.tipo, ordem: e.ordem, nome: e.nome, area: e.area, meta_min: e.prazo_min, feitas: [], no_prazo: 0, fora: 0, atrasadas_agora: 0, atuais: 0 });
    const m = mapaEt.get(k);
    if (e.situacao === "cumprida" || e.situacao === "descumprida") { m.feitas.push(e.decorrido); if (e.situacao === "cumprida") m.no_prazo++; else m.fora++; }
    if (e.atual) { m.atuais++; if (e.situacao === "estourado") m.atrasadas_agora++; }
  }));
  const porEtapa = [...mapaEt.values()].map((m) => ({ tipo: m.tipo, ordem: m.ordem, nome: m.nome, area: m.area, meta_min: m.meta_min, concluidas: m.feitas.length, tempo_medio_min: media(m.feitas), no_prazo_pct: pct(m.no_prazo, m.no_prazo + m.fora), em_andamento: m.atuais, atrasadas_agora: m.atrasadas_agora }))
    .sort((a, b) => (a.tipo < b.tipo ? -1 : a.tipo > b.tipo ? 1 : a.ordem - b.ordem));
  const grupo = (lista, chave, rot) => {
    const g = new Map(); lista.forEach((x) => { const k = chave(x); if (!g.has(k)) g.set(k, []); g.get(k).push(x); });
    return [...g.entries()].map(([k, a]) => {
      const c = a.filter((x) => x.status === "concluido");
      return { chave: k, rotulo: rot ? rot(k, a) : k, volume: a.length, abertos: a.filter((x) => ABERTOS.includes(x.status)).length, atrasados: a.filter((x) => x.situacao === "estourado").length, concluidos: c.length, tempo_medio_min: media(c.map((x) => x.total.decorrido)), no_prazo_pct: pct(c.filter((x) => x.total.situacao === "cumprido").length, c.length) };
    }).sort((a, b) => b.volume - a.volume);
  };
  const porResp = grupo(per.concat(abertos.filter((a) => !per.some((x) => x.id === a.id))), (x) => x.responsavel || "(sem responsável)", (k, a) => a[0].responsavel_nome || k);
  const porLoja = grupo(per, (x) => x.unidade);
  const porSubtipo = grupo(per.filter((x) => x.tipo === "rescisao" && x.status !== "cancelado"), (x) => x.subtipo || "(não informado)");
  // por mês (criados): admissões x rescisões
  const meses = new Map();
  per.filter((x) => x.status !== "cancelado").forEach((x) => { const k = diaLocal(x.criado_em).slice(0, 7); if (!meses.has(k)) meses.set(k, { mes: k, admissoes: 0, rescisoes: 0 }); meses.get(k)[x.tipo === "admissao" ? "admissoes" : "rescisoes"]++; });
  const porMes = [...meses.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1));
  const urgentes = abertos.filter((x) => x.situacao === "estourado" || x.situacao === "risco").sort((a, b) => GRAV[a.situacao] - GRAV[b.situacao] || a.total.restante - b.total.restante).slice(0, 10)
    .map((x) => ({ id: x.id, protocolo: x.protocolo, tipo: x.tipo, colaborador: x.colaborador, unidade: x.unidade, situacao: x.situacao, etapa_atual: x.etapa_atual, total: x.total, prazo_data: x.prazo_data, responsavel_nome: x.responsavel_nome, status: x.status }));
  const proximos = abertos.filter((x) => x.prazo_data.dias !== null && x.prazo_data.dias <= 14).sort((a, b) => a.prazo_data.dias - b.prazo_data.dias).slice(0, 10)
    .map((x) => ({ id: x.id, protocolo: x.protocolo, tipo: x.tipo, colaborador: x.colaborador, unidade: x.unidade, prazo_data: x.prazo_data, progresso: x.progresso, etapa_atual: x.etapa_atual }));
  return { periodo: { de, ate }, kpis, por_etapa: porEtapa, por_responsavel: porResp, por_loja: porLoja, por_subtipo: porSubtipo, por_mes: porMes, mais_urgentes: urgentes, proximos_prazos: proximos,
    lista: per.map((x) => ({ protocolo: x.protocolo, tipo: x.tipo_rotulo, colaborador: x.colaborador, cpf: x.cpf_mascarado, cargo: x.cargo, unidade: x.unidade, subtipo: x.subtipo, data_prevista: x.data_prevista, status: x.status, responsavel: x.responsavel_nome || x.responsavel,
      criado_em: x.criado_em, concluido_em: x.concluido_em, meta_total_min: x.total.meta, tempo_total_min: x.total.decorrido, sla_total: x.total.situacao, prazo_data: x.prazo_data.situacao, prazo_data_limite: x.prazo_data.limite, etapa_atual: x.etapa_atual ? x.etapa_atual.nome : null,
      etapas: x.etapas.map((e) => ({ nome: e.nome, meta_min: e.prazo_min, tempo_min: e.decorrido, situacao: e.situacao })) })) };
}

module.exports = { eu, criar, listar, detalhe, editar, concluirEtapa, dispensarEtapa, reabrirEtapa, pausar, retomar, atribuir, nota, cancelar, excluir, ajustarPrazos,
  listarEtapasModelo, salvarEtapaModelo, salvarConfig, listarEquipe, criarEquipe, editarEquipe, redefinirSenha, indicadores,
  _t: { usado, monta, cpfValido, prazoData } };
