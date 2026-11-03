// Manuais de VM: upload, leitura pela IA (Motor A), homologação dos critérios e publicação de versões.
const { pool } = require("../db");
const ia = require("./ia");
const core = require("./vm");
const { erro, txt, dataOk, ehData, comTransacao, evento, papelDe, exigirVM, exigirGestao, getConfig, hojeISO, norm } = core;

const TIPOS = ["visual", "posicionamento", "quantidade", "medida", "limpeza", "comunicacao", "outro"];
const CONGELADO = ["vigente", "arquivado"];
const LOTE_PAGINAS = 6;

const bufDe = (b64) => Buffer.from(String(b64 || "").replace(/^data:[^,]*,/, ""), "base64");
const ehJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const ehPdf = (b) => b.length > 5 && b.slice(0, 5).toString("latin1") === "%PDF-";

async function manualDe(id, q = pool) {
  const { rows } = await q.query("SELECT id::int AS id, cluster_id::int AS cluster_id, titulo, versao, vigencia_inicio::text AS vigencia_inicio, vigencia_fim::text AS vigencia_fim, responsavel, status, paginas, (pdf IS NOT NULL) AS tem_pdf, pdf_nome, pdf_tamanho, erro, progresso, ia_modelo, ia_prompt_versao, criado_por, criado_em, publicado_por, publicado_em, atualizado_em FROM vm_manuais WHERE id = $1", [id]);
  if (!rows[0]) throw erro(404, "Manual não encontrado.");
  return rows[0];
}
function exigirEditavel(m) { if (CONGELADO.includes(m.status)) throw erro(409, "Esta versão já foi publicada e não pode mais ser alterada. Crie uma nova versão do manual."); }

async function listarManuais(acc, q = {}) {
  const p = await papelDe(acc); exigirGestao(p);
  const params = []; let w = "true";
  if (q.cluster_id) { params.push(Number(q.cluster_id)); w = `m.cluster_id = $${params.length}`; }
  const { rows } = await pool.query(`SELECT m.id::int AS id, m.cluster_id::int AS cluster_id, c.nome AS cluster_nome, m.titulo, m.versao, m.vigencia_inicio::text AS vigencia_inicio, m.vigencia_fim::text AS vigencia_fim, m.responsavel, m.status, m.paginas, m.progresso, m.erro, m.criado_em, m.publicado_em,
      (SELECT count(*)::int FROM vm_criterios k WHERE k.manual_id = m.id) AS criterios,
      (SELECT count(*)::int FROM vm_criterios k WHERE k.manual_id = m.id AND k.status = 'pendente_homologacao') AS pendentes,
      (SELECT count(*)::int FROM vm_criterios k WHERE k.manual_id = m.id AND k.status = 'homologado') AS homologados
    FROM vm_manuais m JOIN vm_clusters c ON c.id = m.cluster_id WHERE ${w} ORDER BY m.criado_em DESC`, params);
  return { manuais: rows };
}

async function criarManual(acc, b) {
  const p = await papelDe(acc); exigirVM(p);
  const cl = await pool.query("SELECT id FROM vm_clusters WHERE id = $1", [Number(b.cluster_id)]); if (!cl.rows[0]) throw erro(400, "Escolha o cluster do manual.");
  const titulo = txt(b.titulo, 200), versao = txt(b.versao, 40); if (!titulo || !versao) throw erro(400, "Informe o título e a versão do manual.");
  const ini = b.vigencia_inicio ? dataOk(b.vigencia_inicio) : null, fim = b.vigencia_fim ? dataOk(b.vigencia_fim) : null;
  if ((b.vigencia_inicio && !ehData(ini)) || (b.vigencia_fim && !ehData(fim))) throw erro(400, "Data de vigência inválida.");
  if (ini && fim && fim < ini) throw erro(400, "O fim da vigência não pode ser antes do início.");
  const pg = Number(b.paginas); if (!Number.isInteger(pg) || pg < 1 || pg > 300) throw erro(400, "Número de páginas inválido (1 a 300).");
  const dup = await pool.query("SELECT 1 FROM vm_manuais WHERE cluster_id = $1 AND lower(versao) = lower($2) AND lower(titulo) = lower($3)", [Number(b.cluster_id), versao, titulo]);
  if (dup.rows[0]) throw erro(409, "Esse cluster já tem um manual com esse título e versão.");
  const r = await pool.query("INSERT INTO vm_manuais (cluster_id, titulo, versao, vigencia_inicio, vigencia_fim, responsavel, paginas, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::int AS id",
    [Number(b.cluster_id), titulo, versao, ini, fim, txt(b.responsavel, 120) || null, pg, p.email]);
  await evento(null, { manual_id: r.rows[0].id, tipo: "manual_criado", usuario: p.email, detalhe: { titulo, versao, paginas: pg } });
  return { id: r.rows[0].id };
}
async function editarManual(acc, id, b) {
  const p = await papelDe(acc); exigirVM(p);
  const m = await manualDe(id); exigirEditavel(m);
  const ini = b.vigencia_inicio === undefined ? m.vigencia_inicio : (b.vigencia_inicio ? dataOk(b.vigencia_inicio) : null);
  const fim = b.vigencia_fim === undefined ? m.vigencia_fim : (b.vigencia_fim ? dataOk(b.vigencia_fim) : null);
  await pool.query("UPDATE vm_manuais SET titulo = $2, versao = $3, vigencia_inicio = $4, vigencia_fim = $5, responsavel = $6, atualizado_em = now() WHERE id = $1",
    [id, txt(b.titulo, 200) || m.titulo, txt(b.versao, 40) || m.versao, ini, fim, b.responsavel === undefined ? m.responsavel : (txt(b.responsavel, 120) || null)]);
  return { ok: true };
}
async function salvarPdf(acc, id, b) {
  const p = await papelDe(acc); exigirVM(p);
  const m = await manualDe(id); exigirEditavel(m);
  const buf = bufDe(b.base64); if (!ehPdf(buf)) throw erro(400, "O arquivo enviado não é um PDF.");
  if (buf.length > 25 * 1024 * 1024) throw erro(400, "O PDF passa de 25 MB. Comprima o arquivo e tente de novo.");
  await pool.query("UPDATE vm_manuais SET pdf = $2, pdf_nome = $3, pdf_tamanho = $4, atualizado_em = now() WHERE id = $1", [id, buf, txt(b.nome, 200) || "manual.pdf", buf.length]);
  return { ok: true, tamanho: buf.length };
}
// As páginas chegam já lidas pelo navegador (texto + imagem em JPEG), em lotes pequenos.
async function receberPaginas(acc, id, b) {
  const p = await papelDe(acc); exigirVM(p);
  const m = await manualDe(id); exigirEditavel(m);
  if (m.status === "processando") throw erro(409, "O manual está sendo lido pela IA agora.");
  const lista = Array.isArray(b.paginas) ? b.paginas : []; if (!lista.length || lista.length > 10) throw erro(400, "Envie de 1 a 10 páginas por vez.");
  for (const pg of lista) {
    const n = Number(pg.pagina); if (!Number.isInteger(n) || n < 1 || n > m.paginas) throw erro(400, "Página fora do intervalo do manual: " + pg.pagina);
    const img = pg.imagem_base64 ? bufDe(pg.imagem_base64) : null;
    if (img && !ehJpeg(img)) throw erro(400, "A imagem da página " + n + " precisa ser JPEG.");
    if (img && img.length > 2.5 * 1024 * 1024) throw erro(400, "A imagem da página " + n + " é grande demais.");
    await pool.query("INSERT INTO vm_manual_paginas (manual_id, pagina, texto, imagem) VALUES ($1,$2,$3,$4) ON CONFLICT (manual_id, pagina) DO UPDATE SET texto = EXCLUDED.texto, imagem = COALESCE(EXCLUDED.imagem, vm_manual_paginas.imagem)", [id, n, txt(pg.texto, 30000) || null, img]);
  }
  await pool.query("UPDATE vm_manuais SET atualizado_em = now() WHERE id = $1", [id]);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM vm_manual_paginas WHERE manual_id = $1 AND imagem IS NOT NULL", [id]);
  return { ok: true, enviadas: rows[0].n, total: m.paginas };
}

// ---------- Motor A: leitura do manual pela IA ----------
async function extrair(acc, id) {
  const p = await papelDe(acc); exigirVM(p);
  let m = await manualDe(id); exigirEditavel(m);
  if (m.status === "processando" && Date.now() - new Date(m.atualizado_em).getTime() < 10 * 60e3) throw erro(409, "O manual já está sendo lido pela IA.");
  if (!ia.configurada()) throw erro(503, "A IA ainda não foi configurada no servidor (variável ANTHROPIC_API_KEY). Você pode cadastrar os critérios manualmente enquanto isso.");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM vm_manual_paginas WHERE manual_id = $1 AND imagem IS NOT NULL", [id]);
  if (rows[0].n < m.paginas) throw erro(400, `Só ${rows[0].n} de ${m.paginas} páginas foram enviadas. Envie o manual completo antes de pedir a leitura.`);
  const cfg = await getConfig();
  const gasto = await gastoHoje(); if (gasto >= cfg.teto_dia_usd) throw erro(429, "O limite diário de gasto com IA foi atingido. Tente amanhã ou aumente o teto nas configurações.");
  await pool.query("UPDATE vm_manuais SET status = 'processando', progresso = 0, erro = NULL, atualizado_em = now() WHERE id = $1", [id]);
  await evento(null, { manual_id: id, tipo: "extracao_iniciada", usuario: p.email });
  setImmediate(() => processarManual(id).catch((e) => console.error("[vm] processarManual", id, e)));
  return { ok: true, status: "processando" };
}
async function gastoHoje() {
  const { rows } = await pool.query("SELECT coalesce(sum(custo_usd),0)::float AS g FROM vm_ia_log WHERE criado_em >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')");
  return rows[0].g;
}
async function logIA(tipo, refId, r, ok, err) {
  await pool.query("INSERT INTO vm_ia_log (tipo, ref_id, modelo, prompt_versao, tokens_in, tokens_out, custo_usd, latencia_ms, ok, erro) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [tipo, refId, (r && r.modelo) || ia.MODELO(), tipo === "manual" ? ia.PROMPT_MANUAL : ia.PROMPT_FOTO, (r && r.tokens_in) || null, (r && r.tokens_out) || null, (r && r.custo_usd) || null, (r && r.latencia_ms) || (err && err.latencia_ms) || null, ok, err ? String(err.message).slice(0, 400) : null]);
}
function acharAmbiente(raw, ambientes) {
  const n = norm(raw); if (!n) return null;
  let a = ambientes.find((x) => norm(x) === n); if (a) return a;
  a = ambientes.find((x) => norm(x).includes(n) || n.includes(norm(x))); return a || null;
}
async function processarManual(id) {
  try {
    const m = await manualDe(id);
    const { rows: cl } = await pool.query("SELECT nome FROM vm_clusters WHERE id = $1", [m.cluster_id]);
    const { rows: ck } = await pool.query("SELECT ambiente FROM vm_checklists WHERE cluster_id = $1 AND ativo ORDER BY ordem, id", [m.cluster_id]);
    const ambientes = ck.map((r) => r.ambiente);
    if (!ambientes.length) throw new Error("O cluster ainda não tem ambientes no checklist. Cadastre os ambientes e tente de novo.");
    await pool.query("DELETE FROM vm_criterios WHERE manual_id = $1 AND origem = 'ia' AND status = 'pendente_homologacao'", [id]);
    const { rows: pgs } = await pool.query("SELECT pagina, texto, imagem FROM vm_manual_paginas WHERE manual_id = $1 ORDER BY pagina", [id]);
    const lotes = []; for (let i = 0; i < pgs.length; i += LOTE_PAGINAS) lotes.push(pgs.slice(i, i + LOTE_PAGINAS));
    const cfg = await getConfig();
    let total = 0, modelo = null, observacoes = [];
    const { rows: ja } = await pool.query("SELECT ambiente, descricao FROM vm_criterios WHERE manual_id = $1", [id]);
    const vistos = new Set(ja.map((c) => norm(c.ambiente) + "|" + norm(c.descricao)));
    const resumo = ja.map((c) => `- [${c.ambiente}] ${c.descricao}`);
    for (let i = 0; i < lotes.length; i++) {
      if ((await gastoHoje()) >= cfg.teto_dia_usd) throw new Error("Limite diário de gasto com IA atingido durante a leitura. Tente de novo mais tarde.");
      const lote = lotes[i];
      const content = [{ type: "text", text: `Manual "${m.titulo}" (versão ${m.versao}) do cluster "${cl[0].nome}". Páginas ${lote[0].pagina} a ${lote[lote.length - 1].pagina} de ${m.paginas}.\nAmbientes permitidos (use exatamente estes nomes): ${ambientes.join("; ")}.` + (resumo.length ? `\nCritérios já extraídos em páginas anteriores (não repita):\n${resumo.slice(-60).join("\n")}` : "") }];
      for (const pg of lote) {
        content.push({ type: "text", text: `--- Página ${pg.pagina} --- Texto extraído do PDF:\n${(pg.texto || "(sem texto extraível)").slice(0, 6000)}` });
        if (pg.imagem) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: pg.imagem.toString("base64") } });
      }
      let r;
      try { r = await ia.fila(() => ia.chamar({ system: ia.SISTEMA_MANUAL, content, ferramenta: ia.FERRAMENTA_MANUAL, maxTokens: 6000 })); }
      catch (e) { await logIA("manual", id, null, false, e); throw e; }
      await logIA("manual", id, r, true);
      modelo = r.modelo;
      if (r.input.observacoes) observacoes.push(String(r.input.observacoes).slice(0, 300));
      const lista = Array.isArray(r.input.criterios) ? r.input.criterios : [];
      for (const c of lista) {
        const desc = txt(c.descricao, 400); if (desc.length < 5) continue;
        const amb = acharAmbiente(c.ambiente, ambientes); const ambFinal = amb || txt(c.ambiente, 80) || "(sem ambiente)";
        const chave = norm(ambFinal) + "|" + norm(desc); if (vistos.has(chave)) continue; vistos.add(chave);
        const pagina = Number.isInteger(c.pagina) && c.pagina >= 1 && c.pagina <= m.paginas ? c.pagina : lote[0].pagina;
        const ref = Number.isInteger(c.referencia_pagina) && c.referencia_pagina >= 1 && c.referencia_pagina <= m.paginas ? c.referencia_pagina : null;
        const peso = Number.isInteger(c.peso) && c.peso >= 1 && c.peso <= 100 ? c.peso : 5;
        const exc = txt(c.excecoes, 400) || null;
        await pool.query("INSERT INTO vm_criterios (manual_id, cluster_id, ambiente, descricao, tipo, peso, critico, pagina, referencia_pagina, excecoes, origem, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ia',$11)",
          [id, m.cluster_id, ambFinal, desc, TIPOS.includes(c.tipo) ? c.tipo : "outro", peso, c.critico === true, pagina, ref, amb ? exc : ((exc ? exc + " · " : "") + "Ambiente sugerido pela IA não existe no checklist."), total++]);
        resumo.push(`- [${ambFinal}] ${desc}`);
      }
      await pool.query("UPDATE vm_manuais SET progresso = $2, atualizado_em = now() WHERE id = $1", [id, Math.round(((i + 1) * 100) / lotes.length)]);
    }
    await pool.query("UPDATE vm_manuais SET status = 'em_revisao', progresso = 100, erro = $2, ia_modelo = $3, ia_prompt_versao = $4, atualizado_em = now() WHERE id = $1",
      [id, total ? null : "A IA não encontrou critérios verificáveis neste manual. Cadastre os critérios manualmente.", modelo, ia.PROMPT_MANUAL]);
    await evento(null, { manual_id: id, tipo: "extracao_concluida", detalhe: { criterios: total, observacoes } });
  } catch (e) {
    await pool.query("UPDATE vm_manuais SET status = 'erro', erro = $2, atualizado_em = now() WHERE id = $1", [id, String(e.message).slice(0, 500)]).catch(() => {});
    await evento(null, { manual_id: id, tipo: "extracao_falhou", detalhe: { erro: String(e.message).slice(0, 300) } }).catch(() => {});
  }
}

// ---------- detalhe, critérios e homologação ----------
const COLS_CRIT = "k.id::int AS id, k.manual_id::int AS manual_id, k.ambiente, k.descricao, k.tipo, k.peso, k.critico, k.pagina, k.referencia_pagina, k.excecoes, k.status, k.origem, k.homologado_por, k.homologado_em, k.motivo_rejeicao, k.ordem";
async function problemasPublicacao(m, q = pool) {
  const { rows: ck } = await q.query("SELECT ambiente, obrigatorio FROM vm_checklists WHERE cluster_id = $1 AND ativo", [m.cluster_id]);
  const { rows: cr } = await q.query("SELECT ambiente, status, descricao FROM vm_criterios WHERE manual_id = $1", [m.id]);
  const pr = [];
  const pend = cr.filter((c) => c.status === "pendente_homologacao").length;
  if (pend) pr.push(`Ainda há ${pend} critério(s) aguardando homologação.`);
  const hom = cr.filter((c) => c.status === "homologado");
  if (!hom.length) pr.push("Nenhum critério homologado.");
  for (const c of hom) if (!ck.some((k) => norm(k.ambiente) === norm(c.ambiente))) pr.push(`O ambiente "${c.ambiente}" (critério "${c.descricao.slice(0, 60)}") não existe no checklist do cluster.`);
  for (const k of ck) if (k.obrigatorio && !hom.some((c) => norm(c.ambiente) === norm(k.ambiente))) pr.push(`O ambiente obrigatório "${k.ambiente}" não tem nenhum critério homologado.`);
  if (m.paginas && !m.tem_pdf) { /* o PDF original é opcional: as páginas já ficam guardadas como imagem */ }
  return pr;
}
async function detalheManual(acc, id) {
  const p = await papelDe(acc); exigirGestao(p);
  const m = await manualDe(id);
  const { rows: crit } = await pool.query(`SELECT ${COLS_CRIT} FROM vm_criterios k WHERE k.manual_id = $1 ORDER BY k.ambiente, k.ordem, k.id`, [id]);
  const { rows: pg } = await pool.query("SELECT count(*) FILTER (WHERE imagem IS NOT NULL)::int AS enviadas FROM vm_manual_paginas WHERE manual_id = $1", [id]);
  const { rows: ck } = await pool.query("SELECT id::int AS id, ambiente, obrigatorio FROM vm_checklists WHERE cluster_id = $1 AND ativo ORDER BY ordem, id", [m.cluster_id]);
  const { rows: cl } = await pool.query("SELECT nome FROM vm_clusters WHERE id = $1", [m.cluster_id]);
  const { rows: ev } = await pool.query("SELECT tipo, usuario, detalhe, criado_em FROM vm_eventos WHERE manual_id = $1 ORDER BY id DESC LIMIT 30", [id]);
  const resumo = { total: crit.length, pendentes: crit.filter((c) => c.status === "pendente_homologacao").length, homologados: crit.filter((c) => c.status === "homologado").length, rejeitados: crit.filter((c) => c.status === "rejeitado").length };
  return { manual: { ...m, cluster_nome: cl[0] && cl[0].nome }, criterios: crit, paginas_enviadas: pg[0].enviadas, checklist: ck, resumo, problemas: CONGELADO.includes(m.status) ? [] : await problemasPublicacao(m), eventos: ev, ia_configurada: ia.configurada() };
}
function lerCriterio(b, m, ck) {
  const ambiente = txt(b.ambiente, 80); if (!ambiente) throw erro(400, "Escolha o ambiente do critério.");
  const descricao = txt(b.descricao, 400); if (descricao.length < 5) throw erro(400, "Descreva o critério (mínimo 5 letras).");
  const peso = Number(b.peso === undefined || b.peso === "" ? 5 : b.peso); if (!Number.isInteger(peso) || peso < 1 || peso > 100) throw erro(400, "O peso precisa ser um número inteiro de 1 a 100.");
  const pagina = b.pagina ? Number(b.pagina) : null, ref = b.referencia_pagina ? Number(b.referencia_pagina) : null;
  for (const n of [pagina, ref]) if (n !== null && (!Number.isInteger(n) || n < 1 || n > m.paginas)) throw erro(400, "Página fora do manual (1 a " + m.paginas + ").");
  return { ambiente, descricao, tipo: TIPOS.includes(b.tipo) ? b.tipo : "visual", peso, critico: b.critico === true, pagina, referencia_pagina: ref, excecoes: txt(b.excecoes, 400) || null };
}
async function criarCriterio(acc, manualId, b) {
  const p = await papelDe(acc); exigirVM(p);
  const m = await manualDe(manualId); exigirEditavel(m);
  const c = lerCriterio(b, m);
  const { rows: ord } = await pool.query("SELECT coalesce(max(ordem),0)+1 AS o FROM vm_criterios WHERE manual_id = $1", [manualId]);
  const r = await pool.query("INSERT INTO vm_criterios (manual_id, cluster_id, ambiente, descricao, tipo, peso, critico, pagina, referencia_pagina, excecoes, origem, status, homologado_por, homologado_em, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual','homologado',$11,now(),$12) RETURNING id::int AS id",
    [manualId, m.cluster_id, c.ambiente, c.descricao, c.tipo, c.peso, c.critico, c.pagina, c.referencia_pagina, c.excecoes, p.email, ord[0].o]);
  await evento(null, { manual_id: manualId, tipo: "criterio_criado", usuario: p.email, detalhe: { id: r.rows[0].id, ambiente: c.ambiente } });
  return { id: r.rows[0].id };
}
async function criterioDe(id) {
  const { rows } = await pool.query("SELECT k.*, m.status AS manual_status, m.paginas, m.cluster_id AS m_cluster FROM vm_criterios k JOIN vm_manuais m ON m.id = k.manual_id WHERE k.id = $1", [id]);
  if (!rows[0]) throw erro(404, "Critério não encontrado."); return rows[0];
}
async function editarCriterio(acc, id, b) {
  const p = await papelDe(acc); exigirVM(p);
  const k = await criterioDe(id); if (CONGELADO.includes(k.manual_status)) throw erro(409, "Esta versão já foi publicada e não pode mais ser alterada.");
  const c = lerCriterio({ ...k, ...b }, { paginas: k.paginas });
  await pool.query("UPDATE vm_criterios SET ambiente=$2, descricao=$3, tipo=$4, peso=$5, critico=$6, pagina=$7, referencia_pagina=$8, excecoes=$9 WHERE id=$1", [id, c.ambiente, c.descricao, c.tipo, c.peso, c.critico, c.pagina, c.referencia_pagina, c.excecoes]);
  await evento(null, { manual_id: Number(k.manual_id), tipo: "criterio_editado", usuario: p.email, detalhe: { id } });
  return { ok: true };
}
async function excluirCriterio(acc, id) {
  const p = await papelDe(acc); exigirVM(p);
  const k = await criterioDe(id); if (CONGELADO.includes(k.manual_status)) throw erro(409, "Esta versão já foi publicada e não pode mais ser alterada.");
  await pool.query("DELETE FROM vm_criterios WHERE id = $1", [id]);
  await evento(null, { manual_id: Number(k.manual_id), tipo: "criterio_excluido", usuario: p.email, detalhe: { id, descricao: k.descricao } });
  return { ok: true };
}
async function homologar(acc, manualId, b) {
  const p = await papelDe(acc); exigirVM(p);
  const m = await manualDe(manualId); exigirEditavel(m);
  const acao = b.acao; if (!["aprovar", "rejeitar", "reabrir"].includes(acao)) throw erro(400, "Ação inválida.");
  if (acao === "rejeitar" && !txt(b.motivo, 300)) throw erro(400, "Explique o motivo da rejeição.");
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : null;
  if (!ids && b.todos !== true) throw erro(400, "Escolha os critérios.");
  const alvo = acao === "aprovar" ? "homologado" : acao === "rejeitar" ? "rejeitado" : "pendente_homologacao";
  const r = await pool.query(`UPDATE vm_criterios SET status = $2, homologado_por = $3, homologado_em = CASE WHEN $2 = 'pendente_homologacao' THEN NULL ELSE now() END, motivo_rejeicao = $4
    WHERE manual_id = $1 AND ($5::bigint[] IS NULL OR id = ANY($5)) AND ($6 OR status <> $2) ${b.todos === true && !ids ? "AND status = 'pendente_homologacao'" : ""}`,
    [manualId, alvo, acao === "reabrir" ? null : p.email, acao === "rejeitar" ? txt(b.motivo, 300) : null, ids, !!ids]);
  await evento(null, { manual_id: manualId, tipo: "homologacao_" + acao, usuario: p.email, detalhe: { quantidade: r.rowCount, motivo: b.motivo || null } });
  return { ok: true, alterados: r.rowCount };
}
async function publicar(acc, id) {
  const p = await papelDe(acc); exigirVM(p);
  return comTransacao(async (c) => {
    const m = await manualDe(id, c); exigirEditavel(m);
    if (m.status === "processando") throw erro(409, "Aguarde a IA terminar de ler o manual.");
    const pr = await problemasPublicacao(m, c);
    if (pr.length) throw erro(400, "Ainda não dá para publicar: " + pr[0], { problemas: pr });
    const hoje = hojeISO(); const inicio = m.vigencia_inicio || hoje;
    if (!m.vigencia_inicio) await c.query("UPDATE vm_manuais SET vigencia_inicio = $2 WHERE id = $1", [id, hoje]);
    const { rows: ant } = await c.query("SELECT id::int AS id FROM vm_manuais WHERE cluster_id = $1 AND status = 'vigente' AND id <> $2", [m.cluster_id, id]);
    for (const a of ant) {
      if (inicio <= hoje) await c.query("UPDATE vm_manuais SET status = 'arquivado', vigencia_fim = COALESCE(vigencia_fim, ($2::date - 1)) WHERE id = $1", [a.id, inicio]);
      else await c.query("UPDATE vm_manuais SET vigencia_fim = ($2::date - 1) WHERE id = $1", [a.id, inicio]);
    }
    await c.query("UPDATE vm_manuais SET status = 'vigente', publicado_por = $2, publicado_em = now(), atualizado_em = now() WHERE id = $1", [id, p.email]);
    await evento(c, { manual_id: id, tipo: "manual_publicado", usuario: p.email, detalhe: { versao: m.versao, substitui: ant.map((a) => a.id) } });
    return { ok: true, substituidos: ant.length };
  });
}
async function excluirManual(acc, id) {
  const p = await papelDe(acc); exigirVM(p);
  const m = await manualDe(id);
  if (CONGELADO.includes(m.status)) throw erro(409, "Versões publicadas ficam guardadas no histórico e não podem ser excluídas.");
  const { rows } = await pool.query("SELECT 1 FROM vm_auditorias WHERE manual_id = $1 LIMIT 1", [id]); if (rows[0]) throw erro(409, "Já existem auditorias ligadas a este manual.");
  await pool.query("DELETE FROM vm_manuais WHERE id = $1", [id]);
  await evento(null, { tipo: "manual_excluido", usuario: p.email, detalhe: { id, titulo: m.titulo, versao: m.versao } });
  return { ok: true };
}

// ---------- arquivos ----------
// A loja só vê as páginas que o manual usa como referência dos critérios do seu ambiente (manual vigente do seu cluster).
async function paginaImagem(acc, manualId, n) {
  const p = await papelDe(acc);
  if (p.papel === "loja") {
    const { rows } = await pool.query(`SELECT 1 FROM vm_criterios k JOIN vm_manuais m ON m.id = k.manual_id WHERE k.manual_id = $1 AND m.cluster_id = $2 AND k.status = 'homologado' AND (k.referencia_pagina = $3 OR (k.referencia_pagina IS NULL AND k.pagina = $3)) LIMIT 1`, [manualId, p.loja.cluster_id, n]);
    if (!rows[0]) throw erro(403, "Essa página não está disponível para a sua loja.");
  }
  const { rows } = await pool.query("SELECT imagem FROM vm_manual_paginas WHERE manual_id = $1 AND pagina = $2", [manualId, n]);
  if (!rows[0] || !rows[0].imagem) throw erro(404, "Página não encontrada.");
  return { mime: "image/jpeg", dados: rows[0].imagem };
}
async function baixarPdf(acc, id) {
  const p = await papelDe(acc); exigirGestao(p);
  const { rows } = await pool.query("SELECT pdf, pdf_nome FROM vm_manuais WHERE id = $1", [id]);
  if (!rows[0] || !rows[0].pdf) throw erro(404, "Este manual não tem o PDF original guardado.");
  return { dados: rows[0].pdf, nome: rows[0].pdf_nome || "manual.pdf" };
}
async function retomarManuais() {
  const r = await pool.query("UPDATE vm_manuais SET status = 'erro', erro = 'A leitura foi interrompida (servidor reiniciado). Peça a leitura de novo.' WHERE status = 'processando' AND atualizado_em < now() - interval '10 minutes'");
  return r.rowCount;
}

module.exports = { listarManuais, criarManual, editarManual, salvarPdf, receberPaginas, extrair, processarManual, detalheManual, criarCriterio, editarCriterio, excluirCriterio, homologar, publicar, excluirManual, paginaImagem, baixarPdf, retomarManuais, gastoHoje, logIA, problemasPublicacao };
