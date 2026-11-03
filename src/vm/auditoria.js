// Motor B: auditoria diária por foto. A loja envia a foto de cada ambiente, a IA avalia critério a critério,
// e o SISTEMA calcula a nota e decide aprovado / reprovado / revisão humana (ver calc.js).
const { pool } = require("../db");
const ia = require("./ia");
const core = require("./vm");
const man = require("./manuais");
const { calcular, norm } = require("./calc");
const { erro, txt, comTransacao, evento, papelDe, exigirVM, exigirGestao, escopoLoja, getConfig, hojeISO } = core;

const bufDe = (b64) => Buffer.from(String(b64 || "").replace(/^data:[^,]*,/, ""), "base64");
function tipoImagem(b) {
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
const efetivo = (a) => a.revisado_resultado || a.resultado;
const TAMANHO_MAX = () => Number(process.env.VM_FOTO_MAX_BYTES || 4 * 1024 * 1024);

async function manualVigente(clusterId, data, q = pool) {
  const { rows } = await q.query(`SELECT id::int AS id, titulo, versao FROM vm_manuais WHERE cluster_id = $1 AND status = 'vigente' AND (vigencia_inicio IS NULL OR vigencia_inicio <= $2::date) AND (vigencia_fim IS NULL OR vigencia_fim >= $2::date)
    ORDER BY vigencia_inicio DESC NULLS LAST, id DESC LIMIT 1`, [clusterId, data]);
  return rows[0] || null;
}
const criteriosDo = async (manualId, q = pool) => (await q.query("SELECT id::int AS id, ambiente, descricao, tipo, peso, critico, pagina, referencia_pagina, excecoes FROM vm_criterios WHERE manual_id = $1 AND status = 'homologado' ORDER BY ordem, id", [manualId])).rows;

// ---------- cálculo e persistência do resultado ----------
async function carregarBase(audId, q = pool) {
  const { rows: au } = await q.query("SELECT id::int AS id, loja_id::int AS loja_id, data::text AS data, cluster_id::int AS cluster_id, manual_id::int AS manual_id, status, score::float AS score, decidido_em FROM vm_auditorias WHERE id = $1", [audId]);
  if (!au[0]) throw erro(404, "Auditoria não encontrada.");
  const a = au[0];
  const { rows: amb } = await q.query("SELECT id::int AS id, ambiente, obrigatorio FROM vm_checklists WHERE cluster_id = $1 AND ativo ORDER BY ordem, id", [a.cluster_id]);
  const { rows: fotos } = await q.query("SELECT id::int AS id, checklist_id::int AS checklist_id, ambiente, rodada, status, qualidade, observacao_ia FROM vm_fotos WHERE auditoria_id = $1 AND atual", [audId]);
  const crit = a.manual_id ? await criteriosDo(a.manual_id, q) : [];
  const { rows: av } = await q.query("SELECT v.id::int AS id, v.foto_id::int AS foto_id, v.criterio_id::int AS criterio_id, v.resultado, v.evidencia, v.orientacao, v.revisado_resultado FROM vm_avaliacoes v JOIN vm_fotos f ON f.id = v.foto_id WHERE f.auditoria_id = $1 AND f.atual", [audId]);
  return { a, amb, fotos, crit, av };
}
async function recalcular(audId) {
  const { a, amb, fotos, crit, av } = await carregarBase(audId);
  const cfg = await getConfig();
  const r = calcular({ ambientes: amb, fotos, criterios: crit, avaliacoes: av, config: cfg });
  if (a.decidido_em) { await pool.query("UPDATE vm_auditorias SET score = $2, motivos = $3, limiar = $4, atualizada_em = now() WHERE id = $1", [audId, r.score, JSON.stringify(r.motivos), cfg.limiar_aprovacao]); return { ...r, status: a.status }; }
  await pool.query("UPDATE vm_auditorias SET status = $2, score = $3, motivos = $4, limiar = $5, atualizada_em = now() WHERE id = $1", [audId, r.status, r.score, JSON.stringify(r.motivos), cfg.limiar_aprovacao]);
  if (r.status !== a.status) await evento(null, { auditoria_id: audId, tipo: "status", detalhe: { de: a.status, para: r.status, score: r.score } });
  return r;
}

// ---------- tela da loja ----------
async function montarAmbientes(a, amb, crit, fotosAtuais, avaliacoes, cfg, travada) {
  return amb.map((k) => {
    const cs = crit.filter((c) => norm(c.ambiente) === norm(k.ambiente));
    const f = fotosAtuais.find((x) => Number(x.checklist_id) === k.id) || fotosAtuais.find((x) => norm(x.ambiente) === norm(k.ambiente)) || null;
    const avs = f ? avaliacoes.filter((v) => Number(v.foto_id) === Number(f.id)).map((v) => { const c = crit.find((x) => Number(x.id) === Number(v.criterio_id)); return { criterio_id: v.criterio_id, descricao: c && c.descricao, critico: !!(c && c.critico), resultado: efetivo(v), evidencia: v.evidencia, orientacao: v.orientacao, revisado: !!v.revisado_resultado }; }) : [];
    const ok = !!f && f.status === "analisada" && avs.length > 0 && avs.every((v) => v.resultado === "conforme");
    const proxima = f ? f.rodada + 1 : 1;
    let bloqueio = null;
    if (travada) bloqueio = "Esta auditoria já foi encerrada.";
    else if (f && ["recebida", "analisando"].includes(f.status)) bloqueio = "Foto em análise.";
    else if (f && ["erro_ia", "ia_indisponivel"].includes(f.status)) bloqueio = "A análise será refeita automaticamente.";
    else if (ok) bloqueio = "Ambiente conforme.";
    else if (proxima > 1 + cfg.max_reenvios) bloqueio = "Limite de reenvios atingido. A equipe de VM vai revisar.";
    const refs = [...new Set(cs.map((c) => c.referencia_pagina || c.pagina).filter(Boolean))].slice(0, 4);
    return { id: k.id, ambiente: k.ambiente, descricao: k.descricao || null, obrigatorio: k.obrigatorio, referencias: refs,
      criterios: cs.map((c) => ({ id: c.id, descricao: c.descricao, critico: c.critico, peso: c.peso, excecoes: c.excecoes })),
      foto: f ? { id: f.id, rodada: f.rodada, status: f.status, qualidade: f.qualidade, observacao: f.observacao_ia, enviado_em: f.enviado_em, avaliacoes: avs } : null,
      conforme: ok, reenvios_restantes: Math.max(0, 1 + cfg.max_reenvios - (f ? f.rodada : 0)), pode_enviar: !bloqueio, bloqueio };
  });
}
async function hoje(acc) {
  const p = await papelDe(acc); if (p.papel !== "loja") throw erro(403, "A tela do dia é da loja.");
  const data = hojeISO(); const cfg = await getConfig();
  const base = { data, loja: { id: p.loja.id, nome: p.loja.nome, cluster_nome: p.loja.cluster_nome }, config: { limiar: cfg.limiar_aprovacao, max_reenvios: cfg.max_reenvios } };
  if (!p.loja.cluster_id) return { ...base, estado: "sem_cluster", mensagem: "Sua loja ainda não foi vinculada a um cluster de VM." };
  const { rows: au } = await pool.query("SELECT id::int AS id FROM vm_auditorias WHERE loja_id = $1 AND data = $2::date", [p.loja.id, data]);
  let manual = null, aud = null;
  if (au[0]) { const b = await carregarBase(au[0].id); aud = b.a; if (aud.manual_id) { const { rows } = await pool.query("SELECT id::int AS id, titulo, versao FROM vm_manuais WHERE id = $1", [aud.manual_id]); manual = rows[0]; } }
  if (!manual) manual = await manualVigente(p.loja.cluster_id, data);
  if (!manual) return { ...base, estado: "sem_manual", mensagem: "Ainda não há manual de VM publicado para o seu cluster." };
  const { rows: amb } = await pool.query("SELECT id::int AS id, ambiente, descricao, obrigatorio FROM vm_checklists WHERE cluster_id = $1 AND ativo ORDER BY ordem, id", [aud ? aud.cluster_id : p.loja.cluster_id]);
  if (!amb.length) return { ...base, estado: "sem_checklist", mensagem: "O checklist do seu cluster ainda não foi configurado." };
  const crit = await criteriosDo(manual.id);
  let fotos = [], av = [], auditoria = null;
  if (aud) {
    const { rows: ft } = await pool.query("SELECT id::int AS id, checklist_id::int AS checklist_id, ambiente, rodada, status, qualidade, observacao_ia, enviado_em FROM vm_fotos WHERE auditoria_id = $1 AND atual", [aud.id]); fotos = ft;
    av = (await pool.query("SELECT v.foto_id::int AS foto_id, v.criterio_id::int AS criterio_id, v.resultado, v.evidencia, v.orientacao, v.revisado_resultado FROM vm_avaliacoes v JOIN vm_fotos f ON f.id = v.foto_id WHERE f.auditoria_id = $1 AND f.atual", [aud.id])).rows;
    const { rows: ar } = await pool.query("SELECT status, score::float AS score, motivos, limiar::float AS limiar, decidido_por, decidido_em, justificativa FROM vm_auditorias WHERE id = $1", [aud.id]); auditoria = { id: aud.id, ...ar[0] };
  }
  const travada = !!auditoria && (auditoria.status === "aprovada" || !!auditoria.decidido_em);
  return { ...base, estado: "ok", manual, auditoria, ambientes: await montarAmbientes(aud || {}, amb, crit, fotos, av, cfg, travada) };
}
async function historico(acc) {
  const p = await papelDe(acc); if (p.papel !== "loja") throw erro(403, "O histórico por loja é da própria loja.");
  const { rows } = await pool.query("SELECT id::int AS id, data::text AS data, status, score::float AS score FROM vm_auditorias WHERE loja_id = $1 ORDER BY data DESC LIMIT 45", [p.loja.id]);
  return { historico: rows };
}

// ---------- envio de foto ----------
async function enviarFoto(acc, b) {
  const p = await papelDe(acc); if (p.papel !== "loja") throw erro(403, "Só a loja envia as fotos da auditoria.");
  if (!p.loja.cluster_id) throw erro(400, "Sua loja ainda não foi vinculada a um cluster de VM.");
  const buf = bufDe(b.base64); const mime = tipoImagem(buf);
  if (!mime) throw erro(400, "Envie uma foto em JPEG, PNG ou WebP.");
  if (buf.length > TAMANHO_MAX()) throw erro(400, "A foto é grande demais (máximo " + Math.round(TAMANHO_MAX() / 1048576) + " MB). Tente tirar de novo.");
  if (buf.length < 2000) throw erro(400, "A foto parece vazia ou corrompida. Tente tirar de novo.");
  const data = hojeISO(); const cfg = await getConfig();
  const fotoId = await comTransacao(async (c) => {
    const { rows: ck } = await c.query("SELECT id::int AS id, ambiente FROM vm_checklists WHERE id = $1 AND cluster_id = $2 AND ativo", [Number(b.checklist_id), p.loja.cluster_id]);
    if (!ck[0]) throw erro(400, "Ambiente inválido para a sua loja.");
    const manual = await manualVigente(p.loja.cluster_id, data, c);
    const { rows: ex } = await c.query("SELECT manual_id FROM vm_auditorias WHERE loja_id = $1 AND data = $2::date", [p.loja.id, data]);
    if (!ex[0] && !manual) throw erro(409, "Ainda não há manual de VM publicado para o seu cluster.");
    const { rows: au } = await c.query(`INSERT INTO vm_auditorias (loja_id, data, cluster_id, manual_id, status, limiar) VALUES ($1,$2::date,$3,$4,'pendente',$5)
      ON CONFLICT (loja_id, data) DO UPDATE SET atualizada_em = now() RETURNING id::int AS id, status, decidido_em, manual_id`, [p.loja.id, data, p.loja.cluster_id, manual && manual.id, cfg.limiar_aprovacao]);
    const aud = au[0];
    await c.query("SELECT 1 FROM vm_auditorias WHERE id = $1 FOR UPDATE", [aud.id]);
    if (aud.status === "aprovada" || aud.decidido_em) throw erro(409, "A auditoria de hoje já foi encerrada.");
    const { rows: atual } = await c.query("SELECT id::int AS id, rodada, status FROM vm_fotos WHERE auditoria_id = $1 AND checklist_id = $2 AND atual", [aud.id, ck[0].id]);
    const f = atual[0];
    if (f && ["recebida", "analisando"].includes(f.status)) throw erro(409, "A foto desse ambiente ainda está sendo analisada.");
    if (f && ["erro_ia", "ia_indisponivel"].includes(f.status)) throw erro(409, "A análise dessa foto será refeita automaticamente. Aguarde.");
    if (f && f.status === "analisada") {
      const { rows: av } = await c.query("SELECT resultado, revisado_resultado FROM vm_avaliacoes WHERE foto_id = $1", [f.id]);
      if (av.length && av.every((v) => efetivo(v) === "conforme")) throw erro(409, "Esse ambiente já está conforme. Não precisa enviar de novo.");
    }
    const rodada = f ? f.rodada + 1 : 1;
    if (rodada > 1 + cfg.max_reenvios) throw erro(409, "Você atingiu o limite de reenvios desse ambiente. A equipe de VM vai revisar.");
    if (f) await c.query("UPDATE vm_fotos SET atual = false WHERE id = $1", [f.id]);
    const ins = await c.query("INSERT INTO vm_fotos (auditoria_id, checklist_id, ambiente, rodada, mime, tamanho, dados, enviado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::int AS id", [aud.id, ck[0].id, ck[0].ambiente, rodada, mime, buf.length, buf, p.email]);
    await evento(c, { auditoria_id: aud.id, tipo: rodada > 1 ? "foto_reenviada" : "foto_enviada", usuario: p.email, detalhe: { ambiente: ck[0].ambiente, rodada, foto_id: ins.rows[0].id, tamanho: buf.length } });
    return { id: ins.rows[0].id, aud: aud.id };
  });
  await recalcular(fotoId.aud);
  setImmediate(() => analisarFoto(fotoId.id).catch((e) => console.error("[vm] analisarFoto", fotoId.id, e)));
  return { ok: true, foto_id: fotoId.id, auditoria_id: fotoId.aud };
}

// ---------- análise da foto pela IA ----------
async function analisarFoto(fotoId) {
  const { rows: tk } = await pool.query("UPDATE vm_fotos SET status = 'analisando', analisada_em = now() WHERE id = $1 AND status IN ('recebida','erro_ia','ia_indisponivel') RETURNING id::int AS id, auditoria_id::int AS auditoria_id, checklist_id::int AS checklist_id, ambiente, mime, dados", [fotoId]);
  if (!tk[0]) return;
  const f = tk[0];
  const fecha = async (st, extra = {}) => {
    await pool.query("UPDATE vm_fotos SET status = $2, qualidade = $3, observacao_ia = $4, ia_modelo = $5, ia_prompt_versao = $6, analisada_em = now() WHERE id = $1", [f.id, st, extra.qualidade || null, extra.obs || null, extra.modelo || null, extra.prompt || null]);
    await recalcular(f.auditoria_id);
  };
  try {
    const { rows: au } = await pool.query("SELECT a.manual_id::int AS manual_id, a.cluster_id::int AS cluster_id, c.nome AS cluster_nome, m.titulo, m.versao FROM vm_auditorias a JOIN vm_clusters c ON c.id = a.cluster_id LEFT JOIN vm_manuais m ON m.id = a.manual_id WHERE a.id = $1", [f.auditoria_id]);
    const a = au[0];
    const todos = await criteriosDo(a.manual_id);
    const crit = todos.filter((c) => norm(c.ambiente) === norm(f.ambiente));
    if (!crit.length) { await fecha("analisada", { qualidade: "utilizavel", obs: "Não há critérios homologados para este ambiente." }); return; }
    const cfg = await getConfig();
    if ((await man.gastoHoje()) >= cfg.teto_dia_usd) { await fecha("ia_indisponivel", { obs: "Limite diário de gasto com IA atingido." }); return; }
    const refs = [...new Set(crit.map((c) => c.referencia_pagina || c.pagina).filter(Boolean))].slice(0, 4);
    const content = [{ type: "text", text: `Ambiente: ${f.ambiente} (cluster ${a.cluster_nome}). Manual "${a.titulo}" versão ${a.versao}.\nCritérios homologados para avaliar:\n` + crit.map((c) => `[id=${c.id}] ${c.critico ? "(CRÍTICO) " : ""}peso ${c.peso} — ${c.descricao}${c.excecoes ? " — Exceções: " + c.excecoes : ""}`).join("\n") }];
    if (refs.length) {
      const { rows: pg } = await pool.query("SELECT pagina, imagem FROM vm_manual_paginas WHERE manual_id = $1 AND pagina = ANY($2::int[]) AND imagem IS NOT NULL ORDER BY pagina", [a.manual_id, refs]);
      for (const r of pg) { content.push({ type: "text", text: `Imagem de referência do manual (página ${r.pagina}):` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.imagem.toString("base64") } }); }
    }
    content.push({ type: "text", text: "FOTO DA LOJA a ser avaliada:" });
    content.push({ type: "image", source: { type: "base64", media_type: f.mime, data: f.dados.toString("base64") } });
    let r;
    try { r = await ia.fila(() => ia.chamar({ system: ia.SISTEMA_FOTO, content, ferramenta: ia.FERRAMENTA_FOTO, maxTokens: 3000 })); }
    catch (e) { await man.logIA("foto", f.id, null, false, e); throw e; }
    await man.logIA("foto", f.id, r, true);
    const out = r.input; const q = ["utilizavel", "parcial", "inutilizavel"].includes(out.qualidade_foto) ? out.qualidade_foto : null;
    if (!q || !Array.isArray(out.avaliacoes)) throw Object.assign(new Error("A IA devolveu um resultado fora do formato esperado."), { ia_invalido: true });
    await pool.query("DELETE FROM vm_avaliacoes WHERE foto_id = $1", [f.id]);
    if (q === "inutilizavel") { await fecha("foto_inutilizavel", { qualidade: q, obs: txt(out.motivo_qualidade, 400) || "A foto não permite avaliar o ambiente. Tire outra com mais luz e o ambiente inteiro visível.", modelo: r.modelo, prompt: ia.PROMPT_FOTO }); return; }
    const OK = ["conforme", "nao_conforme", "nao_verificavel"]; const usados = new Set();
    for (const v of out.avaliacoes) {
      const cid = Number(v.criterio_id); const c = crit.find((x) => x.id === cid); if (!c || usados.has(cid)) continue; usados.add(cid);
      const res = OK.includes(v.resultado) ? v.resultado : "nao_verificavel";
      await pool.query("INSERT INTO vm_avaliacoes (foto_id, auditoria_id, criterio_id, resultado, evidencia, orientacao) VALUES ($1,$2,$3,$4,$5,$6)", [f.id, f.auditoria_id, cid, res, txt(v.evidencia, 600) || null, res === "conforme" ? null : (txt(v.orientacao, 400) || null)]);
    }
    for (const c of crit) if (!usados.has(c.id)) await pool.query("INSERT INTO vm_avaliacoes (foto_id, auditoria_id, criterio_id, resultado, evidencia) VALUES ($1,$2,$3,'nao_verificavel','A IA não avaliou este critério nesta foto.')", [f.id, f.auditoria_id, c.id]);
    await fecha("analisada", { qualidade: q, obs: txt(out.motivo_qualidade, 400) || null, modelo: r.modelo, prompt: ia.PROMPT_FOTO });
  } catch (e) {
    console.error("[vm] análise da foto", f.id, e.message);
    await fecha(e.ia_indisponivel ? "ia_indisponivel" : "erro_ia", { obs: String(e.message).slice(0, 300) }).catch((x) => console.error("[vm] fecha", x));
  }
}
async function varrer(acc, { forcar = false } = {}) {
  if (acc) { const p = await papelDe(acc); exigirVM(p); }
  const idade = forcar ? "0 seconds" : "5 minutes";
  const { rows: pend } = await pool.query(`SELECT id::int AS id FROM vm_fotos WHERE atual AND ((status IN ('recebida','analisando') AND coalesce(analisada_em, enviado_em) < now() - $1::interval) OR (status = 'ia_indisponivel' AND analisada_em < now() - $2::interval)) ORDER BY id LIMIT 30`, [idade, forcar ? "0 seconds" : "2 minutes"]);
  for (const f of pend) { await pool.query("UPDATE vm_fotos SET status = 'recebida' WHERE id = $1 AND status IN ('recebida','analisando','ia_indisponivel')", [f.id]); setImmediate(() => analisarFoto(f.id).catch(() => {})); }
  const manuais = await man.retomarManuais();
  return { fotos_reenfileiradas: pend.length, manuais_interrompidos: manuais };
}

// ---------- listagem e detalhe para o VM e as regionais ----------
async function listarAuditorias(acc, q = {}) {
  const p = await papelDe(acc); exigirGestao(p);
  const params = []; const w = [escopoLoja(p, params)];
  const de = /^\d{4}-\d{2}-\d{2}$/.test(q.de || "") ? q.de : hojeISO(), ate = /^\d{4}-\d{2}-\d{2}$/.test(q.ate || "") ? q.ate : hojeISO();
  params.push(de); w.push(`a.data >= $${params.length}::date`); params.push(ate); w.push(`a.data <= $${params.length}::date`);
  if (q.status) { params.push(String(q.status)); w.push(`a.status = $${params.length}`); }
  if (q.cluster_id) { params.push(Number(q.cluster_id)); w.push(`a.cluster_id = $${params.length}`); }
  if (q.regional) { params.push(norm(q.regional)); w.push(`lower(trim(coalesce(l.regional,''))) = $${params.length}`); }
  if (q.loja_id) { params.push(Number(q.loja_id)); w.push(`l.id = $${params.length}`); }
  const { rows } = await pool.query(`SELECT a.id::int AS id, a.data::text AS data, a.status, a.score::float AS score, a.decidido_por, a.decidido_em, l.id::int AS loja_id, l.nome AS loja, l.regional, c.nome AS cluster,
      (SELECT count(*)::int FROM vm_fotos f WHERE f.auditoria_id = a.id AND f.atual) AS fotos, a.atualizada_em
    FROM vm_auditorias a JOIN ch_lojas l ON l.id = a.loja_id LEFT JOIN vm_clusters c ON c.id = a.cluster_id WHERE ${w.join(" AND ")}
    ORDER BY (a.status = 'revisao_humana') DESC, a.data DESC, l.nome LIMIT 300`, params);
  return { auditorias: rows, de, ate };
}
async function auditoriaAcessivel(p, id) {
  const params = [Number(id)]; const cond = escopoLoja(p, params);
  const { rows } = await pool.query(`SELECT a.id::int AS id, a.data::text AS data, a.status, a.score::float AS score, a.limiar::float AS limiar, a.motivos, a.decidido_por, a.decidido_em, a.justificativa, a.manual_id::int AS manual_id, a.cluster_id::int AS cluster_id, a.loja_id::int AS loja_id,
      l.nome AS loja, l.regional, c.nome AS cluster, m.titulo AS manual_titulo, m.versao AS manual_versao
    FROM vm_auditorias a JOIN ch_lojas l ON l.id = a.loja_id LEFT JOIN vm_clusters c ON c.id = a.cluster_id LEFT JOIN vm_manuais m ON m.id = a.manual_id WHERE a.id = $1 AND ${cond}`, params);
  if (!rows[0]) throw erro(404, "Auditoria não encontrada.");
  return rows[0];
}
async function detalheAuditoria(acc, id) {
  const p = await papelDe(acc);
  const a = await auditoriaAcessivel(p, id);
  const { rows: ft } = await pool.query("SELECT id::int AS id, checklist_id::int AS checklist_id, ambiente, rodada, atual, status, qualidade, observacao_ia, ia_modelo, ia_prompt_versao, enviado_por, enviado_em, tamanho FROM vm_fotos WHERE auditoria_id = $1 ORDER BY ambiente, rodada", [id]);
  const { rows: av } = await pool.query("SELECT v.id::int AS id, v.foto_id::int AS foto_id, v.criterio_id::int AS criterio_id, v.resultado, v.evidencia, v.orientacao, v.revisado_resultado, v.revisado_por, v.revisado_em, v.revisado_justificativa, k.descricao, k.critico, k.peso, k.ambiente, k.pagina, k.referencia_pagina FROM vm_avaliacoes v JOIN vm_criterios k ON k.id = v.criterio_id WHERE v.auditoria_id = $1 ORDER BY k.ordem, k.id", [id]);
  const { rows: ev } = await pool.query("SELECT tipo, usuario, detalhe, criado_em FROM vm_eventos WHERE auditoria_id = $1 ORDER BY id", [id]);
  const { rows: ck } = await pool.query("SELECT id::int AS id, ambiente, obrigatorio FROM vm_checklists WHERE cluster_id = $1 AND ativo ORDER BY ordem, id", [a.cluster_id]);
  const fotos = ft.map((f) => ({ ...f, avaliacoes: av.filter((v) => v.foto_id === f.id) }));
  return { auditoria: a, ambientes: ck.map((k) => ({ ...k, fotos: fotos.filter((f) => f.checklist_id === k.id || norm(f.ambiente) === norm(k.ambiente)) })), eventos: ev, pode_decidir: p.papel === "vm" };
}
async function fotoImagem(acc, fotoId) {
  const p = await papelDe(acc);
  const { rows } = await pool.query("SELECT auditoria_id::int AS aud, mime, dados FROM vm_fotos WHERE id = $1", [fotoId]);
  if (!rows[0]) throw erro(404, "Foto não encontrada.");
  await auditoriaAcessivel(p, rows[0].aud);
  return { mime: rows[0].mime, dados: rows[0].dados };
}
async function revisarAvaliacao(acc, avId, b) {
  const p = await papelDe(acc); exigirVM(p);
  const res = b.resultado; if (!["conforme", "nao_conforme", "nao_verificavel"].includes(res)) throw erro(400, "Resultado inválido.");
  const just = txt(b.justificativa, 500); if (just.length < 5) throw erro(400, "Explique o motivo da correção (mínimo 5 letras).");
  const { rows } = await pool.query("SELECT v.id, v.auditoria_id::int AS aud, v.resultado, a.decidido_em FROM vm_avaliacoes v JOIN vm_auditorias a ON a.id = v.auditoria_id WHERE v.id = $1", [avId]);
  if (!rows[0]) throw erro(404, "Avaliação não encontrada.");
  if (rows[0].decidido_em) throw erro(409, "Esta auditoria já tem decisão final. Desfaça a decisão para corrigir critérios.");
  await pool.query("UPDATE vm_avaliacoes SET revisado_resultado = $2, revisado_por = $3, revisado_em = now(), revisado_justificativa = $4 WHERE id = $1", [avId, res === rows[0].resultado ? null : res, p.email, just]);
  await evento(null, { auditoria_id: rows[0].aud, tipo: "avaliacao_revisada", usuario: p.email, detalhe: { avaliacao_id: avId, de: rows[0].resultado, para: res, justificativa: just } });
  return { ok: true, calculo: await recalcular(rows[0].aud) };
}
async function decidir(acc, audId, b) {
  const p = await papelDe(acc); exigirVM(p);
  const a = await auditoriaAcessivel(p, audId);
  if (b.decisao === "desfazer") {
    await pool.query("UPDATE vm_auditorias SET decidido_por = NULL, decidido_em = NULL, justificativa = NULL WHERE id = $1", [audId]);
    await evento(null, { auditoria_id: audId, tipo: "decisao_desfeita", usuario: p.email });
    return { ok: true, calculo: await recalcular(audId) };
  }
  if (!["aprovada", "reprovada"].includes(b.decisao)) throw erro(400, "Decisão inválida.");
  const just = txt(b.justificativa, 600); if (just.length < 5) throw erro(400, "Explique a decisão (mínimo 5 letras).");
  if (["pendente", "em_analise"].includes(a.status)) throw erro(409, "A auditoria ainda não recebeu todas as fotos ou está em análise.");
  await pool.query("UPDATE vm_auditorias SET status = $2, decidido_por = $3, decidido_em = now(), justificativa = $4, atualizada_em = now() WHERE id = $1", [audId, b.decisao, p.email, just]);
  await evento(null, { auditoria_id: audId, tipo: "decisao_humana", usuario: p.email, detalhe: { de: a.status, para: b.decisao, justificativa: just } });
  return { ok: true };
}
async function reprocessar(acc, audId) {
  const p = await papelDe(acc); exigirVM(p);
  const a = await auditoriaAcessivel(p, audId);
  if (a.decidido_em) throw erro(409, "Desfaça a decisão final antes de reprocessar.");
  const { rows } = await pool.query("UPDATE vm_fotos SET status = 'recebida' WHERE auditoria_id = $1 AND atual AND status IN ('analisada','foto_inutilizavel','erro_ia','ia_indisponivel') RETURNING id::int AS id", [audId]);
  if (!rows.length) throw erro(400, "Não há fotos para reprocessar.");
  await pool.query("DELETE FROM vm_avaliacoes WHERE foto_id = ANY($1::bigint[])", [rows.map((r) => r.id)]);
  await evento(null, { auditoria_id: audId, tipo: "reprocessada", usuario: p.email, detalhe: { fotos: rows.length } });
  await recalcular(audId);
  rows.forEach((r) => setImmediate(() => analisarFoto(r.id).catch(() => {})));
  return { ok: true, fotos: rows.length };
}

// ---------- painel ----------
async function dashboard(acc, q = {}) {
  const p = await papelDe(acc); exigirGestao(p);
  const hj = hojeISO();
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(q.ate || "") ? q.ate : hj;
  const de = /^\d{4}-\d{2}-\d{2}$/.test(q.de || "") ? q.de : new Date(new Date(ate + "T12:00:00Z").getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const par = []; const w = [escopoLoja(p, par)];
  if (q.cluster_id) { par.push(Number(q.cluster_id)); w.push(`l.vm_cluster_id = $${par.length}`); }
  if (q.regional) { par.push(norm(q.regional)); w.push(`lower(trim(coalesce(l.regional,''))) = $${par.length}`); }
  const lojaW = w.join(" AND ");
  const { rows: piloto } = await pool.query(`SELECT l.id::int AS id, l.nome, l.regional, c.nome AS cluster FROM ch_lojas l LEFT JOIN vm_clusters c ON c.id = l.vm_cluster_id WHERE l.ativa AND l.vm_ativo AND ${lojaW} ORDER BY l.nome`, par);
  const ids = piloto.map((l) => l.id);
  const base = { de, ate, hoje: hj, lojas_piloto: piloto.length };
  if (!ids.length) return { ...base, hoje_status: {}, periodo: {}, por_cluster: [], por_regional: [], motivos: [], serie: [], pendentes_hoje: [], fila_revisao: 0 };
  const { rows: ah } = await pool.query("SELECT loja_id::int AS loja_id, status, score::float AS score FROM vm_auditorias WHERE data = $1::date AND loja_id = ANY($2::bigint[])", [hj, ids]);
  const st = { aprovada: 0, reprovada: 0, revisao_humana: 0, em_analise: 0, ia_indisponivel: 0, pendente: 0 };
  for (const l of piloto) { const a = ah.find((x) => x.loja_id === l.id); st[a ? a.status : "pendente"]++; }
  const { rows: ap } = await pool.query("SELECT a.status, count(*)::int AS n FROM vm_auditorias a WHERE a.data BETWEEN $1::date AND $2::date AND a.loja_id = ANY($3::bigint[]) GROUP BY a.status", [de, ate, ids]);
  const periodo = {}; ap.forEach((r) => { periodo[r.status] = r.n; });
  const { rows: pc } = await pool.query(`SELECT coalesce(c.nome,'(sem cluster)') AS nome, count(*)::int AS auditorias, round(avg(a.score),1)::float AS score_medio, count(*) FILTER (WHERE a.status='aprovada')::int AS aprovadas, count(*) FILTER (WHERE a.status='reprovada')::int AS reprovadas
    FROM vm_auditorias a LEFT JOIN vm_clusters c ON c.id = a.cluster_id WHERE a.data BETWEEN $1::date AND $2::date AND a.loja_id = ANY($3::bigint[]) GROUP BY 1 ORDER BY 1`, [de, ate, ids]);
  const { rows: pr } = await pool.query(`SELECT coalesce(nullif(trim(l.regional),''),'(sem regional)') AS nome, count(*)::int AS auditorias, round(avg(a.score),1)::float AS score_medio, count(*) FILTER (WHERE a.status='aprovada')::int AS aprovadas, count(*) FILTER (WHERE a.status='reprovada')::int AS reprovadas
    FROM vm_auditorias a JOIN ch_lojas l ON l.id = a.loja_id WHERE a.data BETWEEN $1::date AND $2::date AND a.loja_id = ANY($3::bigint[]) GROUP BY 1 ORDER BY 1`, [de, ate, ids]);
  const { rows: mo } = await pool.query(`SELECT k.id::int AS criterio_id, k.ambiente, k.descricao, k.critico, count(*)::int AS vezes, count(DISTINCT a.loja_id)::int AS lojas
    FROM vm_avaliacoes v JOIN vm_fotos f ON f.id = v.foto_id JOIN vm_auditorias a ON a.id = f.auditoria_id JOIN vm_criterios k ON k.id = v.criterio_id
    WHERE a.data BETWEEN $1::date AND $2::date AND a.loja_id = ANY($3::bigint[]) AND coalesce(v.revisado_resultado, v.resultado) = 'nao_conforme' GROUP BY k.id, k.ambiente, k.descricao, k.critico ORDER BY vezes DESC, k.id LIMIT 10`, [de, ate, ids]);
  const { rows: se } = await pool.query(`SELECT a.data::text AS data, count(*)::int AS total, count(*) FILTER (WHERE a.status='aprovada')::int AS aprovadas, count(*) FILTER (WHERE a.status='reprovada')::int AS reprovadas, count(*) FILTER (WHERE a.status='revisao_humana')::int AS revisao
    FROM vm_auditorias a WHERE a.data BETWEEN $1::date AND $2::date AND a.loja_id = ANY($3::bigint[]) GROUP BY 1 ORDER BY 1`, [de, ate, ids]);
  const { rows: fr } = await pool.query("SELECT count(*)::int AS n FROM vm_auditorias WHERE status = 'revisao_humana' AND loja_id = ANY($1::bigint[])", [ids]);
  const pendentes = piloto.filter((l) => { const a = ah.find((x) => x.loja_id === l.id); return !a || a.status === "pendente"; }).map((l) => ({ id: l.id, nome: l.nome, regional: l.regional, cluster: l.cluster }));
  return { ...base, hoje_status: st, periodo, por_cluster: pc, por_regional: pr, motivos: mo, serie: se, pendentes_hoje: pendentes, fila_revisao: fr[0].n };
}
async function usoIA(acc) {
  const p = await papelDe(acc); exigirVM(p);
  const cfg = await getConfig();
  const { rows } = await pool.query(`SELECT tipo, count(*)::int AS chamadas, count(*) FILTER (WHERE NOT ok)::int AS falhas, coalesce(sum(custo_usd),0)::float AS custo, coalesce(round(avg(latencia_ms)),0)::int AS latencia_ms, coalesce(sum(tokens_in),0)::int AS tokens_in, coalesce(sum(tokens_out),0)::int AS tokens_out
    FROM vm_ia_log WHERE criado_em >= now() - interval '30 days' GROUP BY tipo ORDER BY tipo`);
  return { hoje_usd: await man.gastoHoje(), teto_dia_usd: cfg.teto_dia_usd, ultimos_30_dias: rows, modelo: ia.MODELO(), ia_configurada: ia.configurada() };
}

module.exports = { hoje, historico, enviarFoto, analisarFoto, recalcular, varrer, listarAuditorias, detalheAuditoria, fotoImagem, revisarAvaliacao, decidir, reprocessar, dashboard, usoIA, manualVigente };
