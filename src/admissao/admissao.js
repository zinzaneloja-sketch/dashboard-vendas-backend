// Admissão e Rescisão: controle de cada admissão ou rescisão de colaborador, etapa a etapa, com prazos (SLA) em
// minutos úteis (expediente de tempo.js), por etapa e total. O relógio pode ser pausado quando o processo
// depende de terceiros (ex.: o colaborador ainda não entregou os documentos).
// Papéis: analista/RH (conduz os processos), gestor (também mexe em etapas, prazos, equipe e cancela) e GO (só aprova ou reprova vagas).
// O administrador do sistema (users.role = 'admin') é gestor.
// Dados pessoais: nome, CPF, cargo, local, datas e tipo; os formulários (Link 1 e Link 2) guardam os dados e documentos enviados, visíveis só ao RH (cada abertura é auditada). Sem salário.
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
const PAPEIS = ["analista", "gestor", "go", "diretoria"];
const ACOES = ["normal", "aprovacao", "validacao", "aso", "link", "calculo", "diretoria"];
const ACOES_DIRETORIA = ["calculo", "diretoria"]; // etapas com valores: só RH e Diretoria enxergam
const DESFECHOS = { vaga_reprovada: "Vaga reprovada pela GO", desligamento_reprovado: "Desligamento não aprovado pelo Regional", inapto: "Candidato inapto no exame admissional", desistencia: "Candidato desistiu", outro: "Cancelado" };
const MOTIVOS_DEVOLUCAO = ["Documento ilegível", "Documento faltando", "Dado incorreto ou divergente", "Documento vencido", "Outro"];
const MSG_PADRAO = [
  { chave: "link_pre", titulo: "Link da pré-admissão (para o gerente)", destino: "Gerente da loja", texto: "Olá! Para dar andamento na contratação de {nome} ({cargo}) na {loja}, preencha o formulário de pré-admissão e anexe os documentos iniciais neste link: {link}" },
  { chave: "link_adm", titulo: "Link da admissão (para o candidato)", destino: "Candidato", texto: "Olá, {nome}! Para concluir a sua admissão na Zinzane, preencha o formulário e anexe os documentos neste link: {link}" },
  { chave: "correcao", titulo: "Pedido de correção dos documentos", destino: "Loja ou candidato", texto: "Olá! Precisamos de uma correção nos documentos de {nome}: {itens}. Pode reenviar pelo link? {link}" },
  { chave: "aso_pedido", titulo: "Pedido de exame admissional", destino: "Clínica", texto: "Olá! Solicitamos o exame admissional de {nome}, para o cargo de {cargo}, com início previsto em {data_inicio}. Pode agendar e nos enviar o ASO assim que ficar pronto?" },
  { chave: "contrato", titulo: "Contrato para assinatura", destino: "Candidato", texto: "Olá, {nome}! Enviamos o seu contrato de trabalho para assinatura. Assim que assinar, nos avise. Qualquer dúvida, estamos à disposição." },
  { chave: "boas_vindas", titulo: "Boas-vindas ao novo colaborador", destino: "Colaborador", texto: "Olá, {nome}! Seja muito bem-vindo(a) à Zinzane! Seu primeiro dia será em {data_inicio}, na loja {loja}, no cargo de {cargo}. Estamos felizes em ter você com a gente." },
  { chave: "aviso_loja", titulo: "Aviso de início à loja", destino: "Gerente da loja", texto: "Olá! Informamos que {nome} começa em {data_inicio} na {loja}, como {cargo}. O ponto digital já foi liberado. Qualquer dúvida, fale com o RH." },
  { chave: "vaga_reprovada", titulo: "Vaga não aprovada (aviso à loja)", destino: "Gerente da loja", texto: "Olá! A vaga de {cargo} na {loja} não foi aprovada pela GO. Motivo: {motivo}." },
];

async function comTransacao(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

// ---------- quem é a pessoa ----------
async function papelDe(acc) {
  if (acc.role === "admin") return { papel: "gestor", admin: true, nome: acc.nome || acc.email, email: em(acc.email) };
  const { rows } = await pool.query("SELECT nome, papel, ativo, grupos FROM adm_equipe WHERE lower(email) = $1", [em(acc.email)]);
  if (!rows[0] || !rows[0].ativo) throw erro(403, "Seu usuário não está na equipe de Admissão e Rescisão. Peça ao gestor para cadastrar.");
  const papel = PAPEIS.includes(rows[0].papel) ? rows[0].papel : "analista";
  return { papel, admin: false, nome: rows[0].nome || acc.nome || acc.email, email: em(acc.email), grupos: papel === "go" ? (rows[0].grupos || []).map((g) => String(g).toLowerCase()) : null };
}
// A GO só enxerga as lojas do(s) grupo(s) dela (coluna "regional" do cadastro de lojas). Sem grupo cadastrado, não enxerga nenhuma.
function filtroLojasGo(p, add) { return p.grupos && p.grupos.length ? `p.loja_id IN (SELECT id FROM ch_lojas WHERE lower(regional) = ANY(${add(p.grupos)}::text[]))` : "FALSE"; }
async function exigirLojaDaGo(p, lojaId, c = pool) {
  if (p.papel !== "go") return;
  const ok = lojaId && p.grupos && p.grupos.length && (await c.query("SELECT 1 FROM ch_lojas WHERE id = $1 AND lower(regional) = ANY($2::text[])", [lojaId, p.grupos])).rows.length;
  if (!ok) throw erro(403, "Essa vaga é de uma loja que não está sob a sua responsabilidade.");
}
function exigirGestor(p) { if (p.papel !== "gestor") throw erro(403, "Só o gestor pode fazer isso."); }
function exigirNaoGo(p) {
  if (p.papel === "go") throw erro(403, "O seu perfil (GO) só aprova ou reprova as vagas e os desligamentos da sua região.");
  if (p.papel === "diretoria") throw erro(403, "O seu perfil (Diretoria) só aprova ou devolve o custo das rescisões.");
}
const ehRH = (p) => p.papel === "analista" || p.papel === "gestor";
const podeDiretoria = (p) => p.papel === "diretoria" || p.papel === "gestor";
const podeAprovar = (p) => p.papel === "gestor" || p.papel === "go";
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
  const rotulo = proc.tipo === "admissao" ? "Início do colaborador" : "Prazo legal de pagamento";
  if (!proc.data_prevista) return { rotulo, limite: null, situacao: proc.status === "cancelado" ? "cancelado" : proc.status === "concluido" ? "cumprido" : "sem_data", dias: null };
  const limite = proc.tipo === "admissao" ? dstr(proc.data_prevista) : somaDias(dstr(proc.data_prevista), PRAZO_LEGAL_DIAS);
  const hoje = diaLocal(agora);
  if (proc.status === "cancelado") return { rotulo, limite, situacao: "cancelado", dias: null };
  if (proc.status === "concluido") {
    const fim = diaLocal(proc.concluido_em);
    return { rotulo, limite, situacao: fim <= limite ? "cumprido" : "descumprido", dias: diasEntre(fim, limite) };
  }
  const dias = diasEntre(hoje, limite);
  return { rotulo, limite, situacao: dias < 0 ? "estourado" : dias <= 2 ? "risco" : "ok", dias };
}

function monta(proc, etapasRows, pausas, agora = new Date(), passagens = [], devolucoes = []) {
  const etapas = etapasRows.slice().sort((a, b) => a.ordem - b.ordem || a.id - b.id);
  const aberto = ABERTOS.includes(proc.status);
  const fimTotal = proc.status === "concluido" ? proc.concluido_em : proc.status === "cancelado" ? proc.atualizado_em : agora;
  const atual = aberto ? etapas.find((e) => e.status === "pendente") : null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const lista = etapas.map((e) => {
    const ps = passagens.filter((x) => x.etapa_id === e.id).sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
    const durs = ps.map((x) => usado(x.inicio, x.fim || fimTotal, pausas));
    const tempoTotal = r1(durs.reduce((s2, x) => s2 + x, 0)), maior = durs.length ? Math.max(...durs) : 0;
    const aberta = ps.findIndex((x) => !x.fim);
    const sub = (Array.isArray(e.subtarefas) ? e.subtarefas : []).map((t, i) => ({ indice: i, nome: t.nome, feita: !!t.feita_em, feita_em: t.feita_em || null, feita_por: t.feita_por || null }));
    let o = { id: e.id, nome: e.nome, descricao: e.descricao, area: e.area, ordem: e.ordem, prazo_min: e.prazo_min, status: e.status, obs: e.obs, concluida_em: e.concluida_em, concluida_por: e.concluida_por,
      acao: e.acao || "normal", externo: !!e.externo, exige_candidato: !!e.exige_candidato, mensagem: e.mensagem || null, formulario: e.formulario || null, subtarefas: sub, subtarefas_feitas: sub.filter((t) => t.feita).length,
      iniciada_em: ps.length ? ps[0].inicio : null, passagens: ps.length, chegou: ps.length > 0, voltas: devolucoes.filter((d) => Number(d.etapa_destino_id) === e.id).length,
      tempo_total: tempoTotal, decorrido: null, restante: null, situacao: "aguardando", atual: false };
    if (e.status === "concluida" || e.status === "dispensada") {
      if (e.status === "concluida") { o.decorrido = tempoTotal; o.restante = r1(e.prazo_min - tempoTotal); o.situacao = maior <= e.prazo_min ? "cumprida" : "descumprida"; }
      else o.situacao = "dispensada";
    } else if (atual && e.id === atual.id) {
      o.atual = true; o.decorrido = aberta >= 0 ? durs[aberta] : 0; o.restante = r1(e.prazo_min - o.decorrido);
      o.situacao = situacaoRelogio(o.decorrido, e.prazo_min, { pausado: proc.status === "pausado" });
    } else if (proc.status === "cancelado") o.situacao = "cancelada";
    return o;
  });
  const decTot = usado(proc.criado_em, fimTotal, pausas);
  const total = { meta: proc.sla_total_min, decorrido: decTot, restante: r1(proc.sla_total_min - decTot), situacao: "ok" };
  if (proc.status === "concluido") total.situacao = decTot <= proc.sla_total_min ? "cumprido" : "descumprido";
  else if (proc.status === "cancelado") total.situacao = "cancelado";
  else total.situacao = situacaoRelogio(decTot, proc.sla_total_min, { pausado: proc.status === "pausado" });
  const pd = prazoData(proc, agora);
  const ea = lista.find((e) => e.atual);
  const situacao = aberto ? pior(total.situacao, ea ? ea.situacao : "ok", pd.situacao === "estourado" ? "estourado" : pd.situacao === "risco" ? "risco" : null) : proc.status;
  const feitas = lista.filter((e) => e.status !== "pendente").length;
  const pa = pausas.find((p) => !p.fim);
  // quem segura o processo: tempo (em minutos úteis) com o RH x fora do RH (GO, loja, candidato, clínica)
  const lados = { rh: 0, fora: 0 }, porArea = {};
  lista.forEach((e) => { lados[e.externo ? "fora" : "rh"] += e.tempo_total; const k = e.area || "Outros"; porArea[k] = r1((porArea[k] || 0) + e.tempo_total); });
  lados.rh = r1(lados.rh); lados.fora = r1(lados.fora);
  const dv = devolucoes.map((d) => ({ etapa: d.etapa_nome, motivo_cat: d.motivo_cat, detalhe: d.detalhe, por: d.usuario, em: d.criado_em }));
  return {
    id: proc.id, protocolo: proc.protocolo, tipo: proc.tipo, tipo_rotulo: TIPO_ROT[proc.tipo], colaborador: proc.colaborador || ("Vaga de " + (proc.cargo || "cargo a definir")), candidato_definido: !!proc.colaborador,
    cpf_mascarado: cpfMasc(proc.cpf), cargo: proc.cargo, solicitante: proc.solicitante || null, colaborador_chapa: proc.colaborador_chapa || null, solicitante_chapa: proc.solicitante_chapa || null,
    loja_id: proc.loja_id, unidade: proc.unidade, subtipo: proc.subtipo, data_prevista: dstr(proc.data_prevista), observacao: proc.observacao,
    link_admissao: proc.link_admissao || null,
    responsavel: proc.responsavel, responsavel_nome: proc.responsavel_nome || null, status: proc.status, criado_por: proc.criado_por, criado_em: proc.criado_em, concluido_em: proc.concluido_em, cancelado_motivo: proc.cancelado_motivo,
    desfecho: proc.desfecho || null, desfecho_rotulo: proc.status === "cancelado" ? (DESFECHOS[proc.desfecho] || DESFECHOS.outro) : null,
    sla_total_min: proc.sla_total_min, total, prazo_data: pd, situacao, progresso: { feitas, total: lista.length },
    etapa_atual: ea ? { id: ea.id, nome: ea.nome, area: ea.area, externo: ea.externo, acao: ea.acao, voltas: ea.voltas, ordem: ea.ordem, prazo_min: ea.prazo_min, decorrido: ea.decorrido, restante: ea.restante, situacao: ea.situacao } : null,
    lados, por_area: porArea, retornos: dv.length, devolucoes: dv,
    pausa: pa ? { desde: pa.inicio, motivo: pa.motivo } : null, etapas: lista,
  };
}

const COLS = `p.id::int AS id, p.protocolo, p.tipo, p.colaborador, p.cpf, p.cargo, p.loja_id::int AS loja_id, p.unidade, p.subtipo, p.data_prevista, p.observacao, p.responsavel, p.status,
  p.sla_total_min, p.criado_por, p.criado_em, p.concluido_em, p.cancelado_motivo, p.atualizado_em, p.desfecho, p.solicitante, p.colaborador_chapa, p.solicitante_chapa, p.link_admissao, r.nome AS responsavel_nome`;
const COLS_ET = "id::int AS id, nome, descricao, area, ordem, prazo_min, status, concluida_em, concluida_por, obs, acao, externo, exige_candidato, subtarefas, mensagem, formulario";
const FROM = "FROM adm_processos p LEFT JOIN adm_equipe r ON lower(r.email) = lower(p.responsavel)";

async function carregarLista(where, params, limite = 2000) {
  const { rows } = await pool.query(`SELECT ${COLS} ${FROM} ${where ? "WHERE " + where : ""} ORDER BY p.criado_em DESC LIMIT ${Number(limite) || 2000}`, params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: et } = await pool.query(`SELECT processo_id::int AS processo_id, ${COLS_ET} FROM adm_proc_etapas WHERE processo_id = ANY($1::bigint[])`, [ids]);
  const { rows: ps } = await pool.query("SELECT processo_id::int AS processo_id, inicio, fim, motivo FROM adm_pausas WHERE processo_id = ANY($1::bigint[]) ORDER BY inicio", [ids]);
  const { rows: pg } = await pool.query("SELECT processo_id::int AS processo_id, etapa_id::int AS etapa_id, inicio, fim FROM adm_passagens WHERE processo_id = ANY($1::bigint[])", [ids]);
  const { rows: dv } = await pool.query("SELECT processo_id::int AS processo_id, etapa_validacao_id::int AS etapa_validacao_id, etapa_destino_id::int AS etapa_destino_id, etapa_nome, motivo_cat, detalhe, usuario, criado_em FROM adm_devolucoes WHERE processo_id = ANY($1::bigint[]) ORDER BY criado_em", [ids]);
  const agora = new Date();
  return rows.map((r) => monta(r, et.filter((e) => e.processo_id === r.id), ps.filter((x) => x.processo_id === r.id), agora, pg.filter((x) => x.processo_id === r.id), dv.filter((x) => x.processo_id === r.id)));
}
async function carregarUm(id, c = pool) {
  const { rows } = await c.query(`SELECT ${COLS} ${FROM} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw erro(404, "Processo não encontrado.");
  const { rows: et } = await c.query(`SELECT ${COLS_ET} FROM adm_proc_etapas WHERE processo_id = $1`, [id]);
  const { rows: ps } = await c.query("SELECT inicio, fim, motivo FROM adm_pausas WHERE processo_id = $1 ORDER BY inicio", [id]);
  const { rows: pg } = await c.query("SELECT etapa_id::int AS etapa_id, inicio, fim FROM adm_passagens WHERE processo_id = $1", [id]);
  const { rows: dv } = await c.query("SELECT etapa_validacao_id::int AS etapa_validacao_id, etapa_destino_id::int AS etapa_destino_id, etapa_nome, motivo_cat, detalhe, usuario, criado_em FROM adm_devolucoes WHERE processo_id = $1 ORDER BY criado_em", [id]);
  return { raw: rows[0], etapas: et, pausas: ps, passagens: pg, devolucoes: dv };
}
// uma "passagem" = um período em que a etapa ficou ativa (a etapa pode voltar a ficar ativa depois de uma devolução)
async function abrirPassagem(c, processoId, etapaId, quando) { await c.query("INSERT INTO adm_passagens (processo_id, etapa_id, inicio) VALUES ($1,$2,$3)", [processoId, etapaId, quando]); }
async function fecharPassagem(c, etapaId, quando) { await c.query("UPDATE adm_passagens SET fim = GREATEST($2::timestamptz, inicio) WHERE etapa_id = $1 AND fim IS NULL", [etapaId, quando]); }
async function evento(c, processoId, tipo, usuario, detalhe) {
  await c.query("INSERT INTO adm_eventos (processo_id, tipo, usuario, detalhe) VALUES ($1,$2,$3,$4)", [processoId, tipo, usuario || null, detalhe ? JSON.stringify(detalhe) : null]);
}

// ---------- /eu ----------
async function responsaveis() {
  const { rows } = await pool.query(`SELECT email, coalesce(nome, email) AS nome FROM adm_equipe WHERE ativo AND papel NOT IN ('go','diretoria')
    UNION SELECT email, coalesce(nome, email) FROM users WHERE role = 'admin' ORDER BY 2`);
  const vistos = new Set();
  return rows.filter((r) => (vistos.has(r.email.toLowerCase()) ? false : vistos.add(r.email.toLowerCase())));
}
async function eu(acc) {
  const p = await papelDe(acc);
  const { rows: lj } = p.papel === "go"
    ? await pool.query("SELECT id::int AS id, nome FROM ch_lojas WHERE ativa AND lower(regional) = ANY($1::text[]) ORDER BY nome", [p.grupos && p.grupos.length ? p.grupos : []])
    : await pool.query("SELECT id::int AS id, nome FROM ch_lojas WHERE ativa ORDER BY nome");
  return { nome: p.nome, email: p.email, papel: p.papel, admin: !!p.admin, go: p.papel === "go", grupos_go: p.papel === "go" ? (await gruposDe(p.email)) : undefined, tipos: p.papel === "diretoria" ? { rescisao: TIPO_ROT.rescisao } : TIPO_ROT, diretoria: p.papel === "diretoria", rh: ehRH(p), subtipos: SUBTIPOS, prazo_legal_dias: PRAZO_LEGAL_DIAS,
    acoes: ACOES, desfechos: DESFECHOS, motivos_devolucao: MOTIVOS_DEVOLUCAO,
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
// Cria o processo com as etapas ativas do modelo. Usada pelo RH (criar) e pelo link da loja (gerente abre a vaga).
async function inserirProcesso(d) {
  return comTransacao(async (c) => {
    const { rows: md } = await c.query("SELECT id, nome, descricao, area, prazo_min, ordem, acao, externo, exige_candidato, subtarefas, mensagem, formulario FROM adm_etapas_modelo WHERE tipo = $1 AND ativo ORDER BY ordem, id", [d.tipo]);
    if (!md.length) throw erro(400, "Não há etapas ativas para esse tipo. Cadastre as etapas em Cadastros.");
    const total = await totalPadrao(d.tipo, c);
    const { rows } = await c.query(`INSERT INTO adm_processos (protocolo, tipo, colaborador, cpf, cargo, loja_id, unidade, subtipo, data_prevista, observacao, responsavel, sla_total_min, criado_por, solicitante, colaborador_chapa, solicitante_chapa)
      VALUES ('tmp-' || nextval('adm_proto_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id::int AS id, criado_em`,
      [d.tipo, d.colaborador, d.cpf || null, d.cargo || null, d.lojaId, d.unidade, d.subtipo || null, d.dataPrev || null, d.observacao || null, d.resp, total, d.criadoPor, d.solicitante || null, d.colabChapa || null, d.solChapa || null]);
    const id = rows[0].id, protocolo = `${PREFIXO[d.tipo]}-${new Date().getFullYear()}-${String(id).padStart(5, "0")}`;
    await c.query("UPDATE adm_processos SET protocolo = $2 WHERE id = $1", [id, protocolo]);
    let o = 0;
    for (const m of md) {
      const sub = (Array.isArray(m.subtarefas) ? m.subtarefas : []).map((nome) => ({ nome: String(nome) }));
      const { rows: ne } = await c.query(`INSERT INTO adm_proc_etapas (processo_id, modelo_id, nome, descricao, area, ordem, prazo_min, acao, externo, exige_candidato, subtarefas, mensagem, formulario)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) RETURNING id`, [id, m.id, m.nome, m.descricao, m.area, ++o, m.prazo_min, m.acao || "normal", !!m.externo, !!m.exige_candidato, JSON.stringify(sub), m.mensagem || null, m.formulario || null]);
      if (o === 1) await abrirPassagem(c, id, ne[0].id, rows[0].criado_em);
    }
    await evento(c, id, "criado", d.criadoPor, { tipo: d.tipo, responsavel: d.resp, via: d.via || undefined });
    // se a primeira etapa é de um formulário (abertura da vaga pelo gerente), o link já nasce com o processo
    let formToken = null;
    if (d.tipo === "admissao" && md[0].formulario && md[0].acao !== "validacao") {
      const fid = await garantirForm(c, id, md[0].formulario, d.criadoPor);
      const { rows: ft } = await c.query("SELECT token FROM adm_formularios WHERE id = $1", [fid]);
      formToken = ft[0].token;
    }
    return { id, protocolo, formToken };
  });
}
async function criar(acc, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const tipo = txt(b.tipo);
  if (!TIPOS.includes(tipo)) throw erro(400, "Escolha se é admissão ou rescisão.");
  let colaborador = txt(b.colaborador).slice(0, 120);
  let cargo = txt(b.cargo).slice(0, 100);
  // nomes de colaboradores vêm da lista da empresa (planilha do RH); só o candidato de uma admissão é pessoa nova e fica livre
  let colabChapa = null, solChapa = null, solicitante = txt(b.solicitante).slice(0, 120);
  const listaOk = await temLista();
  const eleito = {};
  if (tipo === "rescisao" && listaOk) { const c = await colaboradorDaLista(b.colaborador_chapa); eleito.colab = c; colaborador = c.nome; colabChapa = c.chapa; }
  if ((solicitante || txt(b.solicitante_chapa)) && tipo === "admissao" && listaOk) { const c = await colaboradorDaLista(b.solicitante_chapa, "Quem pediu a vaga"); solicitante = c.nome; solChapa = c.chapa; }
  // Admissão: o processo nasce na aprovação da vaga, quando o candidato ainda pode não existir. Rescisão sempre tem colaborador e data.
  if (tipo === "rescisao" && colaborador.length < 3) throw erro(400, "Informe o nome do colaborador.");
  if (tipo === "admissao" && colaborador && colaborador.length < 3) throw erro(400, "O nome do colaborador está muito curto.");
  if (tipo === "admissao" && !colaborador && !cargo) throw erro(400, "Informe o cargo da vaga (ou o nome do candidato, se já tiver).");
  const cpf = cpfDigitos(b.cpf);
  if (cpf && !cpfValido(cpf)) throw erro(400, "CPF inválido. Confira os números.");
  const dataPrev = txt(b.data_prevista);
  if (dataPrev ? !dataOk(dataPrev) : tipo === "rescisao") throw erro(400, tipo === "admissao" ? "Data de início inválida." : "Informe a data do término do contrato.");
  const subtipo = txt(b.subtipo).slice(0, 80);
  if (tipo === "rescisao" && !subtipo) throw erro(400, "Informe o tipo de rescisão.");
  let lojaId = Number(b.loja_id) || null, unidade = txt(b.unidade).slice(0, 120);
  if (!lojaId && !unidade && tipo === "rescisao" && eleito.colab) { lojaId = eleito.colab.loja_id ? Number(eleito.colab.loja_id) : null; unidade = txt(eleito.colab.local_trabalho).slice(0, 120); } // a loja vem do cadastro do colaborador
  if (lojaId) { const { rows } = await pool.query("SELECT nome FROM ch_lojas WHERE id = $1", [lojaId]); if (!rows[0]) throw erro(400, "Loja não encontrada."); unidade = rows[0].nome; }
  if (!unidade) throw erro(400, "Informe a loja ou o local de trabalho.");
  let resp = em(b.responsavel) || p.email;
  const { rows: rr } = await pool.query("SELECT 1 FROM adm_equipe WHERE lower(email) = $1 AND ativo AND papel NOT IN ('go','diretoria') UNION SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [resp]);
  if (!rr[0]) throw erro(400, "O responsável precisa ser da equipe do RH.");
  if (cpf) {
    const { rows: dup } = await pool.query("SELECT protocolo FROM adm_processos WHERE cpf = $1 AND tipo = $2 AND status IN ('em_andamento','pausado') LIMIT 1", [cpf, tipo]);
    if (dup[0]) throw erro(409, `Já existe um processo de ${TIPO_ROT[tipo].toLowerCase()} em andamento para esse CPF (${dup[0].protocolo}).`);
  }
  const info = await inserirProcesso({ tipo, colaborador, cpf, cargo, lojaId, unidade, subtipo, dataPrev, observacao: txt(b.observacao).slice(0, 1000) || null, resp, criadoPor: p.email, solicitante, colabChapa, solChapa });
  audit(acc, "adm_criado", { papel: p.papel, alvo: info.protocolo, detalhe: TIPO_ROT[tipo] + " · " + unidade });
  return { ok: true, id: info.id, protocolo: info.protocolo };
}

async function listar(acc, f = {}) {
  const pp = await papelDe(acc);
  const w = [], v = [];
  const add = (x) => { v.push(x); return "$" + v.length; };
  if (pp.papel === "go") { w.push(filtroLojasGo(pp, add)); if (TIPOS.includes(f.tipo)) w.push(`p.tipo = ${add(f.tipo)}`); }
  else if (pp.papel === "diretoria") w.push(`p.tipo = ${add("rescisao")}`);
  else if (TIPOS.includes(f.tipo)) w.push(`p.tipo = ${add(f.tipo)}`);
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
  // a Diretoria só vê a rescisão quando ela chega na etapa de aprovação dela (ou já passou por ela)
  if (pp.papel === "diretoria") lista = lista.filter((x) => x.etapas.some((e) => e.acao === "diretoria" && (e.status !== "pendente" || e.atual)));
  if (f.sla === "estourado") lista = lista.filter((x) => x.situacao === "estourado");
  else if (f.sla === "risco") lista = lista.filter((x) => x.situacao === "risco");
  else if (f.sla === "atencao") lista = lista.filter((x) => x.situacao === "estourado" || x.situacao === "risco");
  // com quem está o processo agora: rh | fora (loja, candidato, clínica) | go (aguardando aprovação da vaga)
  if (f.com === "rh") lista = lista.filter((x) => x.etapa_atual && !x.etapa_atual.externo);
  else if (f.com === "fora") lista = lista.filter((x) => x.etapa_atual && x.etapa_atual.externo);
  else if (f.com === "go") lista = lista.filter((x) => x.etapa_atual && x.etapa_atual.acao === "aprovacao");
  else if (f.com === "diretoria") lista = lista.filter((x) => x.etapa_atual && x.etapa_atual.acao === "diretoria");
  else if (f.com === "devolvidos") lista = lista.filter((x) => x.etapa_atual && x.etapas.some((e) => e.atual && e.voltas > 0));
  const ab = lista.filter((x) => ABERTOS.includes(x.status));
  const fe = lista.filter((x) => !ABERTOS.includes(x.status));
  ab.sort((a, b) => (GRAV[a.situacao] ?? 9) - (GRAV[b.situacao] ?? 9) || ((a.prazo_data.limite || "9999") < (b.prazo_data.limite || "9999") ? -1 : 1));
  const ordenada = ab.concat(fe);
  const contagem = {}; lista.forEach((x) => { contagem[x.status] = (contagem[x.status] || 0) + 1; });
  const lim = Math.min(Number(f.limite) || 300, 1000);
  return { processos: ordenada.slice(0, lim).map((x) => { const y = pp.papel === "go" ? mascararParaGo(x) : x; return { ...y, etapas: undefined, devolucoes: undefined, lados: undefined, por_area: undefined }; }), total: ordenada.length, contagem };
}

async function detalhe(acc, id) {
  const p = await papelDe(acc);
  const { raw, etapas, pausas, passagens, devolucoes } = await carregarUm(id);
  if (p.papel === "diretoria") {
    const vis = raw.tipo === "rescisao" && etapas.some((e) => e.acao === "diretoria" && (e.status !== "pendente" || (e.status === "pendente" && etapas.filter((x) => x.status === "pendente").sort((a, b) => a.ordem - b.ordem)[0] === e)));
    if (!vis) throw erro(403, "Você vê a rescisão quando ela chega na aprovação da Diretoria.");
  }
  await exigirLojaDaGo(p, raw.loja_id);
  audit(acc, "adm_ver", { papel: p.papel, alvo: raw.protocolo, detalhe: raw.colaborador }); // quem leu os dados pessoais (LGPD)
  const proc = monta(raw, etapas, pausas, new Date(), passagens, devolucoes);
  proc.cpf = p.papel === "go" || p.papel === "diretoria" ? null : cpfFmt(raw.cpf);
  if (raw.tipo === "admissao" && ehRH(p) && proc.etapa_atual) {
    const ea = proc.etapas.find((x) => x.atual);
    if (ea && ea.formulario && ea.acao !== "validacao" && ABERTOS.includes(raw.status)) await comTransacao((c) => garantirForm(c, id, ea.formulario, p.email));
  }
  proc.formularios = raw.tipo === "admissao" && p.papel !== "diretoria" ? await resumoFormularios(id, ehRH(p)) : {};
  proc.candidato_telefone = raw.tipo === "admissao" && ehRH(p) ? await telefoneCandidato(id) : null;
  if (p.papel === "go" || p.papel === "diretoria") proc.cpf_mascarado = null;
  // custo da rescisão e anexos: só RH e Diretoria
  proc.calculo = raw.tipo === "rescisao" && (ehRH(p) || p.papel === "diretoria") ? await calculoDo(id) : null;
  let proc2 = proc;
  if (p.papel === "go") proc2 = mascararParaGo(proc);
  const { rows: ev0 } = await pool.query("SELECT tipo, usuario, detalhe, criado_em FROM adm_eventos WHERE processo_id = $1 ORDER BY criado_em, id", [id]);
  const nomesOcultos = new Set(proc.etapas.filter((e) => ACOES_DIRETORIA.includes(e.acao)).map((e) => e.nome));
  const ev = p.papel === "go" ? ev0.filter((x) => !["calculo_registrado", "anexo_calculo", "anexo_removido"].includes(x.tipo) && !(x.detalhe && nomesOcultos.has(x.detalhe.etapa)) && !(x.detalhe && nomesOcultos.has(x.detalhe.para))) : ev0;
  const { rows: ps } = await pool.query("SELECT inicio, fim, motivo, usuario FROM adm_pausas WHERE processo_id = $1 ORDER BY inicio", [id]);
  return { processo: proc2, eventos: ev, pausas: ps };
}

async function editar(acc, id, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const { raw } = await carregarUm(id);
  if (!ABERTOS.includes(raw.status) && !p.admin && p.papel !== "gestor") throw erro(409, "Processo encerrado. Só o gestor altera.");
  if (raw.status === "cancelado") throw erro(409, "Processo cancelado não pode ser editado.");
  const sets = [], v = [id];
  const set = (col, val) => { v.push(val); sets.push(`${col} = $${v.length}`); };
  const listaOk = await temLista();
  if (b.colaborador !== undefined) {
    let n = txt(b.colaborador).slice(0, 120);
    if (raw.tipo === "rescisao" && listaOk) { // na rescisão o nome vem da lista; mantém o atual se não mudou
      if (txt(b.colaborador_chapa)) { const c = await colaboradorDaLista(b.colaborador_chapa); n = c.nome; set("colaborador_chapa", c.chapa); }
      else if (n !== raw.colaborador) throw erro(400, "Escolha o colaborador na lista: digite o nome e clique no resultado. Se ele não aparece, peça ao gestor para atualizar a planilha em Cadastros > Colaboradores.");
    }
    if (n.length < 3 && !(raw.tipo === "admissao" && n === "")) throw erro(400, "Informe o nome do colaborador.");
    set("colaborador", n);
  }
  if (b.solicitante !== undefined) {
    let n = txt(b.solicitante).slice(0, 120);
    if (n && listaOk) {
      if (txt(b.solicitante_chapa)) { const c = await colaboradorDaLista(b.solicitante_chapa, "Quem pediu a vaga"); n = c.nome; set("solicitante_chapa", c.chapa); }
      else if (n !== (raw.solicitante || "")) throw erro(400, "Escolha quem pediu a vaga na lista: digite o nome e clique no resultado.");
    }
    if (!n) set("solicitante_chapa", null);
    set("solicitante", n || null);
  }
  if (b.cpf !== undefined) { const c = cpfDigitos(b.cpf); if (c && !cpfValido(c)) throw erro(400, "CPF inválido. Confira os números."); set("cpf", c || null); }
  if (b.cargo !== undefined) set("cargo", txt(b.cargo).slice(0, 100) || null);
  if (b.subtipo !== undefined) set("subtipo", txt(b.subtipo).slice(0, 80) || null);
  if (b.observacao !== undefined) set("observacao", txt(b.observacao).slice(0, 1000) || null);
  if (b.data_prevista !== undefined) {
    if (txt(b.data_prevista) === "" && raw.tipo === "admissao") set("data_prevista", null);
    else { if (!dataOk(txt(b.data_prevista))) throw erro(400, "Data inválida."); set("data_prevista", txt(b.data_prevista)); }
  }
  if (b.loja_id !== undefined || b.unidade !== undefined) {
    const lojaId = Number(b.loja_id) || null; let un = txt(b.unidade).slice(0, 120);
    if (lojaId) { const { rows } = await pool.query("SELECT nome FROM ch_lojas WHERE id = $1", [lojaId]); if (!rows[0]) throw erro(400, "Loja não encontrada."); un = rows[0].nome; }
    if (!un) throw erro(400, "Informe a loja ou o local de trabalho.");
    set("loja_id", lojaId); set("unidade", un);
  }
  if (!sets.length) throw erro(400, "Nada para alterar.");
  await pool.query(`UPDATE adm_processos SET ${sets.join(", ")}, atualizado_em = now() WHERE id = $1`, v);
  await evento(pool, id, "editado", p.email, { campos: Object.keys(b).filter((k) => ["colaborador", "cpf", "cargo", "subtipo", "observacao", "data_prevista", "loja_id", "unidade", "solicitante"].includes(k)) });
  audit(acc, "adm_editado", { papel: p.papel, alvo: raw.protocolo });
  return { ok: true };
}

// etapa atual = a primeira pendente; as etapas vão em ordem
async function etapaAtual(c, id, etapaId) {
  const { raw, etapas, pausas } = await carregarUm(id, c);
  if (!ABERTOS.includes(raw.status)) throw erro(409, raw.status === "concluido" ? "Processo já concluído." : "Processo encerrado.");
  if (raw.status === "pausado") throw erro(409, "O processo está pausado. Retome antes de avançar.");
  const ord = etapas.slice().sort((a, b) => a.ordem - b.ordem || a.id - b.id);
  const atual = ord.find((e) => e.status === "pendente");
  if (!atual || atual.id !== Number(etapaId)) throw erro(409, "Só a etapa atual pode ser alterada. Atualize a tela.");
  const idx = ord.indexOf(atual);
  const { rows: pg } = await c.query("SELECT inicio FROM adm_passagens WHERE etapa_id = $1 AND fim IS NULL ORDER BY inicio DESC LIMIT 1", [atual.id]);
  const proximo = ord.slice(idx + 1).find((x) => x.status === "pendente") || null; // etapas já feitas (ex.: aprovação da GO, depois de uma devolução) não repetem
  return { raw, ord, atual, idx, proximo, anterior: ord[idx - 1] || null, ini: pg[0] ? pg[0].inicio : raw.criado_em, ultima: !proximo, pausas };
}
// encerra o processo sem contratação (vaga reprovada, inapto, desistência ou cancelamento)
async function encerrarInterno(c, id, p, desfecho, motivo) {
  await c.query("UPDATE adm_pausas SET fim = now() WHERE processo_id = $1 AND fim IS NULL", [id]);
  await c.query("UPDATE adm_passagens SET fim = now() WHERE processo_id = $1 AND fim IS NULL", [id]);
  await c.query("UPDATE adm_processos SET status = 'cancelado', cancelado_motivo = $2, desfecho = $3, atualizado_em = now() WHERE id = $1", [id, motivo, desfecho]);
  await evento(c, id, "cancelado", p.email, { motivo, desfecho });
}
function exigirPapelDaEtapa(p, etapa) {
  if (etapa.acao === "aprovacao") { if (!podeAprovar(p)) throw erro(403, "Só a GO ou o gestor aprovam ou reprovam essa etapa."); }
  else if (etapa.acao === "diretoria") { if (!podeDiretoria(p)) throw erro(403, "Só a Diretoria (ou o gestor) aprova o custo da rescisão."); }
  else exigirNaoGo(p);
}
function quando() { return new Date(); } // data e hora da conclusão são sempre automáticas (o momento do clique); ninguém informa nem altera
async function concluirEtapa(acc, id, etapaId, b = {}) {
  const p = await papelDe(acc);
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const e = await etapaAtual(c, id, etapaId);
    const a = e.atual;
    exigirPapelDaEtapa(p, a);
    await exigirLojaDaGo(p, e.raw.loja_id, c);
    let formAprovar = null;
    if (a.acao === "validacao" && a.formulario) {
      const { rows: ff } = await c.query("SELECT id, status FROM adm_formularios WHERE processo_id = $1 AND tipo = $2 FOR UPDATE", [id, a.formulario]);
      if (ff[0] && ff[0].status === "enviado") { // se ninguém usou o link (documentos vieram por fora), o RH aprova normalmente
        const { rows: nn } = await c.query("SELECT count(*)::int AS n FROM adm_form_itens i WHERE i.form_id = $1 AND i.status <> 'ok' AND (i.obrigatorio OR i.valor IS NOT NULL OR EXISTS (SELECT 1 FROM adm_form_arquivos x WHERE x.item_id = i.id))", [ff[0].id]);
        if (nn[0].n) throw erro(400, "Confira os documentos e marque cada item como correto antes de aprovar (faltam " + nn[0].n + "). Se algo estiver errado, use Devolver para correção.");
        formAprovar = ff[0].id;
      }
    }
    if (a.acao === "link" && !txt(e.raw.link_admissao)) throw erro(400, "Cole o link de admissão que você enviou ao candidato antes de concluir a etapa.");
    if (a.acao === "calculo" || a.acao === "diretoria") {
      const { rows: cu } = await c.query("SELECT custo_rescisao FROM adm_processos WHERE id = $1", [id]);
      if (cu[0].custo_rescisao === null) throw erro(400, a.acao === "calculo" ? "Informe o custo da rescisão antes de concluir (o anexo do cálculo é opcional)." : "O RH ainda não informou o custo da rescisão.");
    }
    if (a.exige_candidato && (!e.raw.colaborador || !e.raw.data_prevista)) throw erro(400, "Antes de concluir, informe o nome do candidato e a data de início (botão Editar dados).");
    const falta = (Array.isArray(a.subtarefas) ? a.subtarefas : []).filter((t) => !t.feita_em);
    if (falta.length) throw erro(400, "Marque todas as tarefas da etapa antes de concluir. Falta: " + falta.map((t) => t.nome).join("; ") + ".");
    let resultado = null;
    if (a.acao === "aso") {
      resultado = txt(b.resultado).toLowerCase();
      if (!["apto", "inapto"].includes(resultado)) throw erro(400, "Informe o resultado do exame: apto ou inapto.");
    }
    const quand = quando();
    const obs = txt(b.obs).slice(0, 500) || null;
    const obsFinal = resultado ? "Resultado: " + resultado + (obs ? " · " + obs : "") : obs;
    await c.query("UPDATE adm_proc_etapas SET status = 'concluida', concluida_em = $2, concluida_por = $3, obs = $4 WHERE id = $1", [a.id, quand, p.email, obsFinal]);
    await fecharPassagem(c, a.id, quand);
    if (formAprovar) await c.query("UPDATE adm_formularios SET status = 'aprovado' WHERE id = $1", [formAprovar]);
    await evento(c, id, "etapa_concluida", p.email, { etapa: a.nome, ordem: a.ordem, quando: quand, obs: obsFinal, final: e.ultima, resultado, aprovacao: a.acao === "aprovacao" || a.acao === "diretoria" || undefined });
    if (resultado === "inapto") {
      await encerrarInterno(c, id, p, "inapto", "Resultado do exame admissional: inapto" + (obs ? " · " + obs : ""));
      return { protocolo: e.raw.protocolo, final: false, encerrado: true, etapa: a.nome };
    }
    if (e.ultima) await c.query("UPDATE adm_processos SET status = 'concluido', concluido_em = $2, atualizado_em = now() WHERE id = $1", [id, quand]);
    else {
      await c.query("UPDATE adm_processos SET atualizado_em = now() WHERE id = $1", [id]); await abrirPassagem(c, id, e.proximo.id, quand);
      if (e.proximo.formulario && e.proximo.acao !== "validacao" && e.raw.tipo === "admissao") await garantirForm(c, id, e.proximo.formulario, p.email); // o link nasce junto com a etapa
    }
    return { protocolo: e.raw.protocolo, final: e.ultima, etapa: a.nome };
  });
  audit(acc, r.final ? "adm_concluido" : r.encerrado ? "adm_encerrado" : "adm_etapa_concluida", { papel: p.papel, alvo: r.protocolo, detalhe: r.etapa });
  return { ok: true, concluido: r.final, encerrado: !!r.encerrado };
}
async function dispensarEtapa(acc, id, etapaId, b = {}) {
  const p = await papelDe(acc);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Explique por que a etapa não se aplica (mínimo 5 letras).");
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const e = await etapaAtual(c, id, etapaId);
    exigirPapelDaEtapa(p, e.atual);
    await c.query("UPDATE adm_proc_etapas SET status = 'dispensada', concluida_em = $2, concluida_por = $3, obs = $4 WHERE id = $1", [e.atual.id, e.ini, p.email, motivo]);
    await c.query("UPDATE adm_passagens SET fim = inicio WHERE etapa_id = $1 AND fim IS NULL", [e.atual.id]);
    if (e.ultima) await c.query("UPDATE adm_processos SET status = 'concluido', concluido_em = now(), atualizado_em = now() WHERE id = $1", [id]);
    else { await c.query("UPDATE adm_processos SET atualizado_em = now() WHERE id = $1", [id]); await abrirPassagem(c, id, e.proximo.id, e.ini); }
    await evento(c, id, "etapa_dispensada", p.email, { etapa: e.atual.nome, ordem: e.atual.ordem, motivo, final: e.ultima });
    return { protocolo: e.raw.protocolo, etapa: e.atual.nome, final: e.ultima };
  });
  audit(acc, "adm_etapa_dispensada", { papel: p.papel, alvo: r.protocolo, detalhe: r.etapa });
  return { ok: true, concluido: r.final };
}
// desfaz a última etapa concluída ou dispensada (engano de clique)
async function reabrirEtapa(acc, id, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Explique por que a etapa volta (mínimo 5 letras).");
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const { raw, etapas } = await carregarUm(id, c);
    if (raw.status === "cancelado") throw erro(409, "Processo encerrado.");
    if (raw.status === "concluido" && p.papel !== "gestor") throw erro(403, "Só o gestor reabre um processo concluído.");
    const feitas = etapas.filter((e) => e.status !== "pendente").sort((a, b2) => b2.ordem - a.ordem || b2.id - a.id);
    if (!feitas.length) throw erro(409, "Nenhuma etapa concluída para voltar.");
    const ult = feitas[0];
    await c.query("UPDATE adm_passagens SET fim = now() WHERE processo_id = $1 AND fim IS NULL", [id]);
    await c.query("UPDATE adm_proc_etapas SET status = 'pendente', concluida_em = NULL, concluida_por = NULL, obs = NULL WHERE id = $1", [ult.id]);
    await abrirPassagem(c, id, ult.id, new Date());
    if (ult.formulario) {
      if (ult.acao === "validacao") await c.query("UPDATE adm_formularios SET status = 'enviado' WHERE processo_id = $1 AND tipo = $2 AND status = 'aprovado'", [id, ult.formulario]);
      else await c.query("UPDATE adm_formularios SET status = 'devolvido' WHERE processo_id = $1 AND tipo = $2 AND status IN ('enviado','aprovado')", [id, ult.formulario]);
    }
    await c.query("UPDATE adm_processos SET status = CASE WHEN status = 'concluido' THEN 'em_andamento' ELSE status END, concluido_em = NULL, atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "etapa_reaberta", p.email, { etapa: ult.nome, ordem: ult.ordem, motivo });
    return { protocolo: raw.protocolo, etapa: ult.nome };
  });
  audit(acc, "adm_etapa_reaberta", { papel: p.papel, alvo: r.protocolo, detalhe: r.etapa });
  return { ok: true };
}

// A GO (ou o gestor) reprova a vaga: o processo é encerrado com a justificativa.
async function reprovarVaga(acc, id, etapaId, b = {}) {
  const p = await papelDe(acc);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Informe a justificativa da reprovação (mínimo 5 letras).");
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const e = await etapaAtual(c, id, etapaId);
    if (e.atual.acao !== "aprovacao") throw erro(409, "Essa etapa não é de aprovação.");
    exigirPapelDaEtapa(p, e.atual);
    await exigirLojaDaGo(p, e.raw.loja_id, c);
    await c.query("UPDATE adm_passagens SET fim = now() WHERE etapa_id = $1 AND fim IS NULL", [e.atual.id]);
    await evento(c, id, "vaga_reprovada", p.email, { etapa: e.atual.nome, motivo, tipo: e.raw.tipo });
    await encerrarInterno(c, id, p, e.raw.tipo === "rescisao" ? "desligamento_reprovado" : "vaga_reprovada", motivo);
    return e.raw.protocolo;
  });
  audit(acc, "adm_vaga_reprovada", { papel: p.papel, alvo: r, detalhe: motivo });
  return { ok: true };
}
// O RH não aprova os documentos: devolve para a etapa anterior (loja ou candidato corrige) e a etapa de validação volta para a fila.
async function devolverEtapa(acc, id, etapaId, b = {}) {
  const p = await papelDe(acc);
  const cat = MOTIVOS_DEVOLUCAO.includes(txt(b.motivo_cat)) ? txt(b.motivo_cat) : "Outro";
  const detalhe = txt(b.detalhe).slice(0, 500);
  if (detalhe.length < 5) throw erro(400, "Descreva o que está incorreto ou faltando (mínimo 5 letras).");
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const e = await etapaAtual(c, id, etapaId);
    if (e.atual.acao === "diretoria") { if (!podeDiretoria(p)) throw erro(403, "Só a Diretoria (ou o gestor) devolve o custo ao RH."); }
    else { exigirNaoGo(p); if (e.atual.acao !== "validacao") throw erro(409, "Só etapas de validação ou a aprovação da Diretoria podem ser devolvidas."); }
    // validação de formulário: volta para a etapa em que o formulário é preenchido (a aprovação da GO, já feita, não se repete); Diretoria: volta ao cálculo do RH
    const destino = e.atual.formulario ? (e.ord.find((x) => x.formulario === e.atual.formulario && x.acao !== "validacao" && x.ordem < e.atual.ordem) || e.anterior) : (e.atual.acao === "diretoria" ? (e.ord.slice(0, e.idx).reverse().find((x) => x.acao === "calculo") || e.anterior) : e.anterior);
    if (!destino) throw erro(409, "Não há etapa anterior para devolver.");
    await c.query("UPDATE adm_passagens SET fim = now() WHERE etapa_id = $1 AND fim IS NULL", [e.atual.id]);
    // as etapas entre o destino e a atual que já estavam concluídas continuam concluídas; só o destino reabre
    await c.query("UPDATE adm_proc_etapas SET status = 'pendente', concluida_em = NULL, concluida_por = NULL, obs = NULL WHERE id = $1", [destino.id]);
    await abrirPassagem(c, id, destino.id, new Date());
    if (e.atual.formulario) await c.query("UPDATE adm_formularios SET status = 'devolvido' WHERE processo_id = $1 AND tipo = $2", [id, e.atual.formulario]);
    await c.query("INSERT INTO adm_devolucoes (processo_id, etapa_validacao_id, etapa_destino_id, etapa_nome, motivo_cat, detalhe, usuario) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, e.atual.id, destino.id, destino.nome, cat, detalhe, p.email]);
    await c.query("UPDATE adm_processos SET atualizado_em = now() WHERE id = $1", [id]);
    await evento(c, id, "devolvida", p.email, { etapa: e.atual.nome, para: destino.nome, motivo_cat: cat, detalhe });
    return { protocolo: e.raw.protocolo, de: e.atual.nome, para: destino.nome };
  });
  audit(acc, "adm_devolvida", { papel: p.papel, alvo: r.protocolo, detalhe: cat + " · " + r.para });
  return { ok: true, voltou_para: r.para };
}
// checklist dentro da etapa atual
async function marcarSubtarefa(acc, id, etapaId, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const e = await etapaAtual(c, id, etapaId);
    const sub = Array.isArray(e.atual.subtarefas) ? e.atual.subtarefas.map((t) => ({ ...t })) : [];
    const i = Number(b.indice);
    if (!(i >= 0 && i < sub.length)) throw erro(400, "Tarefa não encontrada.");
    const feita = b.feita !== false;
    if (feita) { sub[i].feita_em = new Date().toISOString(); sub[i].feita_por = p.email; } else { delete sub[i].feita_em; delete sub[i].feita_por; }
    await c.query("UPDATE adm_proc_etapas SET subtarefas = $2::jsonb WHERE id = $1", [e.atual.id, JSON.stringify(sub)]);
    await evento(c, id, "tarefa", p.email, { etapa: e.atual.nome, tarefa: sub[i].nome, feita });
    return { feitas: sub.filter((t) => t.feita_em).length, total: sub.length };
  });
  return { ok: true, ...r };
}
// o candidato desistiu (o gestor ainda tem o cancelamento livre)
async function encerrar(acc, id, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const motivo = txt(b.motivo).slice(0, 300);
  if (motivo.length < 5) throw erro(400, "Conte brevemente o que aconteceu (mínimo 5 letras).");
  const protocolo = await comTransacao(async (c) => {
    const { rows } = await c.query("SELECT protocolo, status, tipo FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw erro(404, "Processo não encontrado.");
    if (!ABERTOS.includes(rows[0].status)) throw erro(409, "O processo já está encerrado.");
    if (rows[0].tipo !== "admissao") throw erro(400, "A desistência vale para admissões.");
    await encerrarInterno(c, id, p, "desistencia", motivo);
    return rows[0].protocolo;
  });
  audit(acc, "adm_encerrado", { papel: p.papel, alvo: protocolo, detalhe: "desistência: " + motivo });
  return { ok: true };
}
async function pausar(acc, id, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
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
  const p = await papelDe(acc); exigirNaoGo(p);
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
  const p = await papelDe(acc); exigirNaoGo(p);
  const email = em(b.responsavel);
  const { rows: rr } = await pool.query("SELECT 1 FROM adm_equipe WHERE lower(email) = $1 AND ativo AND papel NOT IN ('go','diretoria') UNION SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [email]);
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
    await encerrarInterno(c, id, p, "outro", motivo);
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

// ---------- modelos de mensagem (copiar e colar no WhatsApp ou e-mail) ----------
async function mensagens(acc) {
  await papelDe(acc);
  const { rows } = await pool.query("SELECT chave, valor FROM adm_config WHERE chave LIKE 'msg\\_%'");
  const cust = {}; rows.forEach((r) => { cust[r.chave.slice(4)] = r.valor; });
  return { modelos: MSG_PADRAO.map((m) => ({ ...m, padrao: m.texto, texto: cust[m.chave] || m.texto, personalizada: !!cust[m.chave] })),
    variaveis: ["{nome}", "{cargo}", "{loja}", "{data_inicio}", "{link}", "{itens}", "{motivo}"] };
}
async function salvarMensagem(acc, chave, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const m = MSG_PADRAO.find((x) => x.chave === chave);
  if (!m) throw erro(404, "Modelo de mensagem não encontrado.");
  const t = txt(b.texto).slice(0, 1200);
  if (!t || t === m.texto) await pool.query("DELETE FROM adm_config WHERE chave = $1", ["msg_" + chave]);
  else {
    if (t.length < 10) throw erro(400, "A mensagem está muito curta.");
    await pool.query("INSERT INTO adm_config (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", ["msg_" + chave, t]);
  }
  audit(acc, "adm_msg_modelo", { papel: p.papel, alvo: chave });
  return { ok: true };
}

// ---------- cadastros: etapas ----------
async function listarEtapasModelo(acc, f = {}) {
  const pp = await papelDe(acc); exigirNaoGo(pp);
  const { rows } = await pool.query("SELECT id::int AS id, tipo, nome, descricao, area, prazo_min, ordem, ativo, acao, externo, exige_candidato, subtarefas, mensagem, formulario FROM adm_etapas_modelo " + (TIPOS.includes(f.tipo) ? "WHERE tipo = $1 " : "") + "ORDER BY tipo, ordem, id", TIPOS.includes(f.tipo) ? [f.tipo] : []);
  const cfg = {};
  for (const t of TIPOS) { const { rows: c } = await pool.query("SELECT valor FROM adm_config WHERE chave = $1", ["sla_total_" + t]); cfg[t] = { definido: Number(c[0] && c[0].valor) || null, soma: rows.filter((r) => r.tipo === t && r.ativo).reduce((s2, r) => s2 + r.prazo_min, 0) }; }
  return { etapas: rows, totais: cfg, acoes: ACOES, mensagens: MSG_PADRAO.map((m) => ({ chave: m.chave, titulo: m.titulo })) };
}
async function salvarEtapaModelo(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const nome = txt(b.nome).slice(0, 140);
  if (nome.length < 3) throw erro(400, "Informe o nome da etapa.");
  const prazo = Math.round(Number(b.prazo_min));
  if (!(prazo > 0)) throw erro(400, "Informe o prazo da etapa (maior que zero).");
  const area = txt(b.area).slice(0, 60) || null, desc = txt(b.descricao).slice(0, 400) || null;
  const acao = ACOES.includes(txt(b.acao)) ? txt(b.acao) : "normal";
  const externo = !!b.externo, exige = !!b.exige_candidato;
  const sub = (Array.isArray(b.subtarefas) ? b.subtarefas : []).map((x) => txt(x).slice(0, 120)).filter(Boolean).slice(0, 10);
  const msg = MSG_PADRAO.some((m) => m.chave === txt(b.mensagem)) ? txt(b.mensagem) : null;
  const form = FORM_TIPOS[txt(b.formulario)] ? txt(b.formulario) : null;
  try {
    if (id) {
      const { rows } = await pool.query("UPDATE adm_etapas_modelo SET nome=$2, descricao=$3, area=$4, prazo_min=$5, ordem=COALESCE($6, ordem), ativo=COALESCE($7, ativo), acao=$8, externo=$9, exige_candidato=$10, subtarefas=$11::jsonb, mensagem=$12, formulario=$13 WHERE id=$1 RETURNING id",
        [id, nome, desc, area, prazo, b.ordem === undefined ? null : Math.round(Number(b.ordem)), b.ativo === undefined ? null : !!b.ativo, acao, externo, exige, JSON.stringify(sub), msg, form]);
      if (!rows[0]) throw erro(404, "Etapa não encontrada.");
    } else {
      const tipo = txt(b.tipo); if (!TIPOS.includes(tipo)) throw erro(400, "Escolha o tipo (admissão ou rescisão).");
      const { rows: mx } = await pool.query("SELECT coalesce(max(ordem),0)::int AS m FROM adm_etapas_modelo WHERE tipo = $1", [tipo]);
      await pool.query("INSERT INTO adm_etapas_modelo (tipo, nome, descricao, area, prazo_min, ordem, acao, externo, exige_candidato, subtarefas, mensagem, formulario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
        [tipo, nome, desc, area, prazo, b.ordem === undefined || b.ordem === "" ? mx[0].m + 1 : Math.round(Number(b.ordem)), acao, externo, exige, JSON.stringify(sub), msg, form]);
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
  const { rows } = await pool.query(`SELECT e.id::int AS id, e.email, e.nome, e.papel, e.ativo, e.grupos, (u.id IS NOT NULL AND ('admissao' = ANY(u.modules) OR u.role = 'admin')) AS tem_acesso
    FROM adm_equipe e LEFT JOIN users u ON lower(u.email) = lower(e.email) ORDER BY e.ativo DESC, e.papel, e.nome NULLS LAST, e.email`);
  const { rows: ad } = await pool.query("SELECT email, nome FROM users WHERE role = 'admin' ORDER BY email");
  return { equipe: rows, administradores: ad, grupos_disponiveis: await gruposDisponiveis() };
}
// grupos de lojas = nomes das GOs no cadastro de lojas (coluna "regional"), com a lista de lojas de cada um
async function gruposDisponiveis() {
  const { rows } = await pool.query("SELECT regional, array_agg(nome ORDER BY nome) AS lojas FROM ch_lojas WHERE ativa AND coalesce(trim(regional), '') <> '' GROUP BY regional ORDER BY lower(regional)");
  const vistos = new Map();
  for (const r of rows) { const k = r.regional.trim().toLowerCase(); if (vistos.has(k)) vistos.get(k).lojas.push(...r.lojas); else vistos.set(k, { nome: r.regional.trim(), lojas: r.lojas.slice() }); }
  return [...vistos.values()].map((g) => ({ nome: g.nome, total: g.lojas.length, lojas: g.lojas.sort() }));
}
async function gruposDe(email) {
  const { rows } = await pool.query("SELECT grupos FROM adm_equipe WHERE lower(email) = $1", [em(email)]);
  return rows[0] ? rows[0].grupos || [] : [];
}
async function gruposValidos(lista) {
  const disp = await gruposDisponiveis(), out = [];
  for (const g of Array.isArray(lista) ? lista : []) {
    const k = txt(g).toLowerCase(); if (!k) continue;
    const ach = disp.find((x) => x.nome.toLowerCase() === k);
    if (!ach) throw erro(400, "O grupo \"" + txt(g).slice(0, 40) + "\" não existe no cadastro de lojas.");
    if (!out.includes(ach.nome)) out.push(ach.nome);
  }
  return out;
}
async function criarEquipe(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.email), nome = txt(b.nome).slice(0, 100) || null, papel = PAPEIS.includes(txt(b.papel)) ? txt(b.papel) : "analista";
  if (!emailValido(email)) throw erro(400, "Informe um e-mail válido.");
  const grupos = papel === "go" ? await gruposValidos(b.grupos) : [];
  if (papel === "go" && !grupos.length) throw erro(400, "Escolha o grupo de lojas desta GO. Ela só enxerga as lojas do grupo dela.");
  const ac = await garantirAcesso(email, nome, b.senha ? String(b.senha) : undefined);
  await pool.query(`INSERT INTO adm_equipe (email, nome, papel, ativo, grupos) VALUES ($1,$2,$3,true,$4)
    ON CONFLICT (lower(email)) DO UPDATE SET papel = EXCLUDED.papel, ativo = true, nome = COALESCE(EXCLUDED.nome, adm_equipe.nome), grupos = EXCLUDED.grupos`, [email, nome, papel, grupos]);
  audit(acc, ac.criado ? "acesso_criado" : "acesso_liberado", { papel: p.papel, alvo: email, detalhe: "Admissão e Rescisão · " + papel + (grupos.length ? " · lojas de " + grupos.join(", ") : "") });
  return { ok: true, acesso_criado: ac.criado };
}
async function editarEquipe(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const { rows } = await pool.query("SELECT email, papel, grupos FROM adm_equipe WHERE id = $1", [id]);
  if (!rows[0]) throw erro(404, "Pessoa não encontrada.");
  const email = em(rows[0].email);
  const papelFinal = b.papel ? (PAPEIS.includes(b.papel) ? b.papel : "analista") : rows[0].papel;
  let grupos = rows[0].grupos || [];
  if (papelFinal !== "go") grupos = [];
  else if (b.grupos !== undefined) grupos = await gruposValidos(b.grupos);
  if (papelFinal === "go" && b.ativo !== false && !grupos.length) throw erro(400, "Escolha o grupo de lojas desta GO. Ela só enxerga as lojas do grupo dela.");
  if (email === p.email && (b.ativo === false || (b.papel && b.papel !== "gestor"))) throw erro(400, "Você não pode tirar o seu próprio acesso de gestor.");
  await pool.query("UPDATE adm_equipe SET nome = COALESCE($2, nome), papel = COALESCE($3, papel), ativo = COALESCE($4, ativo), grupos = $5 WHERE id = $1", [id, b.nome === undefined ? null : txt(b.nome) || null, b.papel ? papelFinal : null, b.ativo === undefined ? null : !!b.ativo, grupos]);
  if (b.ativo === false) await pool.query("UPDATE users SET modules = array_remove(modules, 'admissao'), token_version = token_version + 1 WHERE lower(email) = $1 AND role <> 'admin'", [email]);
  if (b.ativo === true) await garantirAcesso(email, null, undefined);
  audit(acc, b.ativo === false ? "acesso_bloqueado" : "acesso_alterado", { papel: p.papel, alvo: email, detalhe: "Admissão e Rescisão" + (papelFinal === "go" ? " · lojas de " + (grupos.join(", ") || "nenhum grupo") : "") });
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
  const pp = await papelDe(acc); exigirNaoGo(pp);
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
  // quem segura o processo: tempo com o RH x fora do RH (GO, loja, candidato, clínica)
  const tRh = per.reduce((s2, x) => s2 + x.lados.rh, 0), tFora = per.reduce((s2, x) => s2 + x.lados.fora, 0);
  kpis.tempo_rh_min = Math.round(tRh); kpis.tempo_fora_min = Math.round(tFora);
  kpis.fora_do_rh_pct = tRh + tFora > 0 ? pct(tFora, tRh + tFora) : null;
  const adms = per.filter((x) => x.tipo === "admissao" && x.status !== "cancelado" || x.tipo === "admissao" && x.retornos > 0);
  kpis.retornos_total = per.reduce((s2, x) => s2 + x.retornos, 0);
  kpis.com_retorno = per.filter((x) => x.retornos > 0).length;
  kpis.retrabalho_pct = adms.length ? pct(adms.filter((x) => x.retornos > 0).length, adms.length) : null;
  kpis.aguardando_go = abertos.filter((x) => x.etapa_atual && x.etapa_atual.acao === "aprovacao").length;
  kpis.com_rh_agora = abertos.filter((x) => x.status === "em_andamento" && x.etapa_atual && !x.etapa_atual.externo).length;
  kpis.fora_agora = abertos.filter((x) => x.status === "em_andamento" && x.etapa_atual && x.etapa_atual.externo).length;
  const mapaAr = new Map();
  per.forEach((x) => x.etapas.forEach((e) => { if (!(e.tempo_total > 0)) return; const k = e.area || "Outros"; if (!mapaAr.has(k)) mapaAr.set(k, { area: k, externo: e.externo, total: 0, procs: new Set() }); const m = mapaAr.get(k); m.total += e.tempo_total; m.procs.add(x.id); }));
  const porArea = [...mapaAr.values()].map((m) => ({ area: m.area, externo: m.externo, total_min: Math.round(m.total), processos: m.procs.size, media_por_processo_min: Math.round((m.total / m.procs.size) * 10) / 10 })).sort((a, b) => b.total_min - a.total_min);
  const contar = (arr) => { const m = new Map(); arr.forEach((k) => m.set(k, (m.get(k) || 0) + 1)); return [...m.entries()].map(([k, n]) => ({ rotulo: k, n })).sort((a, b) => b.n - a.n); };
  const porDesfecho = contar(per.filter((x) => x.status === "cancelado").map((x) => x.desfecho_rotulo));
  const todasDev = per.flatMap((x) => x.devolucoes.map((d) => ({ ...d, unidade: x.unidade })));
  const devMotivo = contar(todasDev.map((d) => d.motivo_cat));
  const devEtapa = contar(todasDev.map((d) => d.etapa));
  const devLoja = (() => { const g = new Map(); per.filter((x) => x.tipo === "admissao").forEach((x) => { const m = g.get(x.unidade) || { rotulo: x.unidade, processos: 0, devolucoes: 0 }; m.processos++; m.devolucoes += x.retornos; g.set(x.unidade, m); }); return [...g.values()].filter((m) => m.devolucoes > 0).sort((a, b) => b.devolucoes - a.devolucoes).slice(0, 10); })();
  // por etapa (nome + tipo): tempo médio, % no prazo, estouradas agora (gargalo)
  const mapaEt = new Map();
  const chaveEt = (tipo, e) => tipo + "|" + e.ordem + "|" + e.nome;
  per.concat(abertos.filter((a) => !per.some((x) => x.id === a.id))).forEach((proc) => proc.etapas.forEach((e) => {
    const k = chaveEt(proc.tipo, e);
    if (!mapaEt.has(k)) mapaEt.set(k, { tipo: proc.tipo, ordem: e.ordem, nome: e.nome, area: e.area, meta_min: e.prazo_min, externo: e.externo, acao: e.acao, feitas: [], no_prazo: 0, fora: 0, atrasadas_agora: 0, atuais: 0, chegaram: 0, voltas: 0 });
    const m = mapaEt.get(k);
    if (e.situacao === "cumprida" || e.situacao === "descumprida") { m.feitas.push(e.decorrido); if (e.situacao === "cumprida") m.no_prazo++; else m.fora++; }
    if (e.atual) { m.atuais++; if (e.situacao === "estourado") m.atrasadas_agora++; }
    if (e.chegou) m.chegaram++;
    m.voltas += e.voltas;
  }));
  const porEtapa = [...mapaEt.values()].map((m) => ({ tipo: m.tipo, ordem: m.ordem, nome: m.nome, area: m.area, meta_min: m.meta_min, externo: m.externo, acao: m.acao, chegaram: m.chegaram, voltas: m.voltas, concluidas: m.feitas.length, tempo_medio_min: media(m.feitas), no_prazo_pct: pct(m.no_prazo, m.no_prazo + m.fora), em_andamento: m.atuais, atrasadas_agora: m.atrasadas_agora }))
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
  return { periodo: { de, ate }, kpis, por_area: porArea, por_desfecho: porDesfecho, devolucoes: { total: todasDev.length, por_motivo: devMotivo, por_etapa: devEtapa, por_loja: devLoja }, por_etapa: porEtapa, por_responsavel: porResp, por_loja: porLoja, por_subtipo: porSubtipo, por_mes: porMes, mais_urgentes: urgentes, proximos_prazos: proximos,
    lista: per.map((x) => ({ protocolo: x.protocolo, tipo: x.tipo_rotulo, colaborador: x.colaborador, cpf: x.cpf_mascarado, cargo: x.cargo, unidade: x.unidade, subtipo: x.subtipo, data_prevista: x.data_prevista, status: x.status, responsavel: x.responsavel_nome || x.responsavel,
      criado_em: x.criado_em, concluido_em: x.concluido_em, retornos: x.retornos, desfecho: x.desfecho_rotulo, tempo_rh_min: x.lados.rh, tempo_fora_min: x.lados.fora, meta_total_min: x.total.meta, tempo_total_min: x.total.decorrido, sla_total: x.total.situacao, prazo_data: x.prazo_data.situacao, prazo_data_limite: x.prazo_data.limite, etapa_atual: x.etapa_atual ? x.etapa_atual.nome : null,
      etapas: x.etapas.map((e) => ({ nome: e.nome, area: e.area, meta_min: e.prazo_min, tempo_min: e.tempo_total, voltas: e.voltas, situacao: e.situacao })) })) };
}

// ====================================================================================
// FORMULÁRIOS: Link 1 (pré-admissão, preenchido pelo gerente) e Link 2 (admissão, preenchido pelo candidato).
// O sistema gera um link próprio por vaga (sem login), a pessoa preenche e anexa os documentos, o RH confere
// item por item e, se algo estiver errado, devolve: o mesmo link reabre só com o que precisa ser corrigido.
// ====================================================================================
const crypto = require("crypto");
const seguranca = require("../seguranca");
const FORM_TIPOS = { pre: "Pré-admissão (gerente)", adm: "Admissão (candidato)" };
const ESTADO_CIVIL = ["Solteiro(a)", "Casado(a)", "União estável", "Separado(a)", "Divorciado(a)", "Viúvo(a)"];
const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];
const PARENTESCOS = ["Filho(a)", "Cônjuge ou companheiro(a)", "Enteado(a)", "Pai ou mãe", "Outro"];
// regra do formulário: um dado por campo (nada de "nome e telefone" no mesmo campo)
const FORM_PADRAO = {
  pre: [
    { chave: "nome_candidato", rotulo: "Nome completo do candidato", kind: "texto", obrigatorio: true, fixo: true },
    { chave: "data_inicio", rotulo: "Data prevista de início", kind: "data", obrigatorio: true, fixo: true },
    { chave: "vt_assinado", rotulo: "Documento do vale-transporte assinado pelo candidato (com o valor do VT)", kind: "arquivo", obrigatorio: true, fixo: true },
    { chave: "telefone", rotulo: "WhatsApp do candidato (com DDD)", kind: "telefone", obrigatorio: true },
    { chave: "email", rotulo: "E-mail do candidato", kind: "email", obrigatorio: false },
    { chave: "escala", rotulo: "Horário ou escala de trabalho", kind: "texto", obrigatorio: false },
    { chave: "rg_cnh", rotulo: "RG ou CNH (frente e verso)", kind: "arquivo", obrigatorio: true },
    { chave: "cpf_doc", rotulo: "CPF (documento ou comprovante)", kind: "arquivo", obrigatorio: true },
    { chave: "curriculo", rotulo: "Currículo ou ficha de entrevista", kind: "arquivo", obrigatorio: false },
  ],
  adm: [
    { chave: "nome_completo", rotulo: "Nome completo", kind: "texto", obrigatorio: true },
    { chave: "cpf", rotulo: "CPF", kind: "cpf", obrigatorio: true },
    { chave: "nascimento", rotulo: "Data de nascimento", kind: "data", obrigatorio: true },
    { chave: "estado_civil", rotulo: "Estado civil", kind: "selecao", opcoes: ESTADO_CIVIL, obrigatorio: true },
    { chave: "telefone", rotulo: "Telefone com DDD", kind: "telefone", obrigatorio: true },
    { chave: "cep", rotulo: "CEP", kind: "cep", obrigatorio: true },
    { chave: "logradouro", rotulo: "Rua, avenida ou travessa", kind: "texto", obrigatorio: true },
    { chave: "numero", rotulo: "Número", kind: "texto", obrigatorio: true },
    { chave: "complemento", rotulo: "Complemento (apto, bloco, casa)", kind: "texto", obrigatorio: false },
    { chave: "bairro", rotulo: "Bairro", kind: "texto", obrigatorio: true },
    { chave: "cidade", rotulo: "Cidade", kind: "texto", obrigatorio: true },
    { chave: "uf", rotulo: "Estado (UF)", kind: "selecao", opcoes: UFS, obrigatorio: true },
    { chave: "contato_nome", rotulo: "Contato de emergência: nome", kind: "texto", obrigatorio: true },
    { chave: "contato_telefone", rotulo: "Contato de emergência: telefone", kind: "telefone", obrigatorio: true },
    { chave: "banco", rotulo: "Banco", kind: "banco", obrigatorio: true },
    { chave: "agencia", rotulo: "Agência (sem o dígito)", kind: "texto", obrigatorio: true },
    { chave: "conta", rotulo: "Conta corrente (com o dígito)", kind: "texto", obrigatorio: true },
    { chave: "pis", rotulo: "PIS/PASEP (se já tiver)", kind: "texto", obrigatorio: false },
    { chave: "dependentes", rotulo: "Dependentes (filhos, cônjuge...)", kind: "dependentes", obrigatorio: false },
    { chave: "rg_cnh", rotulo: "RG ou CNH (frente e verso)", kind: "arquivo", obrigatorio: true },
    { chave: "ctps", rotulo: "Carteira de trabalho (digital ou física)", kind: "arquivo", obrigatorio: true },
    { chave: "comprovante", rotulo: "Comprovante de residência recente", kind: "arquivo", obrigatorio: true },
    { chave: "titulo", rotulo: "Título de eleitor", kind: "arquivo", obrigatorio: false },
    { chave: "foto", rotulo: "Foto 3x4 ou selfie de rosto", kind: "arquivo", obrigatorio: false },
    { chave: "certidao_casamento", rotulo: "Certidão de casamento", kind: "arquivo", obrigatorio: false },
    { chave: "certidao_filhos", rotulo: "Certidão de nascimento dos filhos", kind: "arquivo", obrigatorio: false },
  ],
};
const FORM_KINDS = ["texto", "email", "cpf", "telefone", "data", "cep", "selecao", "banco", "dependentes", "arquivo"];
const MIMES = {
  "application/pdf": (b) => b.slice(0, 4).toString() === "%PDF",
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b.slice(1, 4).toString() === "PNG",
  "image/webp": (b) => b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP",
};
const MAX_ARQ = 5 * 1024 * 1024, MAX_POR_ITEM = 3;
const dataIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(txt(v)) && !isNaN(new Date(txt(v) + "T12:00:00Z").getTime());


const digitos = (v) => txt(v).replace(/\D/g, "");
// valida e normaliza o valor de um campo conforme o tipo; devolve o texto a gravar
function valorDoCampo(kind, bruto, opcoes) {
  const v = txt(bruto);
  if (!v) return "";
  if (kind === "data") { if (!dataIso(v)) throw erro(400, "Data inválida."); return v; }
  if (kind === "email") { if (!emailValido(v.toLowerCase())) throw erro(400, "E-mail inválido."); return v.toLowerCase().slice(0, 160); }
  if (kind === "cpf") { const d = digitos(v); if (d.length !== 11 || !cpfValido(d)) throw erro(400, "O CPF informado não é válido."); return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"); }
  if (kind === "telefone") { const d = digitos(v); if (d.length < 10 || d.length > 11) throw erro(400, "Telefone inválido. Informe o DDD e o número."); return d.length === 11 ? d.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3") : d.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3"); }
  if (kind === "cep") { const d = digitos(v); if (d.length !== 8) throw erro(400, "CEP inválido."); return d.replace(/(\d{5})(\d{3})/, "$1-$2"); }
  if (kind === "selecao") { if (!(Array.isArray(opcoes) ? opcoes : []).includes(v)) throw erro(400, "Escolha uma das opções da lista."); return v; }
  if (kind === "dependentes") {
    let lista; try { lista = JSON.parse(v); } catch (e) { throw erro(400, "Dependentes inválidos."); }
    if (!Array.isArray(lista) || lista.length > 12) throw erro(400, "Informe até 12 dependentes.");
    const out = lista.map((d) => {
      const nome = txt(d && d.nome).slice(0, 120), nasc = txt(d && d.nascimento), par = txt(d && d.parentesco), cpf = txt(d && d.cpf);
      if (nome.length < 3) throw erro(400, "Dependente: informe o nome completo.");
      if (!dataIso(nasc)) throw erro(400, "Dependente " + nome + ": informe a data de nascimento.");
      if (!PARENTESCOS.includes(par)) throw erro(400, "Dependente " + nome + ": escolha o parentesco.");
      let cpfN = "";
      if (cpf) { const dd = digitos(cpf); if (dd.length !== 11 || !cpfValido(dd)) throw erro(400, "Dependente " + nome + ": CPF inválido."); cpfN = dd.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"); }
      return { nome, nascimento: nasc, parentesco: par, cpf: cpfN };
    });
    return out.length ? JSON.stringify(out) : "";
  }
  return v.slice(0, 400);
}
async function modeloForm(c, tipo) {
  const { rows } = await c.query("SELECT valor FROM adm_config WHERE chave = $1", ["form_" + tipo]);
  if (rows[0]) { try { const v = JSON.parse(rows[0].valor); if (Array.isArray(v) && v.length) return v; } catch (e) { /* usa o padrão */ } }
  return FORM_PADRAO[tipo];
}
async function formulariosModelo(acc) {
  const p = await papelDe(acc); exigirNaoGo(p);
  return { pre: await modeloForm(pool, "pre"), adm: await modeloForm(pool, "adm"), tipos: FORM_TIPOS };
}
async function salvarFormularioModelo(acc, tipo, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  if (!FORM_TIPOS[tipo]) throw erro(400, "Formulário inválido.");
  if (b.restaurar) {
    await pool.query("DELETE FROM adm_config WHERE chave = $1", ["form_" + tipo]);
    audit(acc, "adm_form_modelo", { papel: p.papel, alvo: FORM_TIPOS[tipo], detalhe: "restaurou o padrão" });
    return { ok: true, campos: FORM_PADRAO[tipo] };
  }
  const entrada = Array.isArray(b.campos) ? b.campos : [];
  const vistos = new Set(), lista = [];
  for (const x of entrada.slice(0, 40)) {
    const rotulo = txt(x.rotulo).slice(0, 120);
    if (rotulo.length < 2) throw erro(400, "Todo campo precisa de um nome.");
    const kind = FORM_KINDS.includes(txt(x.kind)) ? txt(x.kind) : "texto";
    let chave = /^[a-z0-9_]{2,40}$/.test(txt(x.chave)) ? txt(x.chave) : rotulo.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 36) || "campo";
    let n = 2; const base = chave; while (vistos.has(chave)) chave = base + "_" + n++;
    vistos.add(chave);
    const opcoes = kind === "selecao" ? (Array.isArray(x.opcoes) ? x.opcoes : []).map((o) => txt(o).slice(0, 60)).filter(Boolean).slice(0, 40) : undefined;
    if (kind === "selecao" && opcoes.length < 2) throw erro(400, "Campo de lista \"" + rotulo + "\": informe pelo menos 2 opções.");
    lista.push({ chave, rotulo, kind, ...(opcoes ? { opcoes } : {}), obrigatorio: !!x.obrigatorio, ...(["nome_candidato", "data_inicio", "vt_assinado"].includes(chave) && tipo === "pre" ? { fixo: true, obrigatorio: true } : {}) });
  }
  if (tipo === "pre") for (const f of FORM_PADRAO.pre.filter((x) => x.fixo)) if (!lista.some((x) => x.chave === f.chave)) lista.unshift(f);
  if (!lista.length) throw erro(400, "O formulário precisa de pelo menos um campo.");
  await pool.query("INSERT INTO adm_config (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", ["form_" + tipo, JSON.stringify(lista)]);
  audit(acc, "adm_form_modelo", { papel: p.papel, alvo: FORM_TIPOS[tipo], detalhe: lista.length + " campos" });
  return { ok: true, campos: lista };
}

async function garantirForm(c, procId, tipo, email) {
  const { rows } = await c.query("SELECT id FROM adm_formularios WHERE processo_id = $1 AND tipo = $2", [procId, tipo]);
  if (rows[0]) return rows[0].id;
  const { rows: pr } = await c.query("SELECT colaborador, to_char(data_prevista, 'YYYY-MM-DD') AS dia FROM adm_processos WHERE id = $1", [procId]);
  const { rows: nf } = await c.query("INSERT INTO adm_formularios (processo_id, tipo, token, criado_por) VALUES ($1,$2,$3,$4) RETURNING id", [procId, tipo, crypto.randomBytes(24).toString("hex"), email || null]);
  let o = 0;
  for (const m of await modeloForm(c, tipo)) {
    const valor = (m.chave === "nome_candidato" || m.chave === "nome_completo") ? pr[0].colaborador || null : m.chave === "data_inicio" ? pr[0].dia || null : null;
    await c.query("INSERT INTO adm_form_itens (form_id, ordem, chave, rotulo, kind, obrigatorio, valor, opcoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [nf[0].id, ++o, m.chave, m.rotulo, m.kind, !!m.obrigatorio, valor, m.opcoes ? JSON.stringify(m.opcoes) : null]);
  }
  await evento(c, procId, "formulario_gerado", email || null, { formulario: FORM_TIPOS[tipo] });
  return nf[0].id;
}
async function itensDoForm(c, formId) {
  const { rows: it } = await c.query("SELECT id::int AS id, chave, rotulo, kind, opcoes, obrigatorio, valor, status, obs_rh FROM adm_form_itens WHERE form_id = $1 ORDER BY ordem, id", [formId]);
  const { rows: ar } = await c.query("SELECT a.id::int AS id, a.item_id::int AS item_id, a.nome, a.mime, a.tamanho FROM adm_form_arquivos a JOIN adm_form_itens i ON i.id = a.item_id WHERE i.form_id = $1 ORDER BY a.id", [formId]);
  return it.map((i) => ({ ...i, arquivos: ar.filter((a) => a.item_id === i.id).map(({ item_id, ...r }) => r) }));
}
const FORM_COLS = "id::int AS id, processo_id::int AS processo_id, tipo, token, status, enviado_em, enviado_vezes, criado_em";
// RH: lê (ou gera) o formulário de um processo
async function formulario(acc, id, tipo, gerar) {
  const p = await papelDe(acc); exigirNaoGo(p);
  if (!FORM_TIPOS[tipo]) throw erro(400, "Formulário inválido.");
  const { rows: pr } = await pool.query("SELECT id, tipo, protocolo, status FROM adm_processos WHERE id = $1", [id]);
  if (!pr[0]) throw erro(404, "Processo não encontrado.");
  if (pr[0].tipo !== "admissao") throw erro(400, "Só admissões têm formulário.");
  let { rows: f } = await pool.query(`SELECT ${FORM_COLS} FROM adm_formularios WHERE processo_id = $1 AND tipo = $2`, [id, tipo]);
  if (!f[0]) {
    if (!gerar) return { formulario: null };
    if (!ABERTOS.includes(pr[0].status)) throw erro(409, "O processo não está em andamento.");
    await comTransacao((c) => garantirForm(c, id, tipo, p.email));
    ({ rows: f } = await pool.query(`SELECT ${FORM_COLS} FROM adm_formularios WHERE processo_id = $1 AND tipo = $2`, [id, tipo]));
  } else if (!gerar) audit(acc, "adm_ver_form", { papel: p.papel, alvo: pr[0].protocolo, detalhe: FORM_TIPOS[tipo] });
  return { formulario: { ...f[0], rotulo: FORM_TIPOS[tipo], itens: await itensDoForm(pool, f[0].id) } };
}
// RH: marca cada item como correto ou incorreto (com o que está errado)
async function revisarItem(acc, id, itemId, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const st = txt(b.status);
  if (!["ok", "incorreto", "pendente"].includes(st)) throw erro(400, "Marque o item como correto ou incorreto.");
  const obs = txt(b.obs).slice(0, 300);
  if (st === "incorreto" && obs.length < 3) throw erro(400, "Explique o que está incorreto neste item.");
  const { rows } = await pool.query(`SELECT i.id, f.status AS fstatus, p.protocolo FROM adm_form_itens i JOIN adm_formularios f ON f.id = i.form_id JOIN adm_processos p ON p.id = f.processo_id WHERE i.id = $1 AND f.processo_id = $2`, [itemId, id]);
  if (!rows[0]) throw erro(404, "Item não encontrado.");
  if (rows[0].fstatus !== "enviado") throw erro(409, "O formulário só pode ser conferido depois que for enviado e enquanto a validação estiver aberta.");
  await pool.query("UPDATE adm_form_itens SET status = $2, obs_rh = $3, atualizado_em = now() WHERE id = $1", [itemId, st, st === "incorreto" ? obs : null]);
  return { ok: true };
}
async function arquivoRH(acc, id, arqId) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const { rows } = await pool.query(`SELECT a.nome, a.mime, a.dados, p.protocolo FROM adm_form_arquivos a JOIN adm_form_itens i ON i.id = a.item_id JOIN adm_formularios f ON f.id = i.form_id JOIN adm_processos p ON p.id = f.processo_id WHERE a.id = $1 AND f.processo_id = $2`, [arqId, id]);
  if (!rows[0]) throw erro(404, "Arquivo não encontrado.");
  audit(acc, "adm_ver_doc", { papel: p.papel, alvo: rows[0].protocolo, detalhe: rows[0].nome });
  return { nome: rows[0].nome, mime: rows[0].mime, base64: rows[0].dados.toString("base64") };
}
// telefone do candidato para o WhatsApp: o que ele mesmo informou no Link 2 vale mais; senão, o que o gerente informou no Link 1
async function telefoneCandidato(id) {
  const { rows } = await pool.query("SELECT i.valor FROM adm_form_itens i JOIN adm_formularios f ON f.id = i.form_id WHERE f.processo_id = $1 AND i.chave = 'telefone' AND i.valor IS NOT NULL AND i.valor <> '' ORDER BY (f.tipo = 'adm') DESC, f.id LIMIT 1", [id]);
  return rows[0] ? rows[0].valor : null;
}
async function resumoFormularios(id, comToken) {
  const { rows: fs } = await pool.query(`SELECT ${FORM_COLS} FROM adm_formularios WHERE processo_id = $1`, [id]);
  const out = {};
  for (const f of fs) {
    const { rows: n } = await pool.query("SELECT count(*) FILTER (WHERE i.obrigatorio OR i.valor IS NOT NULL OR EXISTS (SELECT 1 FROM adm_form_arquivos x WHERE x.item_id = i.id))::int AS total, count(*) FILTER (WHERE i.status = 'ok')::int AS ok, count(*) FILTER (WHERE i.status = 'incorreto')::int AS incorretos FROM adm_form_itens i WHERE i.form_id = $1", [f.id]);
    out[f.tipo] = { status: f.status, enviado_em: f.enviado_em, enviado_vezes: f.enviado_vezes, itens: n[0].total, itens_ok: n[0].ok, itens_incorretos: n[0].incorretos, ...(comToken ? { token: f.token } : {}) };
  }
  return out;
}

// ---------- parte pública (sem login; quem tem o link preenche) ----------
// freio contra quem fica adivinhando links: 20 links inválidos em 15 minutos bloqueiam o IP por 15 minutos (contador próprio, não mexe no login)
const tentativasLink = new Map();
function freioLink(ip) { const x = tentativasLink.get(ip || ""); return x && x.ate > Date.now() ? Math.ceil((x.ate - Date.now()) / 1000) : 0; }
function falhaLink(ip) {
  const agora = Date.now(), k = ip || "", x = tentativasLink.get(k) || { n: 0, desde: agora, ate: 0 };
  if (agora - x.desde > 15 * 60000) { x.n = 0; x.desde = agora; x.ate = 0; }
  if (++x.n >= 20) x.ate = agora + 15 * 60000;
  tentativasLink.set(k, x);
}
setInterval(() => { const agora = Date.now(); for (const [k, x] of tentativasLink) if (agora - x.desde > 30 * 60000) tentativasLink.delete(k); }, 10 * 60000).unref();
async function formPorToken(token, ip) {
  const espera = freioLink(ip);
  if (espera) throw seguranca.erroBloqueio(espera);
  token = txt(token);
  const invalido = () => { falhaLink(ip); return erro(404, "Este link não existe ou foi desativado. Peça um novo link ao RH."); };
  if (!/^[a-f0-9]{48}$/.test(token)) throw invalido();
  const { rows } = await pool.query(`SELECT f.id::int AS id, f.processo_id::int AS processo_id, f.tipo, f.status, f.enviado_em, p.status AS pstatus, p.cargo, p.unidade, p.colaborador, p.protocolo
    FROM adm_formularios f JOIN adm_processos p ON p.id = f.processo_id WHERE f.token = $1`, [token]);
  if (!rows[0]) throw invalido();
  return rows[0];
}
async function etapasDoForm(c, f) {
  const { rows } = await c.query("SELECT id::int AS id, ordem, status, acao FROM adm_proc_etapas WHERE processo_id = $1 AND formulario = $2 ORDER BY ordem, id", [f.processo_id, f.tipo]);
  const coleta = rows.find((e) => e.acao !== "validacao") || null;
  const { rows: at } = await c.query("SELECT id::int AS id FROM adm_proc_etapas WHERE processo_id = $1 AND status = 'pendente' ORDER BY ordem, id LIMIT 1", [f.processo_id]);
  return { coleta, atualId: at[0] ? at[0].id : null };
}
async function publicoVer(token, ip) {
  const f = await formPorToken(token, ip);
  const aberto = ABERTOS.includes(f.pstatus);
  const { coleta, atualId } = await etapasDoForm(pool, f);
  const liberado = aberto && !!coleta && coleta.id === atualId;
  const editavel = liberado && (f.status === "rascunho" || f.status === "devolvido");
  let msgRh = null;
  if (f.status === "devolvido") {
    const { rows: d } = await pool.query("SELECT detalhe FROM adm_devolucoes WHERE etapa_destino_id = $1 ORDER BY criado_em DESC LIMIT 1", [coleta ? coleta.id : 0]);
    msgRh = d[0] ? d[0].detalhe : null;
  }
  const itens = (await itensDoForm(pool, f.id)).map((i) => ({ id: i.id, chave: i.chave, rotulo: i.rotulo, kind: i.kind, opcoes: i.opcoes || undefined, obrigatorio: i.obrigatorio, valor: i.valor, status: i.status, obs_rh: i.status === "incorreto" ? i.obs_rh : null, arquivos: i.arquivos.map((a) => ({ id: a.id, nome: a.nome, tamanho: a.tamanho })) }));
  let situacao = f.status === "aprovado" ? "aprovado" : f.status === "enviado" ? "enviado" : !aberto ? "encerrado" : !liberado ? "aguardando" : f.status === "devolvido" ? "devolvido" : "preencher";
  if (f.status === "aprovado") situacao = "aprovado";
  return { tipo: f.tipo, titulo: f.tipo === "pre" ? "Pré-admissão" : "Admissão", cargo: f.cargo, loja: f.unidade, protocolo: f.protocolo, situacao, editavel, mensagem_rh: msgRh, enviado_em: f.enviado_em, itens,
    limites: { max_mb: MAX_ARQ / 1024 / 1024, max_por_item: MAX_POR_ITEM, tipos: Object.keys(MIMES) } };
}
async function publicoEditavel(token, ip) {
  const f = await formPorToken(token, ip);
  if (!ABERTOS.includes(f.pstatus)) throw erro(409, "Esta vaga foi encerrada. Fale com o RH.");
  if (!(f.status === "rascunho" || f.status === "devolvido")) throw erro(409, "Este formulário já foi enviado. Aguarde a conferência do RH.");
  const { coleta, atualId } = await etapasDoForm(pool, f);
  if (!coleta || coleta.id !== atualId) throw erro(409, "Este link ainda não está liberado. O RH avisa quando puder preencher.");
  return f;
}
async function publicoSalvar(token, ip, b = {}) {
  const f = await publicoEditavel(token, ip);
  const valores = b.valores && typeof b.valores === "object" ? b.valores : {};
  const { rows: it } = await pool.query("SELECT id::int AS id, chave, kind, opcoes, status FROM adm_form_itens WHERE form_id = $1", [f.id]);
  const gravar = [];
  for (const x of it) {
    if (!(String(x.id) in valores) || x.kind === "arquivo") continue;
    if (x.status === "ok") continue; // item já aprovado pelo RH não muda mais
    gravar.push([x.id, valorDoCampo(x.kind, valores[x.id], x.opcoes)]);
  }
  for (const [id, v] of gravar) await pool.query("UPDATE adm_form_itens SET status = CASE WHEN status = 'incorreto' AND valor IS DISTINCT FROM $2 THEN 'pendente' ELSE status END, valor = $2, atualizado_em = now() WHERE id = $1", [id, v || null]);
  return { ok: true };
}
async function publicoArquivo(token, ip, b = {}) {
  const f = await publicoEditavel(token, ip);
  const { rows: it } = await pool.query("SELECT id::int AS id, kind, status FROM adm_form_itens WHERE id = $1 AND form_id = $2", [Number(b.item_id) || 0, f.id]);
  if (!it[0] || it[0].kind !== "arquivo") throw erro(404, "Campo de arquivo não encontrado.");
  if (it[0].status === "ok") throw erro(409, "Este documento já foi aprovado pelo RH.");
  const mime = txt(b.mime).toLowerCase();
  if (!MIMES[mime]) throw erro(400, "Envie o documento em PDF, JPG, PNG ou WEBP.");
  const buf = Buffer.from(String(b.base64 || ""), "base64");
  if (!buf.length) throw erro(400, "Arquivo vazio.");
  if (buf.length > MAX_ARQ) throw erro(400, "O arquivo passa de " + MAX_ARQ / 1024 / 1024 + " MB. Reduza a foto ou envie em PDF menor.");
  if (!MIMES[mime](buf)) throw erro(400, "O arquivo não parece ser do tipo informado.");
  const { rows: n } = await pool.query("SELECT count(*)::int AS n FROM adm_form_arquivos WHERE item_id = $1", [it[0].id]);
  if (n[0].n >= MAX_POR_ITEM) throw erro(400, "No máximo " + MAX_POR_ITEM + " arquivos por documento. Remova um para enviar outro.");
  const nome = txt(b.nome).replace(/[^\w.\- ()À-ÿ]/g, "_").slice(0, 120) || "documento";
  const { rows } = await pool.query("INSERT INTO adm_form_arquivos (item_id, nome, mime, tamanho, dados) VALUES ($1,$2,$3,$4,$5) RETURNING id::int AS id", [it[0].id, nome, mime, buf.length, buf]);
  await pool.query("UPDATE adm_form_itens SET status = CASE WHEN status = 'incorreto' THEN 'pendente' ELSE status END, atualizado_em = now() WHERE id = $1", [it[0].id]);
  return { ok: true, arquivo: { id: rows[0].id, nome, tamanho: buf.length } };
}
async function publicoRemoverArquivo(token, ip, arqId) {
  const f = await publicoEditavel(token, ip);
  const { rows } = await pool.query("SELECT a.id, i.status FROM adm_form_arquivos a JOIN adm_form_itens i ON i.id = a.item_id WHERE a.id = $1 AND i.form_id = $2", [Number(arqId) || 0, f.id]);
  if (!rows[0]) throw erro(404, "Arquivo não encontrado.");
  if (rows[0].status === "ok") throw erro(409, "Este documento já foi aprovado pelo RH.");
  await pool.query("DELETE FROM adm_form_arquivos WHERE id = $1", [rows[0].id]);
  return { ok: true };
}
async function publicoEnviar(token, ip) {
  const f = await publicoEditavel(token, ip);
  const quem = f.tipo === "pre" ? "Link do gerente" : "Link do candidato";
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [f.processo_id]);
    const itens = await itensDoForm(c, f.id);
    const falta = itens.filter((i) => i.obrigatorio && (i.kind === "arquivo" ? !i.arquivos.length : !txt(i.valor)));
    if (falta.length) throw erro(400, "Preencha antes de enviar: " + falta.map((i) => i.rotulo).join("; ") + ".", { faltando: falta.map((i) => i.id) });
    const aCorrigir = itens.filter((i) => i.status === "incorreto");
    if (aCorrigir.length) throw erro(400, "Corrija antes de reenviar o que o RH apontou: " + aCorrigir.map((i) => i.rotulo + " (" + i.obs_rh + ")").join("; ") + ".", { faltando: aCorrigir.map((i) => i.id) });
    for (const i of itens) {
      if (i.kind === "arquivo" || !txt(i.valor)) continue;
      try { valorDoCampo(i.kind, i.valor, i.opcoes); } catch (e) { throw erro(400, i.rotulo + ": " + e.message, { faltando: [i.id] }); }
    }
    const nomeI = itens.find((i) => i.chave === "nome_candidato"), diaI = itens.find((i) => i.chave === "data_inicio");
    if (nomeI && txt(nomeI.valor).length < 3) throw erro(400, "Informe o nome completo do candidato.", { faltando: [nomeI.id] });
    if (nomeI || diaI) {
      await c.query("UPDATE adm_processos SET colaborador = COALESCE($2, colaborador), data_prevista = COALESCE($3::date, data_prevista), atualizado_em = now() WHERE id = $1", [f.processo_id, nomeI ? txt(nomeI.valor).slice(0, 120) : null, diaI && dataIso(diaI.valor) ? txt(diaI.valor) : null]);
    }
    await c.query("UPDATE adm_formularios SET status = 'enviado', enviado_em = now(), enviado_vezes = enviado_vezes + 1 WHERE id = $1", [f.id]);
    await evento(c, f.processo_id, "formulario_enviado", quem, { formulario: FORM_TIPOS[f.tipo] });
    // o envio conclui a etapa de coleta e abre a validação do RH
    const { rows: pst } = await c.query("SELECT status FROM adm_processos WHERE id = $1", [f.processo_id]);
    if (pst[0].status === "pausado") {
      await c.query("UPDATE adm_pausas SET fim = now() WHERE processo_id = $1 AND fim IS NULL", [f.processo_id]);
      await c.query("UPDATE adm_processos SET status = 'em_andamento' WHERE id = $1", [f.processo_id]);
      await evento(c, f.processo_id, "retomado", quem, null);
    }
    const { coleta } = await etapasDoForm(c, f);
    const e = await etapaAtual(c, f.processo_id, coleta.id);
    const quand = new Date();
    await c.query("UPDATE adm_proc_etapas SET status = 'concluida', concluida_em = $2, concluida_por = $3, obs = $4 WHERE id = $1", [e.atual.id, quand, quem, "Formulário enviado"]);
    await fecharPassagem(c, e.atual.id, quand);
    await evento(c, f.processo_id, "etapa_concluida", quem, { etapa: e.atual.nome, ordem: e.atual.ordem, quando: quand, obs: "Formulário enviado", final: false });
    if (e.proximo) await abrirPassagem(c, f.processo_id, e.proximo.id, quand);
    return true;
  });
  return { ok: r };
}


// ---------- lista de colaboradores (planilha do RH) ----------
// Alimenta os seletores de nome (rescisão, quem pediu a vaga). O candidato de uma admissão é pessoa nova e fica fora da regra.
const semAc = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
// nome do local na planilha do RH -> nome da loja no cadastro (quando são escritos de outro jeito)
const LOCAL_PARA_LOJA = { "sh sulacap": "sulacap t", "sh park jpa": "park shopping jpa", "sh ilha plaza rj": "ilha plaza", "sh top shopping rj": "top shopping", "sh ananindeua": "metropole ananindeua", "sh rio mar recife": "shopping rio mar", "sh ilha ma": "shopping ilha", "sh vila velha": "vila velha 2", "sh serrasul": "serrasul shopping", "sh ribeirao preto": "ribeirao preto shopping", "sh santa ursula": "santa ursula ribeirao", "sh park shopping scs": "park shopping sao caetano", "sh minas": "minas shopping", "sh park campo grande rj": "park campo grande", "sh west shopping rj": "west shopping", "sh campo grande ms": "campo grande", "sh americas": "americas shopping", "sh caxias rj": "caxias", "outlet premium sao paulo itupeva": "outlet premium sao paulo", "outlet premium grande sao paulo itaqua": "outlet premium itaqua", "sh barra rj": "barra sh", "sh brasilia": "brasilia sh", "sh park bsb": "park shopping bsb", "sh patio brasil": "patio df", "outlet premium alexania": "outlet premium", "sh salvador": "salvador shopping", "sh terraco bsb": "terraco shopping bsb", "sh barra salvador": "shopping barra salvador", "sh paralela bahia": "shopping paralela bahia", "outlet premium salvador": "outlet salvador", "sh parque bahia": "parque shopping bahia", "sh da bahia": "iguatemi salvador", "sh tijuca": "shopping tijuca 2", "sh boulevard rj iguatemi": "iguatemi", "sh jockey curitiba": "jockey plaza" };
async function lojasPorNome() {
  const { rows } = await pool.query("SELECT id::int AS id, nome FROM ch_lojas WHERE ativa");
  const m = new Map(); rows.forEach((l) => { m.set(semAc(l.nome), l.id); m.set(semAc(l.nome).replace(/^sh /, ""), l.id); });
  return m;
}
function lojaDoLocal(mapa, local) {
  const k = semAc(local); if (!k) return null;
  return mapa.get(k) || mapa.get(k.replace(/^sh /, "")) || mapa.get(LOCAL_PARA_LOJA[k] || "~") || null;
}
async function temLista() { const { rows } = await pool.query("SELECT 1 FROM adm_colaboradores WHERE ativo LIMIT 1"); return rows.length > 0; }
async function colaboradorDaLista(chapa, rotulo = "o colaborador") {
  const c = txt(chapa);
  const { rows } = c ? await pool.query("SELECT chapa, nome, cargo, situacao, local_trabalho, loja_id FROM adm_colaboradores WHERE chapa = $1 AND ativo", [c]) : { rows: [] };
  if (!rows[0]) throw erro(400, "Escolha " + rotulo.replace(/^o /, "o ") + " na lista: digite o nome e clique no resultado. Se ele não aparece, peça ao gestor para atualizar a planilha em Cadastros > Colaboradores.");
  return rows[0];
}
async function listarColaboradores(acc) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const { rows } = await pool.query("SELECT chapa, nome, cargo, situacao, local_trabalho AS local, loja_id::int AS loja_id FROM adm_colaboradores WHERE ativo ORDER BY nome");
  return { colaboradores: rows, total: rows.length };
}
async function resumoColaboradores(acc, f = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const { rows: n } = await pool.query("SELECT count(*) FILTER (WHERE ativo)::int AS ativos, count(*) FILTER (WHERE NOT ativo)::int AS inativos, count(*) FILTER (WHERE ativo AND loja_id IS NOT NULL)::int AS com_loja FROM adm_colaboradores");
  const { rows: m } = await pool.query("SELECT valor FROM adm_config WHERE chave = 'colab_importacao'");
  let ultima = null; try { ultima = m[0] ? JSON.parse(m[0].valor) : null; } catch (e) { /* ignora */ }
  const q = semAc(f.q); let amostra = [];
  const { rows: todos } = await pool.query("SELECT chapa, nome, cargo, situacao, local_trabalho AS local, ativo FROM adm_colaboradores ORDER BY nome");
  amostra = (q ? todos.filter((x) => semAc(x.nome + " " + x.chapa + " " + (x.cargo || "") + " " + (x.local || "")).includes(q)) : todos).slice(0, 40);
  return { ...n[0], ultima, amostra };
}
const SITUACOES_IMPORT = 20;
// rows: [{chapa, nome, cargo, situacao, centro_custo, local, cnpj}]. Sem confirmar, só mostra o que vai acontecer.
async function importarColaboradores(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const linhas = Array.isArray(b.rows) ? b.rows : [];
  if (!linhas.length) throw erro(400, "A planilha veio vazia.");
  if (linhas.length > 20000) throw erro(413, "Planilha grande demais (máximo 20.000 linhas).");
  const ok = new Map(), ignoradas = [];
  linhas.forEach((r, i) => {
    const chapa = txt(r.chapa).slice(0, 30), nome = txt(r.nome).replace(/\s+/g, " ").slice(0, 150);
    if (!nome) { ignoradas.push({ linha: i + 2, motivo: "Sem nome." }); return; }
    if (!chapa) { ignoradas.push({ linha: i + 2, motivo: "Sem chapa (" + nome + ")." }); return; }
    if (ok.has(chapa)) ignoradas.push({ linha: i + 2, motivo: "Chapa repetida " + chapa + " (vale a última linha)." });
    ok.set(chapa, { chapa, nome, cargo: txt(r.cargo).slice(0, 120) || null, situacao: txt(r.situacao).slice(0, 5) || null, centro_custo: txt(r.centro_custo).slice(0, 80) || null, local_trabalho: txt(r.local).slice(0, 120) || null, cnpj: txt(r.cnpj).slice(0, 25) || null });
  });
  if (!ok.size) throw erro(422, "Nenhuma linha válida (cada linha precisa de chapa e nome).", { ignoradas: ignoradas.slice(0, 20) });
  const { rows: atuais } = await pool.query("SELECT chapa, nome, cargo, situacao, centro_custo, local_trabalho, cnpj, ativo FROM adm_colaboradores");
  const mapaAtual = new Map(atuais.map((x) => [x.chapa, x]));
  let novos = 0, mudaram = 0, iguais = 0, reativados = 0; const exemplosNovos = [], exemplosMudaram = [];
  for (const c of ok.values()) {
    const a = mapaAtual.get(c.chapa);
    if (!a) { novos++; if (exemplosNovos.length < 8) exemplosNovos.push(c.nome + " · " + (c.cargo || "sem cargo")); continue; }
    const igual = a.nome === c.nome && (a.cargo || null) === c.cargo && (a.situacao || null) === c.situacao && (a.local_trabalho || null) === c.local_trabalho && (a.centro_custo || null) === c.centro_custo && (a.cnpj || null) === c.cnpj;
    if (!a.ativo) reativados++;
    if (igual && a.ativo) iguais++; else if (a.ativo) { mudaram++; if (exemplosMudaram.length < 8) exemplosMudaram.push(a.nome + (a.nome !== c.nome ? " → " + c.nome : "") + (a.cargo !== c.cargo ? " · cargo: " + (a.cargo || "—") + " → " + (c.cargo || "—") : "") + (a.local_trabalho !== c.local_trabalho ? " · local: " + (a.local_trabalho || "—") + " → " + (c.local_trabalho || "—") : "")); }
  }
  const saem = atuais.filter((x) => x.ativo && !ok.has(x.chapa));
  const ativosAntes = atuais.filter((x) => x.ativo).length;
  const reducaoGrande = ativosAntes >= 30 && saem.length > Math.max(20, ativosAntes * 0.3);
  const resumo = { total_planilha: ok.size, novos, atualizados: mudaram, sem_mudanca: iguais, reativados, saem: saem.length, ignoradas: ignoradas.length, detalhe_ignoradas: ignoradas.slice(0, SITUACOES_IMPORT), exemplos_novos: exemplosNovos, exemplos_atualizados: exemplosMudaram, exemplos_saem: saem.slice(0, 8).map((x) => x.nome), reducao_grande: reducaoGrande, ativos_antes: ativosAntes };
  if (!b.confirmar) return { ok: true, previa: true, ...resumo };
  if (reducaoGrande && !b.aceitar_reducao) throw erro(409, "A planilha tira " + saem.length + " das " + ativosAntes + " pessoas da lista atual. Confira se é o arquivo certo; se for, confirme de novo aceitando a redução.", { ...resumo });
  const mapaLojas = await lojasPorNome();
  await comTransacao(async (c) => {
    const lista = [...ok.values()];
    for (let i = 0; i < lista.length; i += 500) {
      const parte = lista.slice(i, i + 500), col = (k) => parte.map((x) => x[k]);
      const lojas = parte.map((x) => lojaDoLocal(mapaLojas, x.local_trabalho));
      await c.query(`INSERT INTO adm_colaboradores (chapa, nome, cargo, situacao, centro_custo, local_trabalho, cnpj, loja_id, ativo, atualizado_em)
        SELECT chapa, nome, cargo, situacao, centro_custo, local_trabalho, cnpj, loja_id, true, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[]) AS u(chapa, nome, cargo, situacao, centro_custo, local_trabalho, cnpj, loja_id)
        ON CONFLICT (chapa) DO UPDATE SET nome = EXCLUDED.nome, cargo = EXCLUDED.cargo, situacao = EXCLUDED.situacao, centro_custo = EXCLUDED.centro_custo, local_trabalho = EXCLUDED.local_trabalho, cnpj = EXCLUDED.cnpj, loja_id = EXCLUDED.loja_id, ativo = true, atualizado_em = now()`,
        [col("chapa"), col("nome"), col("cargo"), col("situacao"), col("centro_custo"), col("local_trabalho"), col("cnpj"), lojas]);
    }
    // quem não está mais na planilha sai dos seletores (o histórico dos processos continua com o nome gravado)
    await c.query("UPDATE adm_colaboradores SET ativo = false, atualizado_em = now() WHERE ativo AND NOT (chapa = ANY($1::text[]))", [[...ok.keys()]]);
    await c.query("INSERT INTO adm_config (chave, valor) VALUES ('colab_importacao', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [JSON.stringify({ em: new Date().toISOString(), por: p.email, arquivo: txt(b.arquivo).slice(0, 120) || null, total: ok.size, novos, atualizados: mudaram, saem: saem.length })]);
  });
  audit(acc, "adm_colaboradores_importados", { papel: p.papel, alvo: txt(b.arquivo).slice(0, 80) || "planilha", detalhe: `${ok.size} pessoas · ${novos} novas · ${mudaram} atualizadas · ${saem.length} saíram` });
  return { ok: true, previa: false, ...resumo };
}

// ---------- lojas x GO (planilha) ----------
// A GO de cada loja fica na coluna "regional" do cadastro de lojas. A planilha traz o nome da loja e o nome da GO.
function lojaDoNomeFlex(mapa, nome) {
  let k = semAc(nome); if (!k) return null;
  const tenta = (x) => mapa.get(x) || mapa.get(x.replace(/^sh /, "")) || mapa.get(LOCAL_PARA_LOJA[x] || "~") || null;
  return tenta(k) || tenta(k.replace(/^zinzane /, "")) || null;
}
const nomeProprio = (g) => g.toLowerCase().replace(/(^|[\s-])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase());
async function resumoLojasGo(acc) {
  const p = await papelDe(acc); exigirGestor(p);
  const { rows } = await pool.query("SELECT id::int AS id, nome, coalesce(trim(regional), '') AS go, ativa FROM ch_lojas ORDER BY nome");
  const grupos = await gruposDisponiveis();
  const { rows: m } = await pool.query("SELECT valor FROM adm_config WHERE chave = 'lojas_go_importacao'");
  let ultima = null; try { ultima = m[0] ? JSON.parse(m[0].valor) : null; } catch (e) { /* ignora */ }
  const { rows: eq } = await pool.query("SELECT nome, email, grupos FROM adm_equipe WHERE papel = 'go' AND ativo");
  const nomesGrupos = new Set(grupos.map((g) => g.nome.toLowerCase()));
  return { grupos, sem_go: rows.filter((x) => x.ativa && !x.go).map((x) => x.nome), total_lojas: rows.filter((x) => x.ativa).length, ultima,
    go_sem_loja: eq.filter((g) => !(g.grupos || []).some((n) => nomesGrupos.has(String(n).toLowerCase()))).map((g) => g.nome || g.email) };
}
// rows: [{loja, go}]. Sem confirmar, só mostra o que vai acontecer.
async function importarLojasGo(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const linhas = Array.isArray(b.rows) ? b.rows : [];
  if (!linhas.length) throw erro(400, "A planilha veio vazia.");
  if (linhas.length > 2000) throw erro(413, "Planilha grande demais (máximo 2.000 linhas).");
  const { rows: lojas } = await pool.query("SELECT id::int AS id, nome, coalesce(trim(regional), '') AS go, ativa FROM ch_lojas");
  const mapa = new Map(); lojas.forEach((l) => { mapa.set(semAc(l.nome), l.id); mapa.set(semAc(l.nome).replace(/^sh /, ""), l.id); });
  const porId = new Map(lojas.map((l) => [l.id, l]));
  const grafia = new Map(); // grafia já usada no cadastro para cada GO
  lojas.forEach((l) => { if (l.go && !grafia.has(l.go.toLowerCase())) grafia.set(l.go.toLowerCase(), l.go); });
  const decididas = new Map(), nao_achadas = [], sem_go = [], conflitos = [];
  linhas.forEach((r, i) => {
    const nome = txt(r.loja).slice(0, 150), go0 = txt(r.go).replace(/\s+/g, " ").slice(0, 60);
    if (!nome && !go0) return;
    if (!nome) return;
    if (!go0) { sem_go.push(nome); return; }
    const id = lojaDoNomeFlex(mapa, nome);
    if (!id) { nao_achadas.push({ linha: i + 2, loja: nome, go: go0 }); return; }
    const go = grafia.get(go0.toLowerCase()) || nomeProprio(go0);
    if (decididas.has(id) && decididas.get(id).go.toLowerCase() !== go.toLowerCase()) conflitos.push(nome + ": " + decididas.get(id).go + " e " + go);
    decididas.set(id, { go, nome: porId.get(id).nome });
  });
  if (!decididas.size) throw erro(422, "Nenhuma loja da planilha foi encontrada no cadastro de lojas.", { nao_achadas: nao_achadas.slice(0, 20) });
  let novas = 0, trocam = 0, iguais = 0; const exTroca = [], exNovas = [];
  for (const [id, d] of decididas) {
    const a = porId.get(id).go;
    if (!a) { novas++; if (exNovas.length < 8) exNovas.push(d.nome + " → " + d.go); }
    else if (a.toLowerCase() === d.go.toLowerCase() && a === d.go) iguais++;
    else if (a.toLowerCase() === d.go.toLowerCase()) iguais++;
    else { trocam++; if (exTroca.length < 12) exTroca.push(d.nome + ": " + a + " → " + d.go); }
  }
  const fora = lojas.filter((l) => l.ativa && !decididas.has(l.id));
  const resumo = { total_planilha: decididas.size, novas_atribuicoes: novas, trocam_de_go: trocam, sem_mudanca: iguais, nao_achadas: nao_achadas.length, detalhe_nao_achadas: nao_achadas.slice(0, 30), sem_go_na_planilha: sem_go.length, fora_da_planilha: fora.length, exemplos_fora: fora.slice(0, 10).map((l) => l.nome + (l.go ? " (" + l.go + ")" : " (sem GO)")), exemplos_novas: exNovas, exemplos_troca: exTroca, conflitos: conflitos.slice(0, 10) };
  if (!b.confirmar) return { ok: true, previa: true, ...resumo };
  if (conflitos.length) throw erro(409, "A planilha traz a mesma loja com GOs diferentes (" + conflitos.slice(0, 3).join("; ") + "). Corrija a planilha e envie de novo.", { ...resumo });
  await comTransacao(async (c) => {
    const ids = [...decididas.keys()], gos = ids.map((id) => decididas.get(id).go);
    await c.query("UPDATE ch_lojas l SET regional = u.go FROM unnest($1::bigint[], $2::text[]) AS u(id, go) WHERE l.id = u.id AND coalesce(l.regional, '') <> u.go", [ids, gos]);
    await c.query("INSERT INTO adm_config (chave, valor) VALUES ('lojas_go_importacao', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [JSON.stringify({ em: new Date().toISOString(), por: p.email, arquivo: txt(b.arquivo).slice(0, 120) || null, total: decididas.size, novas, trocam })]);
  });
  audit(acc, "adm_lojas_go_importadas", { papel: p.papel, alvo: txt(b.arquivo).slice(0, 80) || "planilha", detalhe: `${decididas.size} lojas · ${novas} novas atribuições · ${trocam} trocas de GO` });
  return { ok: true, previa: false, ...resumo };
}

// ====================================================================================
// VISÕES RESTRITAS: o que a GO vê das rescisões; custo e anexos (só RH e Diretoria)
// ====================================================================================
// A GO aprova o desligamento, mas não enxerga o cálculo nem a aprovação da Diretoria (esses passos aparecem como "em análise pelo RH").
function mascararParaGo(x) {
  if (!x || x.tipo !== "rescisao" || !Array.isArray(x.etapas)) return x;
  const etapas = x.etapas.filter((e) => !ACOES_DIRETORIA.includes(e.acao));
  let ea = x.etapa_atual;
  if (ea && ACOES_DIRETORIA.includes(ea.acao)) ea = { ...ea, nome: "Em análise pelo RH", area: "RH", acao: "normal", externo: false };
  return { ...x, etapas, etapa_atual: ea, progresso: { feitas: etapas.filter((e) => e.status !== "pendente").length, total: etapas.length } };
}
async function calculoDo(id) {
  const { rows } = await pool.query("SELECT custo_rescisao, custo_por, custo_em FROM adm_processos WHERE id = $1", [id]);
  const { rows: an } = await pool.query("SELECT id::int AS id, nome, mime, tamanho, criado_por, criado_em FROM adm_proc_anexos WHERE processo_id = $1 AND tipo = 'calculo' ORDER BY id", [id]);
  return { custo: rows[0] && rows[0].custo_rescisao !== null ? Number(rows[0].custo_rescisao) : null, por: rows[0] ? rows[0].custo_por : null, em: rows[0] ? rows[0].custo_em : null, anexos: an };
}
const MIMES_ANEXO = {
  "application/pdf": (b) => b.slice(0, 4).toString() === "%PDF",
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b.slice(1, 4).toString() === "PNG",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (b) => b.slice(0, 2).toString() === "PK",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (b) => b.slice(0, 2).toString() === "PK",
  "application/vnd.ms-excel": (b) => b[0] === 0xd0 && b[1] === 0xcf,
};
const MAX_ANEXO = 8 * 1024 * 1024, MAX_ANEXOS_PROC = 3;
function numeroBR(v) {
  if (typeof v === "number") return v;
  let t = txt(v).replace(/[R$\s]/g, "");
  if (!t) return NaN;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); // 1.234,56
  return Number(t);
}
// RH informa o custo da rescisão (e, se quiser, anexa o cálculo). Só enquanto a etapa de cálculo é a atual.
async function registrarCalculo(acc, id, b = {}) {
  const p = await papelDe(acc); if (!ehRH(p)) exigirNaoGo(p);
  const custo = b.custo === undefined || b.custo === "" ? null : numeroBR(b.custo);
  if (custo !== null && (!(custo >= 0) || custo > 99999999.99)) throw erro(400, "Informe o custo da rescisão em reais (ex.: 12.345,67).");
  const arq = b.arquivo && typeof b.arquivo === "object" ? b.arquivo : null;
  let buf = null, mime = "", nome = "";
  if (arq) {
    mime = txt(arq.mime).toLowerCase();
    if (!MIMES_ANEXO[mime]) throw erro(400, "Anexe o cálculo em PDF, Excel, Word, JPG ou PNG.");
    buf = Buffer.from(String(arq.base64 || ""), "base64");
    if (!buf.length) throw erro(400, "Arquivo vazio.");
    if (buf.length > MAX_ANEXO) throw erro(400, "O arquivo passa de " + MAX_ANEXO / 1024 / 1024 + " MB.");
    if (!MIMES_ANEXO[mime](buf)) throw erro(400, "O arquivo não parece ser do tipo informado.");
    nome = txt(arq.nome).replace(/[^\w.\- ()À-ÿ]/g, "_").slice(0, 120) || "calculo";
  }
  if (custo === null && !buf) throw erro(400, "Informe o custo da rescisão ou anexe o cálculo.");
  const r = await comTransacao(async (c) => {
    await c.query("SELECT id FROM adm_processos WHERE id = $1 FOR UPDATE", [id]);
    const { raw, etapas } = await carregarUm(id, c);
    if (raw.tipo !== "rescisao") throw erro(400, "O custo da rescisão só existe em rescisões.");
    if (!ABERTOS.includes(raw.status)) throw erro(409, "Processo encerrado.");
    const atual = etapas.slice().sort((a, x) => a.ordem - x.ordem || a.id - x.id).find((e) => e.status === "pendente");
    if (!atual || atual.acao !== "calculo") throw erro(409, "O custo só pode ser informado na etapa de cálculo das verbas rescisórias.");
    if (custo !== null) {
      await c.query("UPDATE adm_processos SET custo_rescisao = $2, custo_por = $3, custo_em = now(), atualizado_em = now() WHERE id = $1", [id, custo, p.email]);
      await evento(c, id, "calculo_registrado", p.email, { custo });
    }
    if (buf) {
      const { rows: n } = await c.query("SELECT count(*)::int AS n FROM adm_proc_anexos WHERE processo_id = $1 AND tipo = 'calculo'", [id]);
      if (n[0].n >= MAX_ANEXOS_PROC) throw erro(400, "No máximo " + MAX_ANEXOS_PROC + " anexos. Remova um para enviar outro.");
      await c.query("INSERT INTO adm_proc_anexos (processo_id, tipo, nome, mime, tamanho, dados, criado_por) VALUES ($1,'calculo',$2,$3,$4,$5,$6)", [id, nome, mime, buf.length, buf, p.email]);
      await evento(c, id, "anexo_calculo", p.email, { nome });
    }
    return raw.protocolo;
  });
  audit(acc, "adm_calculo_registrado", { papel: p.papel, alvo: r, detalhe: custo !== null ? "custo informado" : "anexo" });
  return { ok: true };
}
async function visivelParaDiretoria(c, p, id) {
  if (p.papel !== "diretoria") return;
  const { raw, etapas } = await carregarUm(id, c);
  const ord = etapas.slice().sort((a, x) => a.ordem - x.ordem || a.id - x.id);
  const pend = ord.find((e) => e.status === "pendente");
  if (!(raw.tipo === "rescisao" && ord.some((e) => e.acao === "diretoria" && (e.status !== "pendente" || e === pend)))) throw erro(403, "Você vê a rescisão quando ela chega na aprovação da Diretoria.");
}
async function anexoRH(acc, id, aid) {
  const p = await papelDe(acc); if (!ehRH(p) && p.papel !== "diretoria") exigirNaoGo(p);
  await visivelParaDiretoria(pool, p, id);
  const { rows } = await pool.query("SELECT a.nome, a.mime, a.dados, p.protocolo FROM adm_proc_anexos a JOIN adm_processos p ON p.id = a.processo_id WHERE a.id = $1 AND a.processo_id = $2", [aid, id]);
  if (!rows[0]) throw erro(404, "Arquivo não encontrado.");
  audit(acc, "adm_ver_anexo", { papel: p.papel, alvo: rows[0].protocolo, detalhe: rows[0].nome });
  return { nome: rows[0].nome, mime: rows[0].mime, base64: rows[0].dados.toString("base64") };
}
async function removerAnexo(acc, id, aid) {
  const p = await papelDe(acc); if (!ehRH(p)) exigirNaoGo(p);
  const { raw, etapas } = await carregarUm(id);
  const atual = etapas.slice().sort((a, x) => a.ordem - x.ordem || a.id - x.id).find((e) => e.status === "pendente");
  if (!ABERTOS.includes(raw.status) || !atual || atual.acao !== "calculo") throw erro(409, "O anexo só pode ser removido na etapa de cálculo.");
  const { rows } = await pool.query("DELETE FROM adm_proc_anexos WHERE id = $1 AND processo_id = $2 RETURNING nome", [aid, id]);
  if (!rows[0]) throw erro(404, "Arquivo não encontrado.");
  await evento(pool, id, "anexo_removido", p.email, { nome: rows[0].nome });
  return { ok: true };
}

// ====================================================================================
// LINK DE ADMISSÃO (colado pelo RH) e LINK DA LOJA (o gerente abre a vaga)
// ====================================================================================
async function salvarLinkAdmissao(acc, id, b = {}) {
  const p = await papelDe(acc); exigirNaoGo(p);
  const link = txt(b.link).slice(0, 500);
  if (link && !/^https?:\/\/[^\s]+$/i.test(link)) throw erro(400, "Cole o link completo, começando com http:// ou https://.");
  const { raw } = await carregarUm(id);
  if (raw.tipo !== "admissao") throw erro(400, "Só admissões têm link de admissão.");
  if (!ABERTOS.includes(raw.status)) throw erro(409, "Processo encerrado.");
  await pool.query("UPDATE adm_processos SET link_admissao = $2, atualizado_em = now() WHERE id = $1", [id, link || null]);
  await evento(pool, id, "link_admissao", p.email, { definido: !!link });
  audit(acc, "adm_link_admissao", { papel: p.papel, alvo: raw.protocolo, detalhe: link ? "link informado" : "link removido" });
  return { ok: true };
}
async function respPadrao() {
  const { rows: c } = await pool.query("SELECT valor FROM adm_config WHERE chave = 'resp_padrao_vagas'");
  if (c[0]) { const { rows: ok } = await pool.query("SELECT 1 FROM adm_equipe WHERE lower(email) = $1 AND ativo AND papel IN ('gestor','analista') UNION SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [em(c[0].valor)]); if (ok[0]) return em(c[0].valor); }
  const { rows } = await pool.query("SELECT email FROM adm_equipe WHERE ativo AND papel IN ('gestor','analista') ORDER BY (papel = 'gestor') DESC, id LIMIT 1");
  if (rows[0]) return em(rows[0].email);
  const { rows: a } = await pool.query("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (a[0]) return em(a[0].email);
  throw erro(503, "O RH ainda não está configurado para receber vagas. Avise o gestor.");
}
async function linksVaga(acc) {
  const p = await papelDe(acc); if (!ehRH(p)) exigirNaoGo(p);
  const { rows: sem } = await pool.query("SELECT l.id FROM ch_lojas l WHERE l.ativa AND NOT EXISTS (SELECT 1 FROM adm_loja_links k WHERE k.loja_id = l.id)");
  for (const l of sem) await pool.query("INSERT INTO adm_loja_links (loja_id, token, criado_por) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [l.id, crypto.randomBytes(24).toString("hex"), p.email]);
  const { rows } = await pool.query("SELECT l.id::int AS loja_id, l.nome AS loja, coalesce(trim(l.regional), '') AS go, k.token FROM ch_lojas l JOIN adm_loja_links k ON k.loja_id = l.id WHERE l.ativa ORDER BY l.nome");
  return { links: rows, responsavel_padrao: await respPadrao().catch(() => null), responsaveis: await responsaveis() };
}
async function renovarLinkVaga(acc, lojaId) {
  const p = await papelDe(acc); exigirGestor(p);
  const { rows: l } = await pool.query("SELECT nome FROM ch_lojas WHERE id = $1", [Number(lojaId) || 0]);
  if (!l[0]) throw erro(404, "Loja não encontrada.");
  const token = crypto.randomBytes(24).toString("hex");
  await pool.query("INSERT INTO adm_loja_links (loja_id, token, criado_por) VALUES ($1,$2,$3) ON CONFLICT (loja_id) DO UPDATE SET token = EXCLUDED.token, criado_por = EXCLUDED.criado_por, criado_em = now()", [Number(lojaId), token, p.email]);
  audit(acc, "adm_link_vaga_renovado", { papel: p.papel, alvo: l[0].nome });
  return { ok: true, token };
}
async function definirRespPadrao(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.responsavel);
  const { rows: ok } = await pool.query("SELECT 1 FROM adm_equipe WHERE lower(email) = $1 AND ativo AND papel IN ('gestor','analista') UNION SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [email]);
  if (!ok[0]) throw erro(400, "Escolha alguém da equipe do RH.");
  await pool.query("INSERT INTO adm_config (chave, valor) VALUES ('resp_padrao_vagas', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [email]);
  audit(acc, "adm_resp_padrao_vagas", { papel: p.papel, alvo: email });
  return { ok: true };
}
// parte pública: o gerente abre pelo link da loja
const aberturasPorIp = new Map();
function freioAbertura(ip) {
  const agora = Date.now(), k = ip || "", x = aberturasPorIp.get(k) || { n: 0, desde: agora };
  if (agora - x.desde > 3600000) { x.n = 0; x.desde = agora; }
  aberturasPorIp.set(k, x);
  if (x.n >= 15) throw erro(429, "Muitas vagas abertas por aqui em pouco tempo. Tente de novo em uma hora ou fale com o RH.");
  return x;
}
setInterval(() => { const agora = Date.now(); for (const [k, x] of aberturasPorIp) if (agora - x.desde > 7200000) aberturasPorIp.delete(k); }, 30 * 60000).unref();
async function lojaDoLinkVaga(token, ip) {
  const espera = freioLink(ip);
  if (espera) throw seguranca.erroBloqueio(espera);
  token = txt(token);
  const invalido = () => { falhaLink(ip); return erro(404, "Este link não existe ou foi desativado. Peça o link atualizado ao RH."); };
  if (!/^[a-f0-9]{48}$/.test(token)) throw invalido();
  const { rows } = await pool.query("SELECT l.id::int AS id, l.nome FROM adm_loja_links k JOIN ch_lojas l ON l.id = k.loja_id WHERE k.token = $1 AND l.ativa", [token]);
  if (!rows[0]) throw invalido();
  return rows[0];
}
async function publicoVagaVer(token, ip) {
  const l = await lojaDoLinkVaga(token, ip);
  return { loja: l.nome, subtipos: SUBTIPOS.admissao };
}
async function publicoVagaAbrir(token, ip, b = {}) {
  const l = await lojaDoLinkVaga(token, ip);
  const gerente = txt(b.gerente).replace(/\s+/g, " ").slice(0, 120), cargo = txt(b.cargo).replace(/\s+/g, " ").slice(0, 100);
  if (gerente.length < 3) throw erro(400, "Informe o seu nome (gerente que está abrindo a vaga).");
  if (cargo.length < 2) throw erro(400, "Informe o cargo da vaga.");
  const subtipo = txt(b.subtipo).slice(0, 80);
  if (subtipo && !SUBTIPOS.admissao.includes(subtipo)) throw erro(400, "Escolha o tipo de contrato na lista.");
  const dataPrev = txt(b.data_prevista);
  if (dataPrev && !dataOk(dataPrev)) throw erro(400, "Data de início inválida.");
  // clique duplo ou volta à página: reaproveita a vaga que o mesmo gerente acabou de abrir e ainda não enviou
  const { rows: dup } = await pool.query(`SELECT p.protocolo, f.token FROM adm_processos p JOIN adm_formularios f ON f.processo_id = p.id AND f.tipo = 'pre'
    WHERE p.loja_id = $1 AND p.tipo = 'admissao' AND p.status = 'em_andamento' AND lower(coalesce(p.cargo, '')) = lower($2) AND lower(coalesce(p.solicitante, '')) = lower($3)
      AND f.status IN ('rascunho','devolvido') AND p.criado_em > now() - interval '12 hours' AND p.criado_por LIKE 'Link da loja%' ORDER BY p.id DESC LIMIT 1`, [l.id, cargo, gerente]);
  if (dup[0]) return { ok: true, form_token: dup[0].token, protocolo: dup[0].protocolo, reaproveitada: true };
  const freio = freioAbertura(ip);
  const resp = await respPadrao();
  const info = await inserirProcesso({ tipo: "admissao", colaborador: "", cpf: null, cargo, lojaId: l.id, unidade: l.nome, subtipo, dataPrev: dataPrev || null, observacao: null, resp, criadoPor: ("Link da loja: " + gerente).slice(0, 120), solicitante: gerente, colabChapa: null, solChapa: null, via: "link_da_loja" });
  freio.n++;
  audit({ email: "link da loja", ip }, "adm_vaga_aberta_pelo_gerente", { papel: "publico", alvo: info.protocolo, detalhe: l.nome + " · " + cargo });
  return { ok: true, form_token: info.formToken, protocolo: info.protocolo };
}

module.exports = { registrarCalculo, anexoRH, removerAnexo, salvarLinkAdmissao, linksVaga, renovarLinkVaga, definirRespPadrao, publicoVagaVer, publicoVagaAbrir, resumoLojasGo, importarLojasGo, listarColaboradores, resumoColaboradores, importarColaboradores, eu, criar, listar, detalhe, editar, concluirEtapa, dispensarEtapa, reabrirEtapa, reprovarVaga, devolverEtapa, marcarSubtarefa, encerrar, mensagens, salvarMensagem, pausar, retomar, atribuir, nota, cancelar, excluir, ajustarPrazos,
  listarEtapasModelo, salvarEtapaModelo, salvarConfig, formulario, revisarItem, arquivoRH, formulariosModelo, salvarFormularioModelo, publicoVer, publicoSalvar, publicoArquivo, publicoRemoverArquivo, publicoEnviar, listarEquipe, criarEquipe, editarEquipe, redefinirSenha, indicadores,
  _t: { usado, monta, cpfValido, prazoData } };
