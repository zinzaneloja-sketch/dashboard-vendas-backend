// Chamados das lojas para o DP: assuntos pré-definidos, conversa chamado a chamado, cópia por e-mail e SLA em horas úteis.
// Papéis: loja (abre e acompanha os da própria loja), dp (atende), gestor (atende, configura assuntos/lojas/equipe e vê tudo).
// O administrador do sistema (role = admin) é gestor.
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { minutosUteis, diaLocal, expediente } = require("../cd/tempo");
const mail = require("./email");
const auditoria = require("../auditoria");
const seguranca = require("../seguranca");
const audit = (acc, acao, o = {}) => auditoria.registrar({ usuario: acc && acc.email, papel: acc && (acc.role === "admin" ? "admin" : acc.papel), acao, ip: acc && acc.ip, ...o });

function erro(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e; }
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const em = (v) => txt(v).toLowerCase();
const REABRE_DIAS = 7;
// Cancelar chamado é exclusivo do usuário master e exige a senha dele (a mesma do login) a cada cancelamento.
const emailMaster = () => em(process.env.CHAMADOS_MASTER_EMAIL || "tbarone@zinzane.com.br");
const ehMaster = (acc) => !!acc && em(acc.email) === emailMaster();
const ABERTOS = ["aberto", "em_atendimento", "aguardando_loja"];
const PAUSADOS = ["aguardando_loja", "resolvido"]; // o relógio de resolução não corre enquanto a bola está com a loja
const STATUS = ["aberto", "em_atendimento", "aguardando_loja", "resolvido", "cancelado"];
const MAX_ANEXOS = 3, MAX_BYTES = 2 * 1024 * 1024;
const EXT_OK = /\.(pdf|png|jpe?g|webp|gif|heic|docx?|xlsx?|csv|txt|zip)$/i;

async function comTransacao(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

// ---------- quem é a pessoa ----------
async function papelDe(acc) {
  if (acc.role === "admin") return { papel: "gestor", nome: acc.nome || acc.email, email: em(acc.email) };
  const { rows: eq } = await pool.query("SELECT id, nome, papel FROM ch_equipe WHERE lower(email) = $1 AND ativo", [em(acc.email)]);
  if (eq[0]) return { papel: eq[0].papel === "gestor" ? "gestor" : "dp", nome: eq[0].nome || acc.nome || acc.email, email: em(acc.email) };
  const { rows: lj } = await pool.query("SELECT id, nome, codigo, email, emails_copia, ativa FROM ch_lojas WHERE lower(email) = $1", [em(acc.email)]);
  if (lj[0]) {
    if (!lj[0].ativa) throw erro(403, "Essa loja está desativada nos chamados. Fale com o DP.");
    return { papel: "loja", nome: lj[0].nome, email: em(acc.email), loja: lj[0] };
  }
  throw erro(403, "Seu usuário não está cadastrado como loja nem como equipe do DP. Peça ao gestor do DP para cadastrar.");
}
const ehDp = (p) => p.papel === "dp" || p.papel === "gestor";
function exigirDp(p) { if (!ehDp(p)) throw erro(403, "Só a equipe do DP pode fazer isso."); }
function exigirGestor(p) { if (p.papel !== "gestor") throw erro(403, "Só o gestor do DP pode fazer isso."); }

// ---------- SLA (minutos úteis; o expediente vem de tempo.js) ----------
function slaDe(ch, agora = new Date()) {
  const fimRef = ch.pausado_desde ? new Date(ch.pausado_desde) : agora;
  const pausado = ch.status === "aguardando_loja";
  const resposta = (() => {
    const meta = ch.sla_resposta_min;
    const fim = ch.primeira_resposta_em ? new Date(ch.primeira_resposta_em) : (ch.status === "cancelado" ? new Date(ch.atualizado_em) : agora);
    const dec = minutosUteis(ch.criado_em, fim);
    const feito = !!ch.primeira_resposta_em;
    let sit;
    if (ch.status === "cancelado" && !feito) sit = "cancelado";
    else if (feito) sit = dec <= meta ? "cumprido" : "descumprido";
    else sit = dec > meta ? "estourado" : dec >= meta * 0.8 ? "risco" : "ok";
    return { meta, decorrido: dec, restante: Math.round((meta - dec) * 10) / 10, feito, situacao: sit };
  })();
  const resolucao = (() => {
    const meta = ch.sla_resolucao_min;
    const dec = Math.max(0, Math.round((minutosUteis(ch.criado_em, ch.status === "cancelado" ? new Date(ch.atualizado_em) : fimRef) - Number(ch.pausa_acum_min || 0)) * 10) / 10);
    const feito = ch.status === "resolvido";
    let sit;
    if (ch.status === "cancelado") sit = "cancelado";
    else if (feito) sit = dec <= meta ? "cumprido" : "descumprido";
    else if (pausado) sit = dec > meta ? "estourado" : "pausado";
    else sit = dec > meta ? "estourado" : dec >= meta * 0.8 ? "risco" : "ok";
    return { meta, decorrido: dec, restante: Math.round((meta - dec) * 10) / 10, feito, pausado, situacao: sit };
  })();
  return { resposta, resolucao };
}
const GRAVIDADE = { estourado: 0, risco: 1, ok: 2, pausado: 3, cumprido: 4, descumprido: 4, cancelado: 5 };
// o relógio que importa agora: 1ª resposta enquanto não houve, depois a resolução
function relogioAtual(sla, ch) {
  if (ch.status === "resolvido" || ch.status === "cancelado") return null;
  return sla.resposta.feito ? { tipo: "resolucao", ...sla.resolucao } : { tipo: "resposta", ...sla.resposta };
}

const COLS = `c.id::int AS id, c.protocolo, c.loja_id::int AS loja_id, l.nome AS loja_nome, c.assunto_id::int AS assunto_id, c.assunto_nome, c.descricao, c.prioridade, c.colaborador,
  c.data_ref, c.status, c.aberto_por, c.atribuido_a, c.sla_resposta_min, c.sla_resolucao_min, c.primeira_resposta_em, c.resolvido_em, c.reaberturas, c.pausado_desde,
  c.pausa_acum_min::float AS pausa_acum_min, c.cc_emails, c.ultima_msg_autor, c.criado_em, c.atualizado_em`;
const FROM = "FROM ch_chamados c JOIN ch_lojas l ON l.id = c.loja_id";
const dstr = (v) => (v ? (v instanceof Date ? diaLocal(v) : String(v).slice(0, 10)) : null);

function formata(ch, agora) {
  const sla = slaDe(ch, agora);
  const rel = relogioAtual(sla, ch);
  return { ...ch, data_ref: dstr(ch.data_ref), sla, relogio: rel, nome_atribuido: undefined };
}

// ---------- apoio ----------
async function evento(c, chamadoId, tipo, usuario, detalhe) {
  await c.query("INSERT INTO ch_eventos (chamado_id, tipo, usuario, detalhe) VALUES ($1,$2,$3,$4)", [chamadoId, tipo, usuario || null, detalhe ? JSON.stringify(detalhe) : null]);
}
// muda o status cuidando do relógio de resolução (pausa enquanto aguarda a loja ou está resolvido)
async function mudarStatus(c, ch, novo, usuario, extra = {}) {
  const agora = new Date();
  const eraPausado = PAUSADOS.includes(ch.status), vaiPausar = PAUSADOS.includes(novo);
  const sets = ["status = $2", "atualizado_em = now()"], vals = [ch.id, novo];
  if (eraPausado && !vaiPausar && ch.pausado_desde) {
    vals.push(minutosUteis(ch.pausado_desde, agora)); sets.push(`pausa_acum_min = pausa_acum_min + $${vals.length}`, "pausado_desde = NULL");
  } else if (!eraPausado && vaiPausar) { vals.push(agora); sets.push(`pausado_desde = $${vals.length}`); }
  if (novo === "resolvido") { vals.push(agora); sets.push(`resolvido_em = $${vals.length}`); }
  if (ch.status === "resolvido" && novo !== "resolvido") sets.push("resolvido_em = NULL");
  await c.query(`UPDATE ch_chamados SET ${sets.join(", ")} WHERE id = $1`, vals);
  if (ch.status !== novo) await evento(c, ch.id, "status", usuario, { de: ch.status, para: novo, ...extra });
}
async function carregar(c, id, bloquear) {
  const { rows } = await c.query(`SELECT ${COLS}, l.email AS loja_email, l.emails_copia ${FROM} WHERE c.id = $1 ${bloquear ? "FOR UPDATE OF c" : ""}`, [id]);
  if (!rows[0]) throw erro(404, "Chamado não encontrado.");
  return rows[0];
}
function podeVer(p, ch) { if (ehDp(p)) return true; if (p.papel === "loja" && Number(p.loja.id) === Number(ch.loja_id)) return true; return false; }

function limparAnexos(lista) {
  const arr = Array.isArray(lista) ? lista : [];
  if (arr.length > MAX_ANEXOS) throw erro(400, `No máximo ${MAX_ANEXOS} anexos por mensagem.`);
  return arr.map((a) => {
    const nome = txt(a && a.nome).replace(/[\\/\0]/g, "_").slice(0, 160) || "arquivo";
    if (!EXT_OK.test(nome)) throw erro(400, `Tipo de arquivo não permitido: ${nome}. Envie PDF, imagem, Word, Excel, CSV, TXT ou ZIP.`);
    const buf = Buffer.from(String((a && a.base64) || "").replace(/^data:[^,]*,/, ""), "base64");
    if (!buf.length) throw erro(400, `Arquivo vazio: ${nome}.`);
    if (buf.length > MAX_BYTES) throw erro(413, `${nome} passa de 2 MB.`);
    return { nome, tipo: txt(a.tipo).slice(0, 100) || null, buf };
  });
}
async function salvarAnexos(c, chamadoId, mensagemId, lista, usuario) {
  for (const a of lista) await c.query("INSERT INTO ch_anexos (chamado_id, mensagem_id, nome, tipo, tamanho, conteudo, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)", [chamadoId, mensagemId, a.nome, a.tipo, a.buf.length, a.buf, usuario]);
}
const destinosLoja = (ch) => [ch.loja_email, ...(ch.emails_copia || []), ...(ch.cc_emails || [])].filter(Boolean);
function dispara(fn) { setImmediate(() => { fn().catch((e) => console.error("[chamados:email]", e.message)); }); }

// ---------- eu / cadastros ----------
async function eu(acc) {
  const p = await papelDe(acc);
  return { papel: p.papel, nome: p.nome, email: p.email, loja: p.loja ? { id: Number(p.loja.id), nome: p.loja.nome, codigo: p.loja.codigo } : null,
    expediente: { inicio_min: expediente.inicioMin, fim_min: expediente.fimMin, dias: expediente.dias }, reabertura_dias: REABRE_DIAS, email_configurado: !!(process.env.RESEND_API_KEY && process.env.CHAMADOS_EMAIL_FROM), trocar_senha: !!acc.trocar_senha, pode_cancelar: ehMaster(acc), pode_excluir: ehMaster(acc) };
}

async function listarAssuntos(acc, { todos } = {}) {
  const p = await papelDe(acc);
  const ver = todos && p.papel === "gestor";
  const { rows } = await pool.query(`SELECT id::int AS id, nome, categoria, descricao, sla_resposta_min, sla_resolucao_min, exige_colaborador, ativo, ordem FROM ch_assuntos ${ver ? "" : "WHERE ativo"} ORDER BY ordem, nome`);
  return { assuntos: rows };
}
async function salvarAssunto(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const nome = txt(b.nome).slice(0, 120);
  if (!nome) throw erro(400, "Informe o nome do assunto.");
  const r = Math.round(Number(b.sla_resposta_min)), s = Math.round(Number(b.sla_resolucao_min));
  if (!(r > 0) || !(s > 0)) throw erro(400, "Informe os prazos (em minutos úteis) maiores que zero.");
  if (s < r) throw erro(400, "O prazo de resolução não pode ser menor que o prazo da 1ª resposta.");
  const v = [nome, txt(b.categoria).slice(0, 80) || null, txt(b.descricao).slice(0, 400) || null, r, s, !!b.exige_colaborador, b.ativo === false ? false : true, Number.isFinite(Number(b.ordem)) ? Math.round(Number(b.ordem)) : 0];
  try {
    if (id) {
      const { rows } = await pool.query("UPDATE ch_assuntos SET nome=$2, categoria=$3, descricao=$4, sla_resposta_min=$5, sla_resolucao_min=$6, exige_colaborador=$7, ativo=$8, ordem=$9 WHERE id=$1 RETURNING id::int AS id", [id, ...v]);
      if (!rows[0]) throw erro(404, "Assunto não encontrado.");
      return { ok: true, id };
    }
    const { rows: mx } = await pool.query("SELECT coalesce(max(ordem),0)+1 AS o FROM ch_assuntos");
    v[7] = Number.isFinite(Number(b.ordem)) && b.ordem !== "" && b.ordem !== undefined ? v[7] : Number(mx[0].o);
    const { rows } = await pool.query("INSERT INTO ch_assuntos (nome, categoria, descricao, sla_resposta_min, sla_resolucao_min, exige_colaborador, ativo, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::int AS id", v);
    return { ok: true, id: rows[0].id };
  } catch (e) { if (e.code === "23505") throw erro(409, "Já existe um assunto com esse nome."); throw e; }
}

async function garantirAcesso(email, nome, senha) {
  const e = em(email);
  const { rows } = await pool.query("SELECT id, modules FROM users WHERE lower(email) = $1", [e]);
  if (rows[0]) {
    await pool.query("UPDATE users SET modules = (SELECT array_agg(DISTINCT x) FROM unnest(modules || ARRAY['chamados']) x), nome = COALESCE(nome, $2) WHERE id = $1", [rows[0].id, nome || null]);
    if (senha) {
      if (String(senha).length < 8) throw erro(400, "A senha precisa de pelo menos 8 caracteres.");
      // senha definida pelo gestor é provisória: a pessoa troca no próximo acesso e as sessões antigas caem
      await pool.query("UPDATE users SET password_hash = $2, trocar_senha = true, token_version = token_version + 1 WHERE id = $1", [rows[0].id, await bcrypt.hash(String(senha), 10)]);
    }
    return { criado: false };
  }
  if (!senha) throw erro(400, "Esse e-mail ainda não tem usuário no sistema: informe uma senha inicial (mínimo 8 caracteres).");
  if (String(senha).length < 8) throw erro(400, "A senha precisa de pelo menos 8 caracteres.");
  await pool.query("INSERT INTO users (email, password_hash, role, nome, modules, cd_perfis, trocar_senha) VALUES ($1,$2,'viewer',$3,ARRAY['chamados'],'{}', true)", [e, await bcrypt.hash(String(senha), 10), nome || null]);
  return { criado: true };
}
function listaEmails(v) {
  const arr = Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/);
  const out = [...new Set(arr.map(em).filter(Boolean))];
  const ruim = out.find((x) => !mail.emailValido(x));
  if (ruim) throw erro(400, `E-mail inválido: ${ruim}`);
  return out.slice(0, 5);
}

async function listarLojas(acc) {
  const p = await papelDe(acc); exigirDp(p);
  const { rows } = await pool.query(`SELECT l.id::int AS id, l.nome, l.codigo, l.email, l.emails_copia, l.ativa, l.regional, l.regiao, l.uf, l.cidade, l.endereco, l.cep,
    (SELECT count(*)::int FROM ch_chamados c WHERE c.loja_id = l.id AND c.status = ANY($1)) AS abertos,
    EXISTS (SELECT 1 FROM users u WHERE l.email IS NOT NULL AND lower(u.email) = lower(l.email)) AS tem_usuario FROM ch_lojas l ORDER BY l.nome`, [ABERTOS]);
  return { lojas: rows };
}
async function salvarLoja(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const nome = txt(b.nome).slice(0, 120), email = em(b.email) || null;
  if (!nome) throw erro(400, "Informe o nome da loja.");
  if (email && !mail.emailValido(email)) throw erro(400, "E-mail da loja inválido.");
  const cc = listaEmails(b.emails_copia);
  const dados = [txt(b.codigo).slice(0, 30) || null, txt(b.regional).slice(0, 60) || null, txt(b.regiao).slice(0, 30) || null, txt(b.uf).toUpperCase().slice(0, 2) || null, txt(b.cidade).slice(0, 80) || null, txt(b.endereco).slice(0, 200) || null, txt(b.cep).slice(0, 12) || null];
  const ativa = b.ativa === false ? false : true;
  try {
    if (id) {
      const { rows } = await pool.query("UPDATE ch_lojas SET nome=$2, email=$3, emails_copia=$4, ativa=$5, codigo=$6, regional=$7, regiao=$8, uf=$9, cidade=$10, endereco=$11, cep=$12 WHERE id=$1 RETURNING id::int AS id", [id, nome, email, cc, ativa, ...dados]);
      if (!rows[0]) throw erro(404, "Loja não encontrada.");
      const ac = email ? await garantirAcesso(email, nome, b.senha) : { criado: false };
      return { ok: true, id, acesso_criado: ac.criado };
    }
    const ac = email ? await garantirAcesso(email, nome, b.senha) : { criado: false };
    const { rows } = await pool.query("INSERT INTO ch_lojas (nome, email, emails_copia, ativa, codigo, regional, regiao, uf, cidade, endereco, cep) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::int AS id", [nome, email, cc, ativa, ...dados]);
    return { ok: true, id: rows[0].id, acesso_criado: ac.criado };
  } catch (e) { if (e.code === "23505") throw erro(409, "Já existe uma loja com esse nome ou e-mail."); throw e; }
}
// Cadastro em lote dos e-mails (e acessos) das lojas. Cada linha: "NOME DA LOJA ; email@loja.com ; senha(opcional)".
async function importarEmailsLojas(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const linhas = String(b.linhas || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 300);
  if (!linhas.length) throw erro(400, "Cole pelo menos uma linha no formato: LOJA ; e-mail ; senha.");
  const senhaPadrao = b.senha ? String(b.senha) : "";
  const { rows: lojas } = await pool.query("SELECT id, nome, email FROM ch_lojas");
  const chave = (v) => txt(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^zinzane\s*-\s*/i, "").replace(/\s+/g, " ").toLowerCase();
  const porNome = new Map(lojas.map((l) => [chave(l.nome), l]));
  const res = { atualizadas: 0, acessos_criados: 0, erros: [] };
  for (const [n, linha] of linhas.entries()) {
    const partes = linha.split(/[;\t]/).map((x) => x.trim());
    if (partes.length < 2) { res.erros.push({ linha: n + 1, texto: linha, erro: "Use: LOJA ; e-mail ; senha" }); continue; }
    if (n === 0 && /^(loja|nome)$/i.test(partes[0]) && /mail/i.test(partes[1])) continue; // cabeçalho
    const l = porNome.get(chave(partes[0]));
    const email = em(partes[1]), senha = partes[2] || senhaPadrao;
    if (!l) { res.erros.push({ linha: n + 1, texto: linha, erro: "Loja não encontrada na lista" }); continue; }
    if (!mail.emailValido(email)) { res.erros.push({ linha: n + 1, texto: linha, erro: "E-mail inválido" }); continue; }
    try {
      const { rows: dono } = await pool.query("SELECT 1 FROM ch_lojas WHERE lower(email) = $1 AND id <> $2", [email, l.id]);
      if (dono[0]) { res.erros.push({ linha: n + 1, texto: linha, erro: "E-mail já usado por outra loja" }); continue; }
      const { rows: jaTem } = await pool.query("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
      const ac = await garantirAcesso(email, l.nome, jaTem[0] ? undefined : (senha || undefined)); // nunca redefine a senha de quem já tem usuário
      await pool.query("UPDATE ch_lojas SET email = $2 WHERE id = $1", [l.id, email]);
      res.atualizadas++; if (ac.criado) res.acessos_criados++;
    } catch (e) {
      res.erros.push({ linha: n + 1, texto: linha, erro: e.code === "23505" ? "E-mail já usado por outra loja" : (e.message || "Erro") });
    }
  }
  return { ok: true, ...res };
}
async function listarEquipe(acc) {
  const p = await papelDe(acc); exigirDp(p);
  const { rows } = await pool.query("SELECT id::int AS id, email, nome, papel, ativo FROM ch_equipe ORDER BY nome NULLS LAST, email");
  return { equipe: rows };
}
async function salvarEquipe(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.email);
  if (!mail.emailValido(email)) throw erro(400, "Informe o e-mail da pessoa do DP.");
  const nome = txt(b.nome).slice(0, 100) || null, papel = b.papel === "gestor" ? "gestor" : "dp";
  try {
    if (id) {
      const { rows } = await pool.query("UPDATE ch_equipe SET email=$2, nome=$3, papel=$4, ativo=$5 WHERE id=$1 RETURNING id::int AS id", [id, email, nome, papel, b.ativo === false ? false : true]);
      if (!rows[0]) throw erro(404, "Pessoa não encontrada.");
      const ac = await garantirAcesso(email, nome, b.senha);
      return { ok: true, id, acesso_criado: ac.criado };
    }
    const ac = await garantirAcesso(email, nome, b.senha);
    const { rows } = await pool.query("INSERT INTO ch_equipe (email, nome, papel) VALUES ($1,$2,$3) RETURNING id::int AS id", [email, nome, papel]);
    return { ok: true, id: rows[0].id, acesso_criado: ac.criado };
  } catch (e) { if (e.code === "23505") throw erro(409, "Essa pessoa já está na equipe."); throw e; }
}
// ---- Acessos (logins) do módulo de chamados: tela única para o gestor criar, redefinir e bloquear ----
async function listarAcessos(acc) {
  const p = await papelDe(acc); exigirGestor(p);
  const { rows } = await pool.query(`
    SELECT u.email, u.nome, u.role, ('chamados' = ANY(u.modules) OR u.role = 'admin') AS tem_modulo,
      l.id::int AS loja_id, l.nome AS loja_nome, e.papel AS equipe_papel, e.ativo AS equipe_ativo
    FROM users u
    LEFT JOIN ch_lojas l ON lower(l.email) = lower(u.email)
    LEFT JOIN ch_equipe e ON lower(e.email) = lower(u.email)
    WHERE 'chamados' = ANY(u.modules) OR l.id IS NOT NULL OR e.id IS NOT NULL OR u.role = 'admin'
    ORDER BY u.role = 'admin' DESC, e.papel NULLS LAST, l.nome NULLS LAST, u.email`);
  const acessos = rows.map((r) => ({
    email: r.email, nome: r.nome, admin: r.role === "admin", tem_acesso: r.tem_modulo,
    perfil: r.role === "admin" ? "admin" : r.equipe_papel === "gestor" ? "gestor" : r.equipe_papel === "dp" ? "dp" : r.loja_id ? "loja" : "sem_perfil",
    loja: r.loja_nome || null, ativo: r.role === "admin" ? true : r.equipe_papel ? !!r.equipe_ativo && r.tem_modulo : r.tem_modulo,
  }));
  const { rows: sem } = await pool.query("SELECT id::int AS id, nome FROM ch_lojas WHERE email IS NULL AND ativa ORDER BY nome");
  return { acessos, lojas_sem_acesso: sem };
}
// Cria (ou reativa) o login de uma pessoa nos chamados. perfil: 'loja' | 'dp' | 'gestor'.
async function criarAcesso(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.email), nome = txt(b.nome).slice(0, 100) || null, perfil = txt(b.perfil);
  if (!mail.emailValido(email)) throw erro(400, "Informe um e-mail válido.");
  if (!["loja", "dp", "gestor"].includes(perfil)) throw erro(400, "Escolha o perfil: loja, atendente do DP ou gestor.");
  const senha = b.senha ? String(b.senha) : "";
  if (perfil === "loja") {
    const { rows: lj } = await pool.query("SELECT id, nome, email FROM ch_lojas WHERE id = $1 OR ($1 = 0 AND lower(email) = $2)", [Number(b.loja_id) || 0, email]);
    if (!lj[0]) throw erro(400, "Escolha a loja desse acesso.");
    if (lj[0].email && em(lj[0].email) !== email) throw erro(409, `A loja ${lj[0].nome} já usa o login ${lj[0].email}. Para trocar, edite a loja em Cadastros > Lojas.`);
    const { rows: outro } = await pool.query("SELECT nome FROM ch_lojas WHERE lower(email) = $1 AND id <> $2", [email, lj[0].id]);
    if (outro[0]) throw erro(409, `Esse e-mail já é o login da loja ${outro[0].nome}.`);
    const { rows: eqp } = await pool.query("SELECT 1 FROM ch_equipe WHERE lower(email) = $1", [email]);
    if (eqp[0]) throw erro(409, "Esse e-mail já é da equipe do DP.");
    const ac = await garantirAcesso(email, nome || lj[0].nome, senha || undefined);
    await pool.query("UPDATE ch_lojas SET email = $2 WHERE id = $1", [lj[0].id, email]);
    audit(acc, ac.criado ? "acesso_criado" : "acesso_liberado", { papel: p.papel, alvo: email, detalhe: "loja " + lj[0].nome });
    return { ok: true, acesso_criado: ac.criado, perfil, loja: lj[0].nome };
  }
  const { rows: dona } = await pool.query("SELECT nome FROM ch_lojas WHERE lower(email) = $1", [email]);
  if (dona[0]) throw erro(409, `Esse e-mail é o login da loja ${dona[0].nome}.`);
  const ac = await garantirAcesso(email, nome, senha || undefined);
  await pool.query(`INSERT INTO ch_equipe (email, nome, papel, ativo) VALUES ($1,$2,$3,true)
    ON CONFLICT (lower(email)) DO UPDATE SET papel = EXCLUDED.papel, ativo = true, nome = COALESCE(EXCLUDED.nome, ch_equipe.nome)`, [email, nome, perfil === "gestor" ? "gestor" : "dp"]);
  audit(acc, ac.criado ? "acesso_criado" : "acesso_liberado", { papel: p.papel, alvo: email, detalhe: perfil === "gestor" ? "gestor do DP" : "atendente do DP" });
  return { ok: true, acesso_criado: ac.criado, perfil };
}
async function redefinirSenhaAcesso(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.email), senha = String(b.senha || "");
  if (senha.length < 8) throw erro(400, "A senha precisa de pelo menos 8 caracteres.");
  const { rows } = await pool.query("SELECT id, role, modules FROM users WHERE lower(email) = $1", [email]);
  if (!rows[0]) throw erro(404, "Usuário não encontrado.");
  if (rows[0].role === "admin" && em(acc.email) !== email) throw erro(403, "A senha de um administrador só ele mesmo redefine.");
  if (!(rows[0].modules || []).includes("chamados") && rows[0].role !== "admin") throw erro(403, "Esse usuário não tem acesso aos chamados.");
  const propria = em(acc.email) === email; // a própria pessoa redefinindo a sua não precisa trocar de novo
  await pool.query("UPDATE users SET password_hash = $2, trocar_senha = $3, token_version = token_version + 1, senha_alterada_em = now() WHERE id = $1", [rows[0].id, await bcrypt.hash(senha, 10), !propria]);
  audit(acc, "senha_redefinida", { papel: p.papel, alvo: email });
  return { ok: true, trocar_senha: !propria };
}
// Bloqueia o acesso aos chamados (não apaga o usuário nem o histórico; criar o acesso de novo reativa).
async function removerAcesso(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const email = em(b.email);
  if (email === em(acc.email)) throw erro(400, "Você não pode bloquear o seu próprio acesso.");
  const { rows } = await pool.query("SELECT id, role FROM users WHERE lower(email) = $1", [email]);
  if (!rows[0]) throw erro(404, "Usuário não encontrado.");
  if (rows[0].role === "admin") throw erro(403, "Administradores têm acesso a tudo; não dá para bloqueá-los por aqui.");
  await pool.query("UPDATE users SET modules = array_remove(modules, 'chamados'), token_version = token_version + 1 WHERE id = $1", [rows[0].id]);
  await pool.query("UPDATE ch_equipe SET ativo = false WHERE lower(email) = $1", [email]);
  audit(acc, "acesso_bloqueado", { papel: p.papel, alvo: email });
  return { ok: true };
}
async function config(acc) {
  const p = await papelDe(acc); exigirDp(p);
  const dp = await mail.destinosDp();
  const { rows } = await pool.query("SELECT valor FROM ch_config WHERE chave = 'dp_emails'");
  return { dp_emails: (rows[0] && rows[0].valor) || "", dp_emails_efetivos: dp, email_configurado: !!(process.env.RESEND_API_KEY && process.env.CHAMADOS_EMAIL_FROM), remetente: process.env.CHAMADOS_EMAIL_FROM || null, link_painel: process.env.CHAMADOS_URL || null };
}
async function salvarConfig(acc, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const lista = listaEmails(b.dp_emails);
  await pool.query("INSERT INTO ch_config (chave, valor) VALUES ('dp_emails',$1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [lista.join(", ")]);
  return { ok: true };
}

// ---------- chamados ----------
async function abrir(acc, b = {}) {
  const p = await papelDe(acc);
  let lojaId;
  if (p.papel === "loja") lojaId = Number(p.loja.id);
  else { exigirDp(p); lojaId = Number(b.loja_id); if (!lojaId) throw erro(400, "Escolha a loja em nome da qual o chamado está sendo aberto."); }
  const descricao = txt(b.descricao);
  if (descricao.length < 10) throw erro(400, "Descreva o que você precisa (pelo menos 10 letras).");
  if (descricao.length > 5000) throw erro(400, "A descrição passa de 5000 caracteres.");
  const anexos = limparAnexos(b.anexos);
  const cc = listaEmails(b.cc_emails).slice(0, 3);
  const info = await comTransacao(async (c) => {
    const { rows: as } = await c.query("SELECT * FROM ch_assuntos WHERE id = $1", [Number(b.assunto_id) || 0]);
    const a = as[0];
    if (!a || !a.ativo) throw erro(400, "Escolha um assunto da lista.");
    const colab = txt(b.colaborador).slice(0, 120);
    if (a.exige_colaborador && !colab) throw erro(400, "Informe o nome do colaborador a que o chamado se refere.");
    const dataRef = /^\d{4}-\d{2}-\d{2}$/.test(txt(b.data_ref)) ? txt(b.data_ref) : null;
    const { rows: lj } = await c.query("SELECT id, nome, ativa FROM ch_lojas WHERE id = $1", [lojaId]);
    if (!lj[0] || !lj[0].ativa) throw erro(400, "Loja não encontrada ou desativada.");
    const { rows } = await c.query(
      `INSERT INTO ch_chamados (loja_id, assunto_id, assunto_nome, descricao, prioridade, colaborador, data_ref, aberto_por, sla_resposta_min, sla_resolucao_min, cc_emails, ultima_msg_autor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'loja') RETURNING id`, [lojaId, a.id, a.nome, descricao, b.prioridade === "urgente" ? "urgente" : "normal", colab || null, dataRef, p.email, a.sla_resposta_min, a.sla_resolucao_min, cc]);
    const id = Number(rows[0].id);
    const protocolo = `CH-${new Date().getFullYear()}-${String(id).padStart(5, "0")}`;
    await c.query("UPDATE ch_chamados SET protocolo = $2 WHERE id = $1", [id, protocolo]);
    const { rows: m } = await c.query("INSERT INTO ch_mensagens (chamado_id, autor_email, autor_nome, autor_tipo, texto) VALUES ($1,$2,$3,$4,$5) RETURNING id", [id, p.email, p.nome, p.papel === "loja" ? "loja" : "dp", descricao]);
    await salvarAnexos(c, id, Number(m[0].id), anexos, p.email);
    await evento(c, id, "aberto", p.email, { assunto: a.nome, loja: lj[0].nome, anexos: anexos.length });
    return { id, protocolo, ch: await carregar(c, id, false) };
  });
  const ch = info.ch;
  dispara(async () => {
    await mail.enviar(ch.id, "abertura_loja", destinosLoja(ch), mail.montar("abertura_loja", ch));
    await mail.enviar(ch.id, "abertura_dp", await mail.destinosDp(), mail.montar("abertura_dp", ch));
  });
  return { ok: true, id: info.id, protocolo: info.protocolo };
}

async function listar(acc, f = {}) {
  const p = await papelDe(acc);
  const w = [], v = [];
  const add = (x) => { v.push(x); return "$" + v.length; };
  if (p.papel === "loja") w.push(`c.loja_id = ${add(Number(p.loja.id))}`);
  else if (Number(f.loja_id)) w.push(`c.loja_id = ${add(Number(f.loja_id))}`);
  if (f.status === "abertos" || !f.status) w.push(`c.status = ANY(${add(ABERTOS)})`);
  else if (f.status === "fechados") w.push(`c.status IN ('resolvido','cancelado')`);
  else if (STATUS.includes(f.status)) w.push(`c.status = ${add(f.status)}`);
  if (Number(f.assunto_id)) w.push(`c.assunto_id = ${add(Number(f.assunto_id))}`);
  if (ehDp(p)) {
    if (f.atribuido === "eu") w.push(`lower(c.atribuido_a) = ${add(p.email)}`);
    else if (f.atribuido === "sem") w.push("c.atribuido_a IS NULL");
    else if (f.atribuido && f.atribuido.includes("@")) w.push(`lower(c.atribuido_a) = ${add(em(f.atribuido))}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(txt(f.de))) w.push(`c.criado_em >= ${add(f.de + "T00:00:00-03:00")}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(txt(f.ate))) w.push(`c.criado_em < ${add(f.ate + "T00:00:00-03:00")}::timestamptz + interval '1 day'`);
  if (txt(f.q)) { const q = add("%" + txt(f.q).toLowerCase() + "%"); w.push(`(lower(c.protocolo) LIKE ${q} OR lower(c.descricao) LIKE ${q} OR lower(coalesce(c.colaborador,'')) LIKE ${q} OR lower(l.nome) LIKE ${q} OR lower(c.assunto_nome) LIKE ${q})`); }
  const { rows } = await pool.query(`SELECT ${COLS} ${FROM} ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY c.criado_em DESC LIMIT 2000`, v);
  const agora = new Date();
  let lista = rows.map((r) => formata(r, agora));
  if (f.sla === "estourado") lista = lista.filter((x) => x.relogio && x.relogio.situacao === "estourado");
  else if (f.sla === "risco") lista = lista.filter((x) => x.relogio && x.relogio.situacao === "risco");
  else if (f.sla === "atencao") lista = lista.filter((x) => x.relogio && (x.relogio.situacao === "estourado" || x.relogio.situacao === "risco"));
  // fila do DP: o que está mais perto de estourar (ou já estourou) primeiro; fechados por último
  lista.sort((a, b) => {
    const ra = a.relogio, rb = b.relogio;
    if (!!ra !== !!rb) return ra ? -1 : 1;
    if (ra && rb) {
      if (a.status === "aguardando_loja" !== (b.status === "aguardando_loja")) return a.status === "aguardando_loja" ? 1 : -1;
      return ra.restante - rb.restante;
    }
    return new Date(b.atualizado_em) - new Date(a.atualizado_em);
  });
  if (p.papel === "loja") lista.sort((a, b) => new Date(b.atualizado_em) - new Date(a.atualizado_em));
  const limite = Math.min(Number(f.limite) || 300, 500);
  const contagem = {};
  lista.forEach((x) => { contagem[x.status] = (contagem[x.status] || 0) + 1; });
  return { chamados: lista.slice(0, limite), total: lista.length, contagem };
}

async function detalhe(acc, id) {
  const p = await papelDe(acc);
  const ch = await carregar(pool, id, false);
  if (!podeVer(p, ch)) throw erro(403, "Esse chamado é de outra loja.");
  const dp = ehDp(p);
  if (dp) audit(acc, "ver_chamado", { papel: p.papel, chamado_id: id, detalhe: ch.protocolo + " · " + ch.loja_nome }); // quem do DP leu (LGPD)
  const { rows: msgs } = await pool.query(`SELECT id::int AS id, autor_email, autor_nome, autor_tipo, texto, interno, criado_em FROM ch_mensagens WHERE chamado_id = $1 ${dp ? "" : "AND NOT interno"} ORDER BY criado_em, id`, [id]);
  const { rows: ans } = await pool.query(`SELECT a.id::int AS id, a.mensagem_id::int AS mensagem_id, a.nome, a.tipo, a.tamanho FROM ch_anexos a LEFT JOIN ch_mensagens m ON m.id = a.mensagem_id WHERE a.chamado_id = $1 ${dp ? "" : "AND (m.id IS NULL OR NOT m.interno)"} ORDER BY a.id`, [id]);
  const out = { chamado: formata(ch, new Date()), mensagens: msgs.map((m) => ({ ...m, anexos: ans.filter((a) => a.mensagem_id === m.id) })) };
  out.chamado.loja_email = undefined; out.chamado.emails_copia = undefined;
  if (dp) {
    const { rows: ev } = await pool.query("SELECT tipo, usuario, detalhe, criado_em FROM ch_eventos WHERE chamado_id = $1 ORDER BY criado_em, id", [id]);
    const { rows: ems } = await pool.query("SELECT id::int AS id, tipo, destino, status, erro, tentativas, criado_em FROM ch_emails WHERE chamado_id = $1 ORDER BY id", [id]);
    out.eventos = ev; out.emails = ems; out.loja_email = ch.loja_email;
  } else {
    const { rows: ems } = await pool.query("SELECT tipo, destino, status, criado_em FROM ch_emails WHERE chamado_id = $1 AND tipo IN ('abertura_loja','resposta_dp') ORDER BY id", [id]);
    out.emails = ems;
  }
  return out;
}

async function responder(acc, id, b = {}) {
  const p = await papelDe(acc);
  const texto = txt(b.texto);
  const anexos = limparAnexos(b.anexos);
  const novo = txt(b.novo_status);
  const interno = !!b.interno;
  if (!texto && !anexos.length) throw erro(400, "Escreva a mensagem.");
  if (texto.length > 5000) throw erro(400, "A mensagem passa de 5000 caracteres.");
  if (interno && !ehDp(p)) throw erro(403, "Só o DP escreve notas internas.");
  if (novo && !ehDp(p)) throw erro(403, "Só o DP muda o status.");
  if (novo && !["em_atendimento", "aguardando_loja", "resolvido"].includes(novo)) throw erro(400, "Status inválido.");
  if (interno && novo) throw erro(400, "Nota interna não muda o status.");
  const r = await comTransacao(async (c) => {
    const ch = await carregar(c, id, true);
    if (!podeVer(p, ch)) throw erro(403, "Esse chamado é de outra loja.");
    if (ch.status === "cancelado") throw erro(409, "Esse chamado foi cancelado. Abra um novo.");
    let reaberto = false, statusFinal = ch.status;
    if (p.papel === "loja") {
      if (ch.status === "resolvido") {
        const dias = (Date.now() - new Date(ch.resolvido_em).getTime()) / 86400000;
        if (dias > REABRE_DIAS) throw erro(409, `Esse chamado foi resolvido há mais de ${REABRE_DIAS} dias e não pode mais ser reaberto. Abra um novo chamado.`);
        reaberto = true; statusFinal = "em_atendimento";
        await c.query("UPDATE ch_chamados SET reaberturas = reaberturas + 1 WHERE id = $1", [id]);
      } else if (ch.status === "aguardando_loja") statusFinal = "em_atendimento";
      if (statusFinal !== ch.status) await mudarStatus(c, ch, statusFinal, p.email, { motivo: reaberto ? "reaberto pela loja" : "loja respondeu" });
    } else if (!interno) {
      if (novo === "resolvido" && !texto) throw erro(400, "Escreva a resposta final antes de resolver.");
      if (novo === "aguardando_loja" && !texto) throw erro(400, "Diga o que você precisa da loja.");
      statusFinal = novo || (ch.status === "aberto" ? "em_atendimento" : ch.status);
      if (statusFinal !== ch.status) await mudarStatus(c, ch, statusFinal, p.email);
      if (!ch.primeira_resposta_em) await c.query("UPDATE ch_chamados SET primeira_resposta_em = now() WHERE id = $1", [id]);
      if (!ch.atribuido_a) { await c.query("UPDATE ch_chamados SET atribuido_a = $2 WHERE id = $1", [id, p.email]); await evento(c, id, "atribuido", p.email, { para: p.email, automatico: true }); }
    }
    const { rows: m } = await c.query("INSERT INTO ch_mensagens (chamado_id, autor_email, autor_nome, autor_tipo, texto, interno) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [id, p.email, p.nome, p.papel === "loja" ? "loja" : "dp", texto || "(anexo)", interno]);
    await salvarAnexos(c, id, Number(m[0].id), anexos, p.email);
    if (!interno) await c.query("UPDATE ch_chamados SET ultima_msg_autor = $2, atualizado_em = now() WHERE id = $1", [id, p.papel === "loja" ? "loja" : "dp"]);
    else await evento(c, id, "nota_interna", p.email, null);
    return { reaberto, statusFinal, ch: await carregar(c, id, false), anexosNomes: anexos.map((a) => a.nome) };
  });
  if (!interno) {
    const ch = r.ch;
    dispara(async () => {
      if (p.papel === "loja") {
        const dpd = ch.atribuido_a ? [ch.atribuido_a, ...(await mail.destinosDp())] : await mail.destinosDp();
        await mail.enviar(ch.id, "resposta_loja", dpd, mail.montar("resposta_loja", ch, { autor: p.nome, texto, reaberto: r.reaberto, anexos: r.anexosNomes }));
      } else await mail.enviar(ch.id, "resposta_dp", destinosLoja(ch), mail.montar("resposta_dp", ch, { autor: p.nome, texto, anexos: r.anexosNomes }));
    });
  }
  return { ok: true, status: r.statusFinal, reaberto: r.reaberto };
}

async function assumir(acc, id, b = {}) {
  const p = await papelDe(acc); exigirDp(p);
  let para = em(b.para) || p.email;
  if (b.para === null || b.para === "") para = null;
  return comTransacao(async (c) => {
    const ch = await carregar(c, id, true);
    if (para) {
      const { rows } = await c.query("SELECT 1 FROM ch_equipe WHERE lower(email) = $1 AND ativo UNION SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [para]);
      if (!rows[0]) throw erro(400, "Essa pessoa não está na equipe do DP.");
    }
    if (para && para !== p.email && p.papel !== "gestor") throw erro(403, "Só o gestor passa o chamado para outra pessoa.");
    await c.query("UPDATE ch_chamados SET atribuido_a = $2, atualizado_em = now() WHERE id = $1", [id, para]);
    await evento(c, id, "atribuido", p.email, { de: ch.atribuido_a, para });
    if (para && ch.status === "aberto") await mudarStatus(c, ch, "em_atendimento", p.email, { motivo: "assumido" });
    return { ok: true };
  });
}

// Ações exclusivas do master (cancelar/excluir): só o e-mail master, e a senha dele é conferida a cada vez (limite de tentativas como no login).
async function confirmarMaster(acc, id, b, acao) {
  if (!ehMaster(acc)) { await audit(acc, acao + "_negado", { chamado_id: id }); throw erro(403, "Só o usuário master pode fazer isso."); }
  const ip = acc.ip || "", chave = "master:" + emailMaster();
  const espera = seguranca.esperaLogin(ip, chave);
  if (espera) throw seguranca.erroBloqueio(espera);
  const { rows: us } = await pool.query("SELECT password_hash FROM users WHERE lower(email) = $1", [emailMaster()]);
  const certa = us[0] && b.senha && (await bcrypt.compare(String(b.senha), us[0].password_hash));
  if (!certa) {
    const bloqueou = seguranca.falhaLogin(ip, chave);
    await audit(acc, acao + "_senha_errada", { chamado_id: id, detalhe: bloqueou ? "bloqueado por tentativas" : null });
    throw erro(403, "Senha incorreta.", { codigo: "senha_master" });
  }
  seguranca.sucessoLogin(ip, chave);
}

async function cancelar(acc, id, b = {}) {
  if (!ehMaster(acc)) { await audit(acc, "cancelar_negado", { chamado_id: id }); throw erro(403, "Só o usuário master pode cancelar chamados."); }
  const p = await papelDe(acc);
  const motivo = txt(b.motivo).slice(0, 400);
  if (!motivo) throw erro(400, "Diga o motivo do cancelamento.");
  await confirmarMaster(acc, id, b, "cancelar");
  const ch = await comTransacao(async (c) => {
    const ch = await carregar(c, id, true);
    if (!podeVer(p, ch)) throw erro(403, "Esse chamado é de outra loja.");
    if (["resolvido", "cancelado"].includes(ch.status)) throw erro(409, "Esse chamado já está encerrado.");
    await mudarStatus(c, ch, "cancelado", p.email, { motivo });
    await audit(acc, "chamado_cancelado", { chamado_id: id, detalhe: ch.protocolo });
    await c.query("INSERT INTO ch_mensagens (chamado_id, autor_email, autor_nome, autor_tipo, texto) VALUES ($1,$2,$3,$4,$5)", [id, p.email, p.nome, p.papel === "loja" ? "loja" : "dp", "Chamado cancelado. Motivo: " + motivo]);
    return carregar(c, id, false);
  });
  dispara(async () => { await mail.enviar(ch.id, "cancelamento", [...destinosLoja(ch), ...(await mail.destinosDp())], mail.montar("cancelamento", ch, { motivo })); });
  return { ok: true };
}

async function excluir(acc, id, b = {}) {
  if (!ehMaster(acc)) { await audit(acc, "excluir_negado", { chamado_id: id }); throw erro(403, "Só o usuário master pode excluir chamados."); }
  const motivo = txt(b.motivo).slice(0, 400);
  if (!motivo) throw erro(400, "Diga o motivo da exclusão.");
  await confirmarMaster(acc, id, b, "excluir");
  const { rows } = await pool.query("SELECT c.protocolo, c.status, l.nome AS loja_nome FROM ch_chamados c JOIN ch_lojas l ON l.id = c.loja_id WHERE c.id = $1", [id]);
  if (!rows[0]) throw erro(404, "Chamado não encontrado.");
  // mensagens, anexos, eventos e e-mails saem junto (cascata). A auditoria guarda só quem excluiu, quando, o protocolo e o motivo.
  await pool.query("DELETE FROM ch_chamados WHERE id = $1", [id]);
  await audit(acc, "chamado_excluido", { chamado_id: id, detalhe: rows[0].protocolo + " · " + rows[0].loja_nome + " · " + rows[0].status + " · motivo: " + motivo });
  return { ok: true };
}

// Ajuste dos prazos (SLA) de UM chamado, em minutos úteis. O prazo padrão por assunto continua em Cadastros → Assuntos e SLA.
async function editarSla(acc, id, b = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const r = Math.round(Number(b.sla_resposta_min)), s = Math.round(Number(b.sla_resolucao_min));
  const motivo = txt(b.motivo).slice(0, 400);
  if (!(r > 0) || !(s > 0)) throw erro(400, "Informe os prazos maiores que zero.");
  if (r > 60 * 600 || s > 60 * 600) throw erro(400, "Prazo grande demais (máximo de 60 dias úteis).");
  if (s < r) throw erro(400, "O prazo de resolução não pode ser menor que o da 1ª resposta.");
  if (!motivo) throw erro(400, "Diga o motivo do ajuste.");
  await comTransacao(async (c) => {
    const ch = await carregar(c, id, true);
    await c.query("UPDATE ch_chamados SET sla_resposta_min = $2, sla_resolucao_min = $3, atualizado_em = now() WHERE id = $1", [id, r, s]);
    await evento(c, id, "sla_alterado", p.email, { de: { resposta: ch.sla_resposta_min, resolucao: ch.sla_resolucao_min }, para: { resposta: r, resolucao: s }, motivo });
    await audit(acc, "sla_alterado", { chamado_id: id, detalhe: ch.protocolo + " · resposta " + ch.sla_resposta_min + "→" + r + " min · resolução " + ch.sla_resolucao_min + "→" + s + " min · " + motivo });
  });
  return { ok: true };
}

async function baixarAnexo(acc, id) {
  const p = await papelDe(acc);
  const { rows } = await pool.query("SELECT a.nome, a.tipo, a.conteudo, a.chamado_id, m.interno FROM ch_anexos a LEFT JOIN ch_mensagens m ON m.id = a.mensagem_id WHERE a.id = $1", [id]);
  if (!rows[0]) throw erro(404, "Anexo não encontrado.");
  const ch = await carregar(pool, Number(rows[0].chamado_id), false);
  if (!podeVer(p, ch) || (rows[0].interno && !ehDp(p))) throw erro(403, "Sem acesso a esse anexo.");
  audit(acc, "baixar_anexo", { papel: p.papel, chamado_id: Number(rows[0].chamado_id), anexo_id: id, detalhe: rows[0].nome });
  return rows[0];
}

const ACOES_AUDIT = { login: "Entrou", login_falhou: "Login com senha errada", login_bloqueado: "Login bloqueado (tentativas)", senha_alterada: "Trocou a própria senha", senha_redefinida: "Senha redefinida pelo gestor",
  acesso_criado: "Acesso criado", acesso_liberado: "Acesso liberado/reativado", acesso_bloqueado: "Acesso bloqueado", ver_chamado: "Abriu o chamado", baixar_anexo: "Baixou anexo", exportar_indicadores: "Exportou relatório", chamado_cancelado: "Cancelou chamado", cancelar_negado: "Tentou cancelar (sem permissão)", cancelar_senha_errada: "Senha errada ao cancelar", chamado_excluido: "Excluiu chamado", excluir_negado: "Tentou excluir (sem permissão)", excluir_senha_errada: "Senha errada ao excluir", sla_alterado: "Alterou o SLA de um chamado" };
async function listarAuditoria(acc, f = {}) {
  const p = await papelDe(acc); exigirGestor(p);
  const w = [], v = []; const add = (x) => { v.push(x); return "$" + v.length; };
  if (f.acao && ACOES_AUDIT[f.acao]) w.push(`a.acao = ${add(f.acao)}`);
  if (f.usuario) w.push(`(lower(a.usuario) LIKE ${add("%" + String(f.usuario).toLowerCase().trim() + "%")} OR lower(a.alvo) LIKE $${v.length})`);
  if (f.protocolo) w.push(`c.protocolo ILIKE ${add("%" + String(f.protocolo).trim() + "%")}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.de || "")) w.push(`a.quando >= ${add(f.de + " 00:00-03")}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.ate || "")) w.push(`a.quando < (${add(f.ate)}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
  const { rows } = await pool.query(`SELECT a.id::int AS id, a.quando, a.usuario, a.papel, a.acao, a.alvo, a.detalhe, a.ip, c.protocolo, a.chamado_id::int AS chamado_id
    FROM ch_auditoria a LEFT JOIN ch_chamados c ON c.id = a.chamado_id ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY a.id DESC LIMIT 300`, v);
  return { registros: rows.map((r) => ({ ...r, acao_nome: ACOES_AUDIT[r.acao] || r.acao })), acoes: ACOES_AUDIT };
}

async function reenviarEmail(acc, id) { const p = await papelDe(acc); exigirDp(p); return mail.reenviar(id); }
async function emailsFalhos(acc) {
  const p = await papelDe(acc); exigirDp(p);
  const { rows } = await pool.query("SELECT e.id::int AS id, e.tipo, e.destino, e.status, e.erro, e.criado_em, c.protocolo FROM ch_emails e LEFT JOIN ch_chamados c ON c.id = e.chamado_id WHERE e.status <> 'enviado' ORDER BY e.id DESC LIMIT 100");
  return { emails: rows };
}

// ---------- indicadores ----------
const media = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
const pct = (ok, tot) => (tot ? Math.round((ok / tot) * 100) : null);
async function indicadores(acc, f = {}) {
  const p = await papelDe(acc); exigirDp(p);
  const hoje = diaLocal(new Date());
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(txt(f.ate)) ? f.ate : hoje;
  const dias = Math.min(Math.max(Number(f.dias) || 30, 1), 366);
  let de = /^\d{4}-\d{2}-\d{2}$/.test(txt(f.de)) ? f.de : diaLocal(new Date(Date.now() - (dias - 1) * 86400000));
  if (de > ate) de = ate;
  const w = [], v = [];
  const add = (x) => { v.push(x); return "$" + v.length; };
  if (Number(f.loja_id)) w.push(`c.loja_id = ${add(Number(f.loja_id))}`);
  if (Number(f.assunto_id)) w.push(`c.assunto_id = ${add(Number(f.assunto_id))}`);
  const filtro = w.length ? " AND " + w.join(" AND ") : "";
  const { rows: todos } = await pool.query(`SELECT ${COLS} ${FROM} WHERE (c.status = ANY(${add(ABERTOS)}) OR (c.criado_em >= ${add(de + "T00:00:00-03:00")}::timestamptz AND c.criado_em < ${add(ate + "T00:00:00-03:00")}::timestamptz + interval '1 day'))${filtro}`, v);
  const agora = new Date();
  const lista = todos.map((r) => formata(r, agora));
  const iniMs = new Date(de + "T00:00:00-03:00").getTime(), fimMs = new Date(ate + "T00:00:00-03:00").getTime() + 86400000;
  const noPeriodo = lista.filter((x) => { const t = new Date(x.criado_em).getTime(); return t >= iniMs && t < fimMs; });
  const abertos = lista.filter((x) => ABERTOS.includes(x.status));
  const validos = noPeriodo.filter((x) => x.status !== "cancelado");

  const resp = (a) => { const cons = a.filter((x) => x.sla.resposta.feito || x.sla.resposta.situacao === "estourado"); return { ok: cons.filter((x) => x.sla.resposta.situacao === "cumprido").length, tot: cons.length }; };
  const reso = (a) => { const cons = a.filter((x) => x.status === "resolvido" || x.sla.resolucao.situacao === "estourado"); return { ok: cons.filter((x) => x.sla.resolucao.situacao === "cumprido").length, tot: cons.length }; };
  const tmr = (a) => media(a.filter((x) => x.sla.resposta.feito).map((x) => x.sla.resposta.decorrido));
  const tmres = (a) => media(a.filter((x) => x.status === "resolvido").map((x) => x.sla.resolucao.decorrido));
  const R = resp(validos), S = reso(validos);

  const kpis = {
    abertos_agora: abertos.length, sem_atendente: abertos.filter((x) => !x.atribuido_a).length,
    estourados: abertos.filter((x) => x.relogio && x.relogio.situacao === "estourado").length, em_risco: abertos.filter((x) => x.relogio && x.relogio.situacao === "risco").length,
    aguardando_loja: abertos.filter((x) => x.status === "aguardando_loja").length,
    novos: noPeriodo.length, resolvidos: validos.filter((x) => x.status === "resolvido").length, cancelados: noPeriodo.filter((x) => x.status === "cancelado").length,
    resposta_no_prazo_pct: pct(R.ok, R.tot), resolucao_no_prazo_pct: pct(S.ok, S.tot), tempo_medio_resposta_min: tmr(validos), tempo_medio_resolucao_min: tmres(validos),
    reabertos: validos.filter((x) => x.reaberturas > 0).length, reabertura_pct: pct(validos.filter((x) => x.reaberturas > 0).length, validos.length),
  };

  // série por dia (criados x resolvidos) no período
  const serie = []; const idx = {};
  for (let d = de; d <= ate; ) { idx[d] = { dia: d, criados: 0, resolvidos: 0 }; serie.push(idx[d]); const n = new Date(d + "T12:00:00Z"); n.setUTCDate(n.getUTCDate() + 1); d = n.toISOString().slice(0, 10); if (serie.length > 400) break; }
  noPeriodo.forEach((x) => { const d = diaLocal(x.criado_em); if (idx[d]) idx[d].criados++; });
  lista.filter((x) => x.status === "resolvido" && x.resolvido_em).forEach((x) => { const d = diaLocal(x.resolvido_em); if (idx[d]) idx[d].resolvidos++; });

  const grupo = (arr, chave, rot) => {
    const m = new Map();
    arr.forEach((x) => { const k = chave(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
    return [...m.entries()].map(([k, a]) => {
      const r = resp(a), s = reso(a);
      return { chave: k, rotulo: rot ? rot(k, a) : k, volume: a.length, abertos: a.filter((x) => ABERTOS.includes(x.status)).length, estourados: a.filter((x) => x.relogio && x.relogio.situacao === "estourado").length,
        resolvidos: a.filter((x) => x.status === "resolvido").length, tempo_medio_resposta_min: tmr(a), tempo_medio_resolucao_min: tmres(a), resposta_no_prazo_pct: pct(r.ok, r.tot), resolucao_no_prazo_pct: pct(s.ok, s.tot),
        meta_resposta_min: a[0].sla_resposta_min, meta_resolucao_min: a[0].sla_resolucao_min };
    });
  };
  const porAssunto = grupo(validos, (x) => x.assunto_nome).sort((a, b) => b.volume - a.volume);
  const porLoja = grupo(validos, (x) => x.loja_nome).sort((a, b) => b.volume - a.volume);
  const porAtendente = grupo(validos.filter((x) => x.atribuido_a), (x) => x.atribuido_a).sort((a, b) => b.volume - a.volume);
  const { rows: eq } = await pool.query("SELECT lower(email) AS email, nome FROM ch_equipe");
  const nomes = {}; eq.forEach((e) => { nomes[e.email] = e.nome; });
  porAtendente.forEach((x) => { x.rotulo = nomes[em(x.chave)] || x.chave; });
  const porStatus = STATUS.map((s) => ({ status: s, total: noPeriodo.filter((x) => x.status === s).length }));
  const porPrioridade = ["urgente", "normal"].map((s) => ({ prioridade: s, total: validos.filter((x) => x.prioridade === s).length }));
  const exp = f.exportar === "xlsx" || f.exportar === "pdf" ? f.exportar : null;
  let linhasExp = null;
  if (exp === "xlsx" && f.detalhe === "1") {
    // linhas do período para a planilha (sem descrição, colaborador nem e-mails: só o que o relatório precisa)
    linhasExp = noPeriodo.slice(0, 5000).sort((a, b) => String(a.protocolo).localeCompare(String(b.protocolo))).map((x) => ({
      protocolo: x.protocolo, loja: x.loja_nome, assunto: x.assunto_nome, prioridade: x.prioridade, status: x.status, aberto_em: x.criado_em, primeira_resposta_em: x.primeira_resposta_em, resolvido_em: x.resolvido_em,
      atendente: x.atribuido_a, reaberturas: x.reaberturas, tempo_resposta_min: x.sla.resposta.decorrido, meta_resposta_min: x.sla_resposta_min, sla_resposta: x.sla.resposta.situacao,
      tempo_resolucao_min: x.sla.resolucao.decorrido, meta_resolucao_min: x.sla_resolucao_min, sla_resolucao: x.sla.resolucao.situacao }));
  }
  if (exp) audit(acc, "exportar_indicadores", { papel: p.papel, detalhe: `${exp.toUpperCase()} · ${de} a ${ate}` + (linhasExp ? ` · ${linhasExp.length} chamados` : "") });
  return { lista: linhasExp, periodo: { de, ate }, kpis, serie, por_assunto: porAssunto, por_loja: porLoja, por_atendente: porAtendente, por_status: porStatus, por_prioridade: porPrioridade,
    mais_urgentes: abertos.filter((x) => x.relogio && ["estourado", "risco"].includes(x.relogio.situacao)).sort((a, b) => a.relogio.restante - b.relogio.restante).slice(0, 10)
      .map((x) => ({ id: x.id, protocolo: x.protocolo, loja_nome: x.loja_nome, assunto_nome: x.assunto_nome, status: x.status, relogio: x.relogio })) };
}

module.exports = { eu, listarAssuntos, salvarAssunto, listarLojas, salvarLoja, importarEmailsLojas, listarAuditoria, listarAcessos, criarAcesso, redefinirSenhaAcesso, removerAcesso, listarEquipe, salvarEquipe, config, salvarConfig, abrir, listar, detalhe, responder, assumir, cancelar, excluir, editarSla, baixarAnexo, reenviarEmail, emailsFalhos, indicadores, slaDe };
