// Módulo de Visual Merchandising: cadastros (clusters, lojas, equipe), manuais e critérios.
// A auditoria das fotos fica em auditoria.js, a pontuação em calc.js e a IA em ia.js.
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const ia = require("./ia");
const { norm } = require("./calc");

function erro(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e; }
const em = (s) => String(s || "").trim().toLowerCase();
const hojeISO = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // dia de São Paulo
const txt = (v, max = 500) => (v == null ? "" : String(v).trim().slice(0, max));
const dataOk = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const ehData = (v) => !!dataOk(v) && !isNaN(new Date(v + "T12:00:00Z"));

async function comTransacao(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { try { await c.query("ROLLBACK"); } catch (_) { /* ignora */ } throw e; }
  finally { c.release(); }
}
async function evento(q, { auditoria_id = null, manual_id = null, tipo, usuario = null, detalhe = null }) {
  await (q || pool).query("INSERT INTO vm_eventos (auditoria_id, manual_id, tipo, usuario, detalhe) VALUES ($1,$2,$3,$4,$5)", [auditoria_id, manual_id, tipo, usuario, detalhe ? JSON.stringify(detalhe) : null]);
}

// ---------- papéis ----------
// admin e equipe "vm" enxergam tudo; "regional" só as lojas dos grupos (campo regional do cadastro de lojas);
// a loja é identificada pelo e-mail de login em ch_lojas e precisa estar marcada como participante.
async function papelDe(acc) {
  const email = em(acc.email);
  if (acc.role === "admin") return { papel: "vm", admin: true, nome: acc.nome || acc.email, email };
  const { rows: eq } = await pool.query("SELECT nome, papel, grupos FROM vm_equipe WHERE lower(email) = $1 AND ativo", [email]);
  if (eq[0]) return { papel: eq[0].papel === "regional" ? "regional" : "vm", admin: false, grupos: (eq[0].grupos || []).map(norm), nome: eq[0].nome || acc.nome || acc.email, email };
  const { rows: lj } = await pool.query("SELECT l.id::int AS id, l.nome, l.codigo, l.regional, l.ativa, l.vm_ativo, l.vm_cluster_id::int AS cluster_id, c.nome AS cluster_nome FROM ch_lojas l LEFT JOIN vm_clusters c ON c.id = l.vm_cluster_id WHERE lower(l.email) = $1", [email]);
  if (lj[0]) {
    if (!lj[0].ativa || !lj[0].vm_ativo) throw erro(403, "Sua loja ainda não participa do piloto de Visual Merchandising. Fale com o time de VM.");
    return { papel: "loja", nome: lj[0].nome, email, loja: lj[0] };
  }
  throw erro(403, "Seu usuário não está cadastrado como loja nem como equipe de VM. Peça ao time de VM para cadastrar.");
}
const ehVM = (p) => p.papel === "vm";
function exigirVM(p) { if (!ehVM(p)) throw erro(403, "Só o time de VM corporativo pode fazer isso."); }
function exigirGestao(p) { if (p.papel === "loja") throw erro(403, "Essa área é do time de VM e das regionais."); }
// condição SQL que limita as lojas visíveis (alias da tabela ch_lojas = l)
function escopoLoja(p, params) {
  if (p.papel === "loja") { params.push(p.loja.id); return `l.id = $${params.length}`; }
  if (p.papel === "regional") { params.push(p.grupos.length ? p.grupos : ["\u0000"]); return `lower(trim(coalesce(l.regional,''))) = ANY($${params.length}::text[])`; }
  return "true";
}
async function lojaVisivel(p, lojaId) {
  const params = [Number(lojaId)]; const cond = escopoLoja(p, params);
  const { rows } = await pool.query(`SELECT l.id::int AS id, l.nome, l.regional, l.vm_cluster_id::int AS cluster_id FROM ch_lojas l WHERE l.id = $1 AND ${cond}`, params);
  if (!rows[0]) throw erro(403, "Essa loja não está na sua área.");
  return rows[0];
}

// ---------- configuração ----------
const CONFIG_PADRAO = { limiar_aprovacao: 90, max_nv_pct: 25, max_reenvios: 2, teto_dia_usd: 20, retencao_dias: 180 };
async function getConfig() {
  const { rows } = await pool.query("SELECT chave, valor FROM vm_config");
  const c = { ...CONFIG_PADRAO }; for (const r of rows) if (r.chave in c && !isNaN(Number(r.valor))) c[r.chave] = Number(r.valor);
  return c;
}
async function eu(acc) {
  const p = await papelDe(acc);
  const cfg = await getConfig();
  const base = { papel: p.papel, admin: !!p.admin, nome: p.nome, email: p.email, ia_configurada: ia.configurada(), config: cfg, hoje: hojeISO() };
  if (p.papel === "loja") return { ...base, loja: { id: p.loja.id, nome: p.loja.nome, cluster_id: p.loja.cluster_id, cluster_nome: p.loja.cluster_nome, regional: p.loja.regional } };
  if (p.papel === "regional") return { ...base, grupos: p.grupos };
  return base;
}
async function salvarConfig(acc, b) {
  const p = await papelDe(acc); exigirVM(p);
  const lim = { limiar_aprovacao: [1, 100], max_nv_pct: [0, 100], max_reenvios: [0, 10], teto_dia_usd: [0, 100000], retencao_dias: [30, 3650] };
  for (const [k, [mi, ma]] of Object.entries(lim)) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]); if (isNaN(n) || n < mi || n > ma) throw erro(400, `Valor inválido para ${k} (de ${mi} a ${ma}).`);
    await pool.query("INSERT INTO vm_config (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [k, String(n)]);
  }
  await evento(null, { tipo: "config", usuario: p.email, detalhe: b });
  return { config: await getConfig() };
}

// ---------- clusters e checklist ----------
async function listarClusters(acc) {
  const p = await papelDe(acc); exigirGestao(p);
  const { rows: cl } = await pool.query(`SELECT c.id::int AS id, c.nome, c.descricao, c.ativo,
      (SELECT count(*)::int FROM ch_lojas l WHERE l.vm_cluster_id = c.id AND l.ativa) AS lojas,
      (SELECT count(*)::int FROM ch_lojas l WHERE l.vm_cluster_id = c.id AND l.ativa AND l.vm_ativo) AS lojas_piloto
    FROM vm_clusters c ORDER BY c.ativo DESC, lower(c.nome)`);
  const { rows: ck } = await pool.query("SELECT id::int AS id, cluster_id::int AS cluster_id, ambiente, descricao, obrigatorio, ordem, ativo FROM vm_checklists ORDER BY ordem, id");
  const { rows: mv } = await pool.query("SELECT DISTINCT ON (cluster_id) id::int AS id, cluster_id::int AS cluster_id, titulo, versao FROM vm_manuais WHERE status = 'vigente' AND (vigencia_inicio IS NULL OR vigencia_inicio <= $1) ORDER BY cluster_id, vigencia_inicio DESC NULLS LAST, id DESC", [hojeISO()]);
  return { clusters: cl.map((c) => ({ ...c, checklist: ck.filter((k) => k.cluster_id === c.id), manual_vigente: mv.find((m) => m.cluster_id === c.id) || null })) };
}
async function salvarCluster(acc, id, b) {
  const p = await papelDe(acc); exigirVM(p);
  const nome = txt(b.nome, 120); if (!nome) throw erro(400, "Informe o nome do cluster.");
  try {
    if (id) {
      const r = await pool.query("UPDATE vm_clusters SET nome=$2, descricao=$3, ativo=COALESCE($4, ativo) WHERE id=$1 RETURNING id::int AS id", [id, nome, txt(b.descricao, 500) || null, typeof b.ativo === "boolean" ? b.ativo : null]);
      if (!r.rows[0]) throw erro(404, "Cluster não encontrado.");
      return { id };
    }
    const r = await pool.query("INSERT INTO vm_clusters (nome, descricao) VALUES ($1,$2) RETURNING id::int AS id", [nome, txt(b.descricao, 500) || null]);
    await evento(null, { tipo: "cluster_criado", usuario: p.email, detalhe: { nome } });
    return { id: r.rows[0].id };
  } catch (e) { if (e.code === "23505") throw erro(409, "Já existe um cluster com esse nome."); throw e; }
}
// Checklist do cluster: um ambiente = uma foto por rodada. Ambientes que saem da lista ficam inativos (histórico preservado).
async function salvarChecklist(acc, clusterId, b) {
  const p = await papelDe(acc); exigirVM(p);
  const itens = Array.isArray(b.itens) ? b.itens : []; if (!itens.length) throw erro(400, "Informe ao menos um ambiente.");
  const vistos = new Set();
  for (const it of itens) { const n = norm(it.ambiente); if (!n) throw erro(400, "Todo ambiente precisa de um nome."); if (vistos.has(n)) throw erro(400, "Ambiente repetido: " + it.ambiente); vistos.add(n); }
  await comTransacao(async (c) => {
    const { rows } = await c.query("SELECT 1 FROM vm_clusters WHERE id = $1", [clusterId]); if (!rows[0]) throw erro(404, "Cluster não encontrado.");
    await c.query("UPDATE vm_checklists SET ativo = false WHERE cluster_id = $1", [clusterId]);
    let ordem = 0;
    for (const it of itens) {
      await c.query(`INSERT INTO vm_checklists (cluster_id, ambiente, descricao, obrigatorio, ordem, ativo) VALUES ($1,$2,$3,$4,$5,true)
        ON CONFLICT (cluster_id, lower(ambiente)) DO UPDATE SET ambiente = EXCLUDED.ambiente, descricao = EXCLUDED.descricao, obrigatorio = EXCLUDED.obrigatorio, ordem = EXCLUDED.ordem, ativo = true`,
        [clusterId, txt(it.ambiente, 80), txt(it.descricao, 300) || null, it.obrigatorio !== false, ordem++]);
    }
    await evento(c, { tipo: "checklist", usuario: p.email, detalhe: { cluster_id: clusterId, ambientes: itens.map((i) => i.ambiente) } });
  });
  return { ok: true };
}

// ---------- lojas do piloto ----------
async function listarLojas(acc) {
  const p = await papelDe(acc); exigirGestao(p);
  const params = []; const cond = escopoLoja(p, params);
  const { rows } = await pool.query(`SELECT l.id::int AS id, l.nome, l.codigo, l.email, l.regional, l.ativa, l.vm_ativo, l.vm_cluster_id::int AS cluster_id, c.nome AS cluster_nome,
      (SELECT count(*)::int FROM users u WHERE lower(u.email) = lower(l.email) AND ('vm' = ANY(u.modules) OR u.role = 'admin')) > 0 AS tem_acesso,
      (SELECT count(*)::int FROM users u WHERE lower(u.email) = lower(l.email)) > 0 AS tem_usuario
    FROM ch_lojas l LEFT JOIN vm_clusters c ON c.id = l.vm_cluster_id WHERE ${cond} ORDER BY l.ativa DESC, l.vm_ativo DESC, lower(l.nome)`, params);
  return { lojas: rows };
}
async function garantirModuloLoja(email) {
  if (!email) return "sem_email";
  const { rows } = await pool.query("SELECT id FROM users WHERE lower(email) = $1", [em(email)]);
  if (!rows[0]) return "sem_usuario";
  await pool.query("UPDATE users SET modules = (SELECT array_agg(DISTINCT x) FROM unnest(modules || ARRAY['vm']) x) WHERE id = $1", [rows[0].id]);
  return "ok";
}
async function configurarLoja(acc, id, b) {
  const p = await papelDe(acc); exigirVM(p);
  const { rows } = await pool.query("SELECT id, email, vm_cluster_id, vm_ativo FROM ch_lojas WHERE id = $1", [id]); if (!rows[0]) throw erro(404, "Loja não encontrada.");
  let cluster = rows[0].vm_cluster_id, ativo = rows[0].vm_ativo;
  if (b.cluster_id !== undefined) {
    if (b.cluster_id === null || b.cluster_id === "") cluster = null;
    else { const r = await pool.query("SELECT id FROM vm_clusters WHERE id = $1 AND ativo", [Number(b.cluster_id)]); if (!r.rows[0]) throw erro(400, "Cluster inválido."); cluster = Number(b.cluster_id); }
  }
  if (typeof b.vm_ativo === "boolean") ativo = b.vm_ativo;
  if (ativo && !cluster) throw erro(400, "Escolha o cluster da loja antes de ativá-la no piloto.");
  await pool.query("UPDATE ch_lojas SET vm_cluster_id = $2, vm_ativo = $3 WHERE id = $1", [id, cluster, ativo]);
  const acesso = ativo ? await garantirModuloLoja(rows[0].email) : null;
  await evento(null, { tipo: "loja_configurada", usuario: p.email, detalhe: { loja_id: id, cluster_id: cluster, vm_ativo: ativo } });
  return { ok: true, acesso };
}

// ---------- equipe ----------
async function gruposDisponiveis() {
  const { rows } = await pool.query("SELECT DISTINCT trim(regional) AS nome FROM ch_lojas WHERE ativa AND coalesce(trim(regional),'') <> '' ORDER BY 1");
  return rows.map((r) => r.nome);
}
async function listarEquipe(acc) {
  const p = await papelDe(acc); exigirVM(p);
  const { rows } = await pool.query(`SELECT e.id::int AS id, e.email, e.nome, e.papel, e.ativo, e.grupos, (u.id IS NOT NULL AND ('vm' = ANY(u.modules) OR u.role = 'admin')) AS tem_acesso, (u.id IS NOT NULL) AS tem_usuario
    FROM vm_equipe e LEFT JOIN users u ON lower(u.email) = lower(e.email) ORDER BY e.ativo DESC, e.papel, e.nome NULLS LAST, e.email`);
  return { equipe: rows, grupos_disponiveis: await gruposDisponiveis() };
}
async function garantirAcesso(email, nome, senha) {
  const e = em(email);
  const { rows } = await pool.query("SELECT id FROM users WHERE lower(email) = $1", [e]);
  if (rows[0]) {
    await pool.query("UPDATE users SET modules = (SELECT array_agg(DISTINCT x) FROM unnest(modules || ARRAY['vm']) x), nome = COALESCE(nome, $2) WHERE id = $1", [rows[0].id, nome || null]);
    if (senha) {
      if (String(senha).length < 8) throw erro(400, "A senha precisa de pelo menos 8 caracteres.");
      await pool.query("UPDATE users SET password_hash = $2, trocar_senha = true, token_version = token_version + 1 WHERE id = $1", [rows[0].id, await bcrypt.hash(String(senha), 10)]);
    }
    return { criado: false };
  }
  if (!senha || String(senha).length < 8) throw erro(400, "Esse e-mail ainda não tem usuário no sistema: informe uma senha inicial (mínimo 8 caracteres).");
  await pool.query("INSERT INTO users (email, password_hash, role, nome, modules, cd_perfis, trocar_senha) VALUES ($1,$2,'viewer',$3,ARRAY['vm'],'{}', true)", [e, await bcrypt.hash(String(senha), 10), nome || null]);
  return { criado: true };
}
async function salvarMembro(acc, b) {
  const p = await papelDe(acc); exigirVM(p);
  const email = em(b.email); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erro(400, "Informe um e-mail válido.");
  const papel = b.papel === "regional" ? "regional" : "vm";
  const grupos = papel === "regional" ? (Array.isArray(b.grupos) ? b.grupos.map((g) => txt(g, 120)).filter(Boolean) : []) : [];
  if (papel === "regional" && !grupos.length) throw erro(400, "Escolha ao menos uma regional para esse gestor.");
  const ac = await garantirAcesso(email, txt(b.nome, 120) || null, b.senha ? String(b.senha) : undefined);
  await pool.query(`INSERT INTO vm_equipe (email, nome, papel, grupos, ativo) VALUES ($1,$2,$3,$4,true)
    ON CONFLICT (lower(email)) DO UPDATE SET nome = COALESCE(EXCLUDED.nome, vm_equipe.nome), papel = EXCLUDED.papel, grupos = EXCLUDED.grupos, ativo = true`, [email, txt(b.nome, 120) || null, papel, grupos]);
  await evento(null, { tipo: "equipe_salva", usuario: p.email, detalhe: { email, papel, grupos } });
  return { ok: true, usuario_criado: ac.criado };
}
async function ativarMembro(acc, id, ativo) {
  const p = await papelDe(acc); exigirVM(p);
  const r = await pool.query("UPDATE vm_equipe SET ativo = $2 WHERE id = $1 RETURNING email", [id, !!ativo]);
  if (!r.rows[0]) throw erro(404, "Pessoa não encontrada.");
  await evento(null, { tipo: ativo ? "equipe_ativada" : "equipe_desativada", usuario: p.email, detalhe: { email: r.rows[0].email } });
  return { ok: true };
}

module.exports = { erro, em, hojeISO, txt, dataOk, ehData, comTransacao, evento, papelDe, ehVM, exigirVM, exigirGestao, escopoLoja, lojaVisivel, getConfig, eu, salvarConfig,
  listarClusters, salvarCluster, salvarChecklist, listarLojas, configurarLoja, listarEquipe, salvarMembro, ativarMembro, norm };
