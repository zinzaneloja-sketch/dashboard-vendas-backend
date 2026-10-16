const { pool } = require("../db");
const { PERFIS, ETAPAS, TRAVAS, ITEM_CAMPOS, etapaPorNumero, numeroDe } = require("./etapas");
const { minutosUteis, diaLocal, expediente } = require("./tempo");

const TOTAL_ETAPAS = ETAPAS.length;
// Rótulo de uma linha de produto: modelo / cor / tamanho
const rotulo = (i) => [i.modelo, i.cor, i.tamanho].filter(Boolean).join(" / ");

function erro(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
function inteiro(v, nome, { min = 0 } = {}) {
  if (v === "" || v === null || v === undefined) throw erro(400, `${nome}: informe um número.`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw erro(400, `${nome}: informe um número inteiro maior ou igual a ${min}.`);
  return n;
}

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

// ---------- configuração (metas de tempo editáveis) ----------
async function etapasConfig(db = pool) {
  const { rows } = await db.query("SELECT etapa, sla_exec_min, sla_fila_min FROM cd_etapa_config");
  const over = new Map(rows.map((r) => [r.etapa, r]));
  return ETAPAS.map((e) => {
    const o = over.get(e.n);
    return { ...e, sla_exec_min: o ? o.sla_exec_min : e.sla_exec_min, sla_fila_min: o ? o.sla_fila_min : e.sla_fila_min };
  });
}

async function configPublica() {
  return {
    perfis: PERFIS,
    etapas: await etapasConfig(),
    travas: TRAVAS,
    itemCampos: ITEM_CAMPOS,
    expediente: { inicio: expediente.inicioMin, fim: expediente.fimMin, dias: expediente.dias },
  };
}

async function salvarConfigEtapas(itens) {
  if (!Array.isArray(itens) || !itens.length) throw erro(400, "Envie a lista de metas.");
  return comTransacao(async (c) => {
    for (const it of itens) {
      const n = inteiro(it.etapa, "Etapa", { min: 1 });
      if (!etapaPorNumero(n)) throw erro(400, `Etapa ${n} não existe.`);
      const ex = inteiro(it.sla_exec_min, `Meta de execução da etapa ${n}`, { min: 1 });
      const fi = inteiro(it.sla_fila_min, `Meta de espera da etapa ${n}`, { min: 1 });
      await c.query(
        `INSERT INTO cd_etapa_config (etapa, sla_exec_min, sla_fila_min) VALUES ($1,$2,$3)
         ON CONFLICT (etapa) DO UPDATE SET sla_exec_min = EXCLUDED.sla_exec_min, sla_fila_min = EXCLUDED.sla_fila_min`,
        [n, ex, fi]
      );
    }
    return { ok: true };
  });
}

// ---------- permissões ----------
const podeAtuar = (acc, etapa) => acc.cd_perfis.includes("gestor") || acc.cd_perfis.includes(etapa.perfil);
const ehGestor = (acc) => acc.cd_perfis.includes("gestor");

async function evento(db, notaId, etapa, tipo, usuario, detalhe = {}) {
  await db.query("INSERT INTO cd_eventos (nota_id, etapa, tipo, usuario, detalhe) VALUES ($1,$2,$3,$4,$5)", [
    notaId, etapa, tipo, usuario, JSON.stringify(detalhe),
  ]);
}

async function travarNota(db, id) {
  const { rows } = await db.query("SELECT * FROM cd_notas WHERE id = $1 FOR UPDATE", [id]);
  if (!rows[0]) throw erro(404, "Nota não encontrada.");
  return rows[0];
}

// ---------- criar nota (= etapa 1) ----------
async function criarNota(acc, b) {
  const e1 = etapaPorNumero(1);
  if (!podeAtuar(acc, e1)) throw erro(403, "Seu perfil não registra recebimento de NF.");
  const numero_nf = txt(b.numero_nf);
  const fornecedor = txt(b.fornecedor);
  if (!numero_nf) throw erro(400, "Informe o número da NF.");
  if (!fornecedor) throw erro(400, "Informe o fornecedor.");
  const chave = txt(b.chave_nf).replace(/\s+/g, "");
  if (chave && !/^\d{44}$/.test(chave)) throw erro(400, "A chave da NF-e deve ter 44 números.");
  const total = inteiro(b.total_pecas_nf, "Total de peças da NF", { min: 1 });
  const volNf = inteiro(b.volumes_nf, "Volumes na NF", { min: 1 });
  const volRec = inteiro(b.volumes_recebidos, "Volumes recebidos", { min: 0 });
  const justificativa = txt(b.justificativa);
  const diverge = volRec !== volNf;
  if (diverge && justificativa.length < 5) {
    throw erro(422, `Volumes recebidos (${volRec}) diferem da NF (${volNf}). Explique a diferença para registrar.`);
  }
  const prioridade = b.prioridade === "urgente" ? "urgente" : "normal";

  return comTransacao(async (c) => {
    let nota;
    try {
      const r = await c.query(
        `INSERT INTO cd_notas (numero_nf, serie, fornecedor, chave_nf, total_pecas_nf, volumes_nf, prioridade, observacao, criada_por, com_divergencia, etapa_atual)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2) RETURNING *`,
        [numero_nf, txt(b.serie) || null, fornecedor, chave || null, total, volNf, prioridade, txt(b.observacao) || null, acc.email, diverge]
      );
      nota = r.rows[0];
    } catch (e) {
      if (e.code === "23505") throw erro(409, "Essa NF já foi registrada (mesmo número/série/fornecedor ou mesma chave).");
      throw e;
    }
    const dados1 = { volumes_recebidos: volRec, avarias: txt(b.avarias) || null, justificativa: justificativa || null };
    await c.query(
      `INSERT INTO cd_nota_etapas (nota_id, etapa, status, liberada_em, iniciada_em, iniciada_por, concluida_em, concluida_por, dados, divergencia)
       VALUES ($1,1,'concluida', now(), now(), $2, now(), $2, $3, $4)`,
      [nota.id, acc.email, JSON.stringify(dados1), diverge]
    );
    for (let n = 2; n <= TOTAL_ETAPAS; n++) {
      await c.query("INSERT INTO cd_nota_etapas (nota_id, etapa, status, liberada_em) VALUES ($1,$2,'pendente',$3)", [
        nota.id, n, n === 2 ? new Date() : null,
      ]);
    }
    await evento(c, nota.id, 1, "nota_criada", acc.email, {
      numero_nf, serie: txt(b.serie) || null, fornecedor, total_pecas_nf: total, volumes_nf: volNf, volumes_recebidos: volRec,
      prioridade, ...(diverge ? { divergencia: { tipo: "volumes", esperado: volNf, obtido: volRec, justificativa } } : {}),
    });
    return { id: nota.id };
  });
}

// ---------- iniciar ----------
async function iniciarEtapa(acc, notaId, n) {
  const def = etapaPorNumero(n);
  if (!def) throw erro(404, "Etapa inexistente.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status !== "aberta") throw erro(409, "Essa nota não está aberta.");
    if (nota.etapa_atual !== def.n) throw erro(409, `A nota está na etapa ${nota.etapa_atual}. Só é possível iniciar a etapa atual.`);
    if (!podeAtuar(acc, def)) throw erro(403, `Etapa ${def.n} é do perfil "${PERFIS[def.perfil]}".`);
    const { rows } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2 FOR UPDATE", [notaId, def.n]);
    if (rows[0].status !== "pendente") throw erro(409, "Essa etapa já foi iniciada.");
    await c.query("UPDATE cd_nota_etapas SET status = 'em_andamento', iniciada_em = now(), iniciada_por = $3 WHERE nota_id = $1 AND etapa = $2", [
      notaId, def.n, acc.email,
    ]);
    await evento(c, notaId, def.n, "etapa_iniciada", acc.email, {});
    return { ok: true };
  });
}

// ---------- itens (modelo/cor/tamanho) ----------
async function salvarItens(acc, notaId, n, { itens = [], remover = [], dados } = {}) {
  const def = etapaPorNumero(n);
  if (!def || !def.itens) throw erro(400, "Essa etapa não tem itens para preencher.");
  const cadastra = def.chave === "separacao"; // só a separação cria/remove linhas
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status !== "aberta" || nota.etapa_atual !== def.n) throw erro(409, "Essa etapa não está disponível para edição.");
    if (!podeAtuar(acc, def)) throw erro(403, "Seu perfil não edita esta etapa.");
    const { rows: er } = await c.query("SELECT status FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    if (er[0].status !== "em_andamento") throw erro(409, "Inicie a etapa antes de preencher.");

    const { rows: atuais } = await c.query("SELECT * FROM cd_nota_itens WHERE nota_id = $1 ORDER BY id", [notaId]);
    const porId = new Map(atuais.map((i) => [String(i.id), i]));
    const permitidos = def.itens;
    const mudancas = [];

    const valor = (campo, v) => {
      const tipo = ITEM_CAMPOS[campo];
      if (tipo === "int") return v === "" || v === null || v === undefined ? null : inteiro(v, campo);
      if (tipo === "bool") return v === true || v === "true" || v === 1;
      return txt(v) || null;
    };

    // Dados parciais da etapa (ex.: contador de fardos abertos), gravados na hora para não se perder
    if (dados && typeof dados === "object" && def.chave === "separacao") {
      const { rows: er2 } = await c.query("SELECT dados FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
      const atualD = er2[0].dados || {};
      const novoD = { ...atualD };
      if ("fardos_abertos" in dados) {
        novoD.fardos_abertos = dados.fardos_abertos === "" || dados.fardos_abertos === null ? null : inteiro(dados.fardos_abertos, "Fardos abertos");
      }
      if ("avarias" in dados) novoD.avarias = txt(dados.avarias) || null;
      if (JSON.stringify(novoD) !== JSON.stringify(atualD)) {
        await c.query("UPDATE cd_nota_etapas SET dados = $3 WHERE nota_id = $1 AND etapa = $2", [notaId, def.n, JSON.stringify(novoD)]);
        if (novoD.fardos_abertos !== atualD.fardos_abertos) {
          mudancas.push({ acao: "fardos_abertos", de: atualD.fardos_abertos ?? null, para: novoD.fardos_abertos ?? null });
        }
      }
    }

    if (cadastra) {
      for (const id of remover) {
        if (!porId.has(String(id))) continue;
        const it = porId.get(String(id));
        await c.query("DELETE FROM cd_nota_itens WHERE id = $1 AND nota_id = $2", [id, notaId]);
        porId.delete(String(id));
        mudancas.push({ acao: "removido", modelo: it.modelo, cor: it.cor, tamanho: it.tamanho });
      }
    }
    for (const raw of itens) {
      if (raw.id && porId.has(String(raw.id))) {
        const cur = porId.get(String(raw.id));
        const sets = [];
        const vals = [];
        for (const campo of permitidos) {
          if (!(campo in raw)) continue;
          const novo = valor(campo, raw[campo]);
          if (campo === "modelo" || campo === "cor" || campo === "tamanho") {
            if (!novo) throw erro(400, "Modelo, cor e tamanho são obrigatórios.");
          }
          if (campo === "amostra_separada" ? Boolean(cur[campo]) === novo : (cur[campo] ?? null) === novo) continue;
          vals.push(novo);
          sets.push(`${campo} = $${vals.length}`);
          mudancas.push({ item: cur.id, modelo: cur.modelo, cor: cur.cor, tamanho: cur.tamanho, campo, de: cur[campo] ?? null, para: novo });
        }
        if (sets.length) {
          vals.push(raw.id, notaId);
          await c.query(`UPDATE cd_nota_itens SET ${sets.join(", ")} WHERE id = $${vals.length - 1} AND nota_id = $${vals.length}`, vals);
        }
      } else if (cadastra && !raw.id) {
        const modelo = txt(raw.modelo);
        const cor = txt(raw.cor);
        const tamanho = txt(raw.tamanho);
        if (!modelo || !cor || !tamanho) throw erro(400, "Informe modelo, cor e tamanho.");
        const dup = [...porId.values()].some((i) => i.modelo.toLowerCase() === modelo.toLowerCase() && i.cor.toLowerCase() === cor.toLowerCase() && String(i.tamanho || "").toLowerCase() === tamanho.toLowerCase());
        if (dup) throw erro(409, `${modelo} / ${cor} / ${tamanho} já está na lista.`);
        const r = await c.query("INSERT INTO cd_nota_itens (nota_id, modelo, cor, tamanho) VALUES ($1,$2,$3,$4) RETURNING *", [notaId, modelo, cor, tamanho]);
        porId.set(String(r.rows[0].id), r.rows[0]);
        mudancas.push({ acao: "incluido", modelo, cor, tamanho });
      }
    }
    if (mudancas.length) await evento(c, notaId, def.n, "itens_atualizados", acc.email, { mudancas });
    return { ok: true, alteracoes: mudancas.length };
  });
}

// ---------- conferência (travas) ----------
const soma = (arr, k) => arr.reduce((s, i) => s + (Number(i[k]) || 0), 0);

/** Avalia se a etapa pode ser concluída. Não grava nada. */
function avaliarEtapa(def, nota, itens, etapasPorN, dados) {
  const erros = [];
  const divergencias = [];
  const d = dados || {};

  for (const c of def.campos || []) {
    const v = d[c.k];
    if (c.obrigatorio && (v === undefined || v === null || String(v).trim() === "")) erros.push(`Preencha "${c.label}".`);
    else if (c.tipo === "int" && v !== undefined && v !== null && String(v).trim() !== "") {
      const nn = Number(v);
      if (!Number.isInteger(nn) || nn < 0) erros.push(`"${c.label}" deve ser um número inteiro.`);
    }
  }

  if (def.itens) {
    if (!itens.length) erros.push("Cadastre pelo menos um modelo, cor e tamanho.");
    for (const campo of def.itens) {
      if (campo === "qtd_nf" || campo === "modelo" || campo === "cor" || campo === "tamanho" || campo === "justificativa_confronto") continue;
      const faltando = itens.filter((i) => {
        if (campo === "amostra_separada") return !i.amostra_separada;
        const v = i[campo];
        return v === null || v === undefined || String(v).trim() === "";
      });
      if (faltando.length) {
        const rot = {
          qtd_contada: "contagem", qtd_ficha: "quantidade da ficha", qtd_checkout: "quantidade do checkout",
          amostra_separada: "peça separada para o Estilo", cor_definida: "cor definida", ref_zinzane: "referência Zinzane",
        }[campo] || campo;
        erros.push(`Falta ${rot} em ${faltando.length} linha(s): ${faltando.slice(0, 4).map(rotulo).join(", ")}${faltando.length > 4 ? "…" : ""}.`);
      }
    }
  }

  const compara = (tipo, descricao, esperado, obtido, extra = {}) => {
    if (esperado !== obtido) divergencias.push({ tipo, descricao, esperado, obtido, diferenca: obtido - esperado, ...extra });
  };
  const e1 = (etapasPorN[numeroDe("recebimento")] || {}).dados || {};
  switch (def.trava) {
    case "fardos_vs_volumes":
      if (d.fardos_abertos !== undefined && d.fardos_abertos !== "") compara(def.trava, TRAVAS[def.trava], Number(e1.volumes_recebidos ?? nota.volumes_nf), Number(d.fardos_abertos));
      break;
    case "contagem_vs_nf":
      compara(def.trava, TRAVAS[def.trava], nota.total_pecas_nf, soma(itens, "qtd_contada"));
      for (const i of itens) if (i.qtd_nf !== null && i.qtd_contada !== null && i.qtd_nf !== i.qtd_contada) {
        divergencias.push({ tipo: "contagem_linha", descricao: `${rotulo(i)}: contado × NF`, esperado: i.qtd_nf, obtido: i.qtd_contada, diferenca: i.qtd_contada - i.qtd_nf });
      }
      break;
    case "ficha_vs_contagem":
      for (const i of itens) if (i.qtd_ficha !== null && i.qtd_contada !== null && i.qtd_ficha !== i.qtd_contada) {
        divergencias.push({ tipo: "ficha_linha", descricao: `${rotulo(i)}: ficha × contagem`, esperado: i.qtd_contada, obtido: i.qtd_ficha, diferenca: i.qtd_ficha - i.qtd_contada });
      }
      break;
    case "etiquetas_vs_ficha":
      if (d.etiquetas_impressas !== undefined && d.etiquetas_impressas !== "") compara(def.trava, TRAVAS[def.trava], soma(itens, "qtd_ficha"), Number(d.etiquetas_impressas));
      break;
    case "checkout_vs_ficha":
      for (const i of itens) if (i.qtd_checkout !== null && i.qtd_ficha !== null && i.qtd_checkout !== i.qtd_ficha) {
        divergencias.push({ tipo: "checkout_linha", item: i.id, descricao: `${rotulo(i)}: checkout × ficha`, esperado: i.qtd_ficha, obtido: i.qtd_checkout, diferenca: i.qtd_checkout - i.qtd_ficha, justificativa: i.justificativa_confronto || null });
      }
      break;
    case "distribuicao_vs_checkout":
      if (d.total_distribuido !== undefined && d.total_distribuido !== "") compara(def.trava, TRAVAS[def.trava], soma(itens, "qtd_checkout"), Number(d.total_distribuido));
      break;
    case "pack_vs_distribuicao": {
      const e13 = (etapasPorN[numeroDe("distribuicao")] || {}).dados || {};
      if (d.pecas_embaladas !== undefined && d.pecas_embaladas !== "") compara(def.trava, TRAVAS[def.trava], Number(e13.total_distribuido), Number(d.pecas_embaladas));
      break;
    }
    default:
  }

  let exigeGestor = false;
  if (def.chave === "confronto") {
    const semJust = divergencias.filter((x) => !x.justificativa || x.justificativa.length < 5);
    if (semJust.length) erros.push(`Justifique ${semJust.length} linha(s) com diferença entre checkout e ficha.`);
    if (divergencias.length) exigeGestor = true;
  } else if (divergencias.length && txt(d.justificativa).length < 5) {
    erros.push("Há divergência na conferência. Explique o motivo para concluir.");
  }
  return { erros, divergencias, exigeGestor };
}

async function carregarEstado(db, notaId) {
  const [{ rows: itens }, { rows: etapas }] = await Promise.all([
    db.query("SELECT * FROM cd_nota_itens WHERE nota_id = $1 ORDER BY id", [notaId]),
    db.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 ORDER BY etapa", [notaId]),
  ]);
  const porN = {};
  for (const e of etapas) porN[e.etapa] = e;
  return { itens, etapas, porN };
}

async function conferirEtapa(acc, notaId, n, dados) {
  const def = etapaPorNumero(n);
  if (!def) throw erro(404, "Etapa inexistente.");
  const { rows } = await pool.query("SELECT * FROM cd_notas WHERE id = $1", [notaId]);
  if (!rows[0]) throw erro(404, "Nota não encontrada.");
  const st = await carregarEstado(pool, notaId);
  // o que não vier na chamada vale o que já está gravado na etapa (ex.: contador de fardos salvo na hora)
  const guardados = (st.porN[def.n] || {}).dados || {};
  return avaliarEtapa(def, rows[0], st.itens, st.porN, { ...guardados, ...(dados || {}) });
}

// ---------- concluir ----------
async function concluirEtapa(acc, notaId, n, dados = {}) {
  const def = etapaPorNumero(n);
  if (!def) throw erro(404, "Etapa inexistente.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status !== "aberta") throw erro(409, "Essa nota não está aberta.");
    if (nota.etapa_atual !== def.n) throw erro(409, `A nota está na etapa ${nota.etapa_atual}.`);
    if (!podeAtuar(acc, def)) throw erro(403, `Etapa ${def.n} é do perfil "${PERFIS[def.perfil]}".`);
    const st = await carregarEstado(c, notaId);
    const atual = st.porN[def.n];
    if (atual.status !== "em_andamento") throw erro(409, "Inicie a etapa antes de concluir.");

    const limpo = {};
    for (const campo of def.campos || []) {
      const v = dados[campo.k] !== undefined ? dados[campo.k] : (atual.dados || {})[campo.k];
      limpo[campo.k] = campo.tipo === "int" ? (v === "" || v === undefined || v === null ? null : Number(v)) : txt(v) || null;
    }
    if (txt(dados.justificativa)) limpo.justificativa = txt(dados.justificativa);

    const av = avaliarEtapa(def, nota, st.itens, st.porN, limpo);
    if (av.erros.length) throw erro(422, av.erros[0], { erros: av.erros, divergencias: av.divergencias });
    if (av.exigeGestor && !ehGestor(acc)) {
      throw erro(403, "Há divergência entre checkout e ficha. Só o gestor pode encerrar esta etapa.", { divergencias: av.divergencias });
    }

    const diverge = av.divergencias.length > 0;
    limpo.divergencias = av.divergencias;
    await c.query(
      `UPDATE cd_nota_etapas SET status = 'concluida', concluida_em = now(), concluida_por = $3, dados = $4, divergencia = $5
       WHERE nota_id = $1 AND etapa = $2`,
      [notaId, def.n, acc.email, JSON.stringify(limpo), diverge]
    );
    const fim = def.n === TOTAL_ETAPAS;
    if (fim) {
      await c.query("UPDATE cd_notas SET status = 'concluida', concluida_em = now(), com_divergencia = com_divergencia OR $2 WHERE id = $1", [notaId, diverge]);
    } else {
      await c.query("UPDATE cd_notas SET etapa_atual = $2, com_divergencia = com_divergencia OR $3 WHERE id = $1", [notaId, def.n + 1, diverge]);
      await c.query("UPDATE cd_nota_etapas SET liberada_em = now() WHERE nota_id = $1 AND etapa = $2", [notaId, def.n + 1]);
    }
    await evento(c, notaId, def.n, "etapa_concluida", acc.email, {
      exec_min_uteis: minutosUteis(atual.iniciada_em, new Date()), dados: limpo, ...(diverge ? { divergencias: av.divergencias } : {}),
    });
    const nFicha = numeroDe("ficha");
    if (def.chave === "checkout" && st.porN[nFicha] && st.porN[nFicha].concluida_por === atual.iniciada_por) {
      await evento(c, notaId, def.n, "alerta_segregacao", acc.email, {
        mensagem: `A mesma pessoa preencheu a ficha (etapa ${nFicha}) e fez o checkout (etapa ${def.n}).`, usuario: acc.email,
      });
    }
    return { ok: true, nota_concluida: fim };
  });
}

// ---------- reabrir / cancelar / comentar ----------
async function reabrirEtapa(acc, notaId, n, motivo) {
  if (!ehGestor(acc)) throw erro(403, "Somente o gestor pode reabrir uma etapa.");
  const def = etapaPorNumero(n);
  if (!def || def.n === 1) throw erro(400, "Essa etapa não pode ser reaberta.");
  if (txt(motivo).length < 5) throw erro(422, "Explique o motivo da reabertura.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status === "cancelada") throw erro(409, "Nota cancelada.");
    if (def.n > nota.etapa_atual) throw erro(409, "Essa etapa ainda não foi alcançada.");
    await c.query(
      `UPDATE cd_nota_etapas SET status = 'pendente', iniciada_em = NULL, iniciada_por = NULL, concluida_em = NULL, concluida_por = NULL, divergencia = false,
         liberada_em = CASE WHEN etapa = $2 THEN now() ELSE NULL END
       WHERE nota_id = $1 AND etapa >= $2`,
      [notaId, def.n]
    );
    await c.query("UPDATE cd_notas SET status = 'aberta', etapa_atual = $2, concluida_em = NULL WHERE id = $1", [notaId, def.n]);
    await evento(c, notaId, def.n, "etapa_reaberta", acc.email, { motivo: txt(motivo), etapas_reiniciadas: `${def.n} a ${TOTAL_ETAPAS}` });
    return { ok: true };
  });
}

async function cancelarNota(acc, notaId, motivo) {
  if (!ehGestor(acc)) throw erro(403, "Somente o gestor cancela uma nota.");
  if (txt(motivo).length < 5) throw erro(422, "Explique o motivo do cancelamento.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status !== "aberta") throw erro(409, "Só é possível cancelar nota aberta.");
    await c.query("UPDATE cd_notas SET status = 'cancelada', concluida_em = now() WHERE id = $1", [notaId]);
    await evento(c, notaId, nota.etapa_atual, "nota_cancelada", acc.email, { motivo: txt(motivo) });
    return { ok: true };
  });
}

async function comentar(acc, notaId, texto, etapa) {
  if (txt(texto).length < 2) throw erro(400, "Escreva o comentário.");
  const { rows } = await pool.query("SELECT id, etapa_atual FROM cd_notas WHERE id = $1", [notaId]);
  if (!rows[0]) throw erro(404, "Nota não encontrada.");
  await evento(pool, notaId, etapa ? Number(etapa) : rows[0].etapa_atual, "comentario", acc.email, { texto: txt(texto) });
  return { ok: true };
}

// ---------- leitura ----------
function resumoTempo(def, linha, agora) {
  // linha = cd_nota_etapas da etapa atual
  const aguardando = linha.status === "pendente";
  const desde = aguardando ? linha.liberada_em : linha.iniciada_em;
  const minutos = desde ? minutosUteis(desde, agora) : 0;
  const meta = aguardando ? def.sla_fila_min : def.sla_exec_min;
  return { estado: aguardando ? "aguardando" : "em_andamento", desde, minutos, meta, atrasada: minutos > meta };
}

async function listarNotas({ status = "aberta", q, limit = 100 } = {}) {
  const cfg = await etapasConfig();
  const params = [];
  const where = [];
  if (status && status !== "todas") { params.push(status); where.push(`n.status = $${params.length}`); }
  if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(lower(n.numero_nf) LIKE $${params.length} OR lower(n.fornecedor) LIKE $${params.length})`); }
  params.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await pool.query(
    `SELECT n.*, e.status AS etapa_status, e.liberada_em, e.iniciada_em, e.iniciada_por
       FROM cd_notas n LEFT JOIN cd_nota_etapas e ON e.nota_id = n.id AND e.etapa = n.etapa_atual
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY n.criada_em DESC LIMIT $${params.length}`,
    params
  );
  const agora = new Date();
  return {
    notas: rows.map((n) => {
      const def = cfg.find((x) => x.n === n.etapa_atual);
      const t = n.status === "aberta" && def ? resumoTempo(def, { status: n.etapa_status, liberada_em: n.liberada_em, iniciada_em: n.iniciada_em }, agora) : null;
      return {
        id: n.id, numero_nf: n.numero_nf, serie: n.serie, fornecedor: n.fornecedor, total_pecas_nf: n.total_pecas_nf, prioridade: n.prioridade,
        status: n.status, etapa_atual: n.etapa_atual, etapa_nome: def && def.nome, perfil_atual: def && def.perfil, com_divergencia: n.com_divergencia,
        responsavel: n.etapa_status === "em_andamento" ? n.iniciada_por : null, criada_em: n.criada_em, concluida_em: n.concluida_em,
        tempo_total_min: minutosUteis(n.criada_em, n.concluida_em || agora), ...(t || {}),
      };
    }),
  };
}

async function detalheNota(acc, notaId) {
  const { rows } = await pool.query("SELECT * FROM cd_notas WHERE id = $1", [notaId]);
  const nota = rows[0];
  if (!nota) throw erro(404, "Nota não encontrada.");
  const cfg = await etapasConfig();
  const st = await carregarEstado(pool, notaId);
  const { rows: eventos } = await pool.query("SELECT id, etapa, tipo, usuario, detalhe, criado_em FROM cd_eventos WHERE nota_id = $1 ORDER BY criado_em ASC, id ASC", [notaId]);
  const agora = new Date();
  const etapas = cfg.map((def) => {
    const l = st.porN[def.n];
    const anterior = st.porN[def.n - 1];
    return {
      n: def.n, nome: def.nome, perfil: def.perfil, status: l.status, iniciada_em: l.iniciada_em, iniciada_por: l.iniciada_por,
      concluida_em: l.concluida_em, concluida_por: l.concluida_por, divergencia: l.divergencia, dados: l.dados,
      fila_min: l.iniciada_em && l.liberada_em ? minutosUteis(l.liberada_em, l.iniciada_em) : null,
      exec_min: l.concluida_em && l.iniciada_em ? minutosUteis(l.iniciada_em, l.concluida_em) : null,
      sla_exec_min: def.sla_exec_min, sla_fila_min: def.sla_fila_min,
      ...(nota.status === "aberta" && nota.etapa_atual === def.n ? { tempo: resumoTempo(def, l, agora) } : {}),
      _anterior: anterior ? anterior.status : null,
    };
  });
  const defAtual = cfg.find((d) => d.n === nota.etapa_atual);
  let conferencia = null;
  if (nota.status === "aberta" && defAtual && st.porN[defAtual.n].status === "em_andamento") {
    conferencia = avaliarEtapa(defAtual, nota, st.itens, st.porN, st.porN[defAtual.n].dados || {});
  }
  return {
    nota, etapas, itens: st.itens, eventos, conferencia,
    permissoes: {
      pode_atuar_etapa_atual: nota.status === "aberta" && defAtual ? podeAtuar(acc, defAtual) : false,
      gestor: ehGestor(acc),
    },
  };
}

// ---------- painel de movimentação ----------
async function painel(acc) {
  const cfg = await etapasConfig();
  const agora = new Date();
  const { rows: abertas } = await pool.query(
    `SELECT n.*, e.status AS etapa_status, e.liberada_em, e.iniciada_em, e.iniciada_por
       FROM cd_notas n JOIN cd_nota_etapas e ON e.nota_id = n.id AND e.etapa = n.etapa_atual
      WHERE n.status = 'aberta'`
  );
  const notas = abertas.map((n) => {
    const def = cfg.find((x) => x.n === n.etapa_atual);
    const t = resumoTempo(def, { status: n.etapa_status, liberada_em: n.liberada_em, iniciada_em: n.iniciada_em }, agora);
    return {
      id: n.id, status: "aberta", numero_nf: n.numero_nf, fornecedor: n.fornecedor, total_pecas_nf: n.total_pecas_nf, prioridade: n.prioridade, com_divergencia: n.com_divergencia,
      etapa_atual: n.etapa_atual, etapa_nome: def.nome, perfil_atual: def.perfil, proximo_perfil: (cfg.find((x) => x.n === n.etapa_atual + 1) || {}).perfil || null,
      responsavel: n.etapa_status === "em_andamento" ? n.iniciada_por : null, criada_em: n.criada_em,
      tempo_total_min: minutosUteis(n.criada_em, agora), ...t,
    };
  });
  notas.sort((a, b) => (b.atrasada - a.atrasada) || ((b.prioridade === "urgente") - (a.prioridade === "urgente")) || (b.minutos / b.meta - a.minutos / a.meta));

  const etapas = cfg.map((def) => {
    const aqui = notas.filter((n) => n.etapa_atual === def.n);
    const aguardando = aqui.filter((n) => n.estado === "aguardando");
    const andamento = aqui.filter((n) => n.estado === "em_andamento");
    return {
      n: def.n, nome: def.nome, perfil: def.perfil, sla_exec_min: def.sla_exec_min, sla_fila_min: def.sla_fila_min,
      aguardando: aguardando.length, em_andamento: andamento.length, atrasadas: aqui.filter((x) => x.atrasada).length,
      pecas: aqui.reduce((s, x) => s + x.total_pecas_nf, 0), mais_antiga_min: aqui.length ? Math.max(...aqui.map((x) => x.minutos)) : 0,
    };
  });

  const hoje = diaLocal(agora);
  const { rows: concl } = await pool.query(
    "SELECT id, criada_em, concluida_em, com_divergencia FROM cd_notas WHERE status = 'concluida' AND concluida_em >= now() - interval '30 days'"
  );
  const leads = concl.map((n) => minutosUteis(n.criada_em, n.concluida_em));
  const resumo = {
    abertas: notas.length,
    atrasadas: notas.filter((n) => n.atrasada).length,
    com_divergencia: notas.filter((n) => n.com_divergencia).length,
    urgentes: notas.filter((n) => n.prioridade === "urgente").length,
    concluidas_hoje: concl.filter((n) => diaLocal(n.concluida_em) === hoje).length,
    concluidas_30d: concl.length,
    lead_time_medio_min: leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : null,
  };
  return { gerado_em: agora, resumo, etapas, notas };
}

async function gargalos({ dias = 30 } = {}) {
  const cfg = await etapasConfig();
  const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const { rows } = await pool.query(
    `SELECT nota_id, etapa, liberada_em, iniciada_em, concluida_em FROM cd_nota_etapas
      WHERE status = 'concluida' AND etapa > 1 AND concluida_em >= now() - ($1 || ' days')::interval`,
    [String(d)]
  );
  const por = new Map(cfg.map((c) => [c.n, { n: c.n, nome: c.nome, perfil: c.perfil, sla_exec_min: c.sla_exec_min, sla_fila_min: c.sla_fila_min, amostras: 0, exec: [], fila: [], estouros: 0, perda_min: 0 }]));
  for (const r of rows) {
    const b = por.get(r.etapa);
    if (!b || !r.iniciada_em) continue;
    const exec = minutosUteis(r.iniciada_em, r.concluida_em);
    const fila = r.liberada_em ? minutosUteis(r.liberada_em, r.iniciada_em) : 0;
    b.amostras++; b.exec.push(exec); b.fila.push(fila);
    const exExec = Math.max(0, exec - b.sla_exec_min);
    const exFila = Math.max(0, fila - b.sla_fila_min);
    if (exExec > 0 || exFila > 0) b.estouros++;
    b.perda_min += exExec + exFila;
  }
  // notas abertas hoje também pesam: estão estourando agora
  const p = await painel({ cd_perfis: ["gestor"] });
  for (const n of p.notas) {
    const b = por.get(n.etapa_atual);
    if (n.atrasada) { b.perda_min += n.minutos - n.meta; b.estouros++; b.amostras++; (n.estado === "aguardando" ? b.fila : b.exec).push(n.minutos); }
  }
  const media = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const lista = [...por.values()].map((b) => ({
    n: b.n, nome: b.nome, perfil: b.perfil, amostras: b.amostras, sla_exec_min: b.sla_exec_min, sla_fila_min: b.sla_fila_min,
    exec_medio_min: media(b.exec), fila_media_min: media(b.fila), exec_max_min: b.exec.length ? Math.round(Math.max(...b.exec)) : null,
    fila_max_min: b.fila.length ? Math.round(Math.max(...b.fila)) : null, estouros: b.estouros,
    pct_no_prazo: b.amostras ? Math.round(((b.amostras - b.estouros) / b.amostras) * 100) : null, perda_min: Math.round(b.perda_min),
  }));
  const ranking = [...lista].filter((x) => x.perda_min > 0).sort((a, b) => b.perda_min - a.perda_min).slice(0, 3).map((x) => x.n);
  const { rows: lt } = await pool.query(
    "SELECT criada_em, concluida_em FROM cd_notas WHERE status = 'concluida' AND concluida_em >= now() - ($1 || ' days')::interval", [String(d)]
  );
  const leads = lt.map((n) => minutosUteis(n.criada_em, n.concluida_em));
  return { dias: d, etapas: lista, ranking, notas_concluidas: lt.length, lead_time_medio_min: leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : null };
}

module.exports = {
  configPublica, salvarConfigEtapas, criarNota, iniciarEtapa, salvarItens, conferirEtapa, concluirEtapa, reabrirEtapa, cancelarNota,
  comentar, listarNotas, detalheNota, painel, gargalos,
};
