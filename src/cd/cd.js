const { pool } = require("../db");
const { PERFIS, FRENTE, ETAPAS, TRAVAS, ITEM_CAMPOS, TAMANHOS, TAMANHOS_INFO, tamanhoCanonico, etapaPorNumero, numeroDe } = require("./etapas");
const { minutosUteis, diaLocal, expediente } = require("./tempo");

const TOTAL_ETAPAS = ETAPAS.length;
// Rótulo de uma linha de produto: produto / referência do fornecedor / cor / tamanho
const rotulo = (i) => [i.modelo, i.ref_fornecedor, i.cor, i.tamanho].filter(Boolean).join(" / ");
const corTxtSep = (i) => (i.cor_codigo ? `${i.cor_codigo} ${i.cor}` : i.cor);
const chaveRef = (v) => String(v || "").trim().toLowerCase();

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
    tamanhos: TAMANHOS,
    tamanhos_info: TAMANHOS_INFO,
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
// Mesas do usuário: o consolidado (gestor) enxerga todas; os demais só as etapas dos próprios perfis.
const minhasEtapas = (acc) => ETAPAS.filter((e) => ehGestor(acc) || acc.cd_perfis.includes(e.perfil)).map((e) => e.n);
function exigirGestor(acc, o = "Essa visão") {
  if (!ehGestor(acc)) throw erro(403, `${o} é do consolidado. Sua mesa mostra só a sua fila e o seu histórico.`);
}
// Uma etapa está "no ar" quando foi liberada (ou já começou) e ainda não terminou.
const etapaAtiva = (nota, linha) => nota.status === "aberta" && !!linha && linha.status !== "concluida" && (!!linha.liberada_em || linha.status === "em_andamento");
// Contagem, referência e etiquetas rodam ao mesmo tempo: enquanto a nota está em qualquer uma delas, as três estão disponíveis.
function etapaDisponivel(nota, def, linha) {
  if (nota.status !== "aberta" || !linha || linha.status === "concluida") return false;
  if (nota.etapa_atual === def.n) return true;
  return !!def.paralela && FRENTE.includes(nota.etapa_atual) && !!(linha.liberada_em || linha.status === "em_andamento");
}
function exigirDisponivel(nota, def, linha, verbo = "usar") {
  if (nota.status !== "aberta") throw erro(409, "Essa nota não está aberta.");
  if (linha && linha.status === "concluida") throw erro(409, `A etapa ${def.n} já foi concluída.`);
  if (!etapaDisponivel(nota, def, linha)) throw erro(409, `A nota está na etapa ${nota.etapa_atual}. Só é possível ${verbo} a etapa liberada para a sua mesa.`);
}
const pecasEsperadas = (nota, nfItens) => (nfItens && nfItens.length ? nfItens.reduce((a, p) => a + (Number(p.qtd) || 0) * (Number(p.fator) || 1), 0) : Number(nota.total_pecas_nf) || 0);

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
  // Posição na fila de prioridade (1 = a primeira a ser atendida). Opcional.
  let ranking = null;
  if (b.ranking !== undefined && b.ranking !== null && String(b.ranking).trim() !== "") {
    ranking = Number(b.ranking);
    if (!Number.isInteger(ranking) || ranking < 1 || ranking > 999) throw erro(400, "Posição de prioridade: informe um número inteiro de 1 a 999.");
  }
  // Produtos lidos da NF (PDF/XML): código do fornecedor, descrição e quantidade. Opcional.
  const itensNf = [];
  if (Array.isArray(b.itens_nf)) {
    if (b.itens_nf.length > 500) throw erro(400, "A NF tem produtos demais (máximo 500 linhas).");
    for (const [k, it] of b.itens_nf.entries()) {
      const codigo = txt(it && it.codigo).slice(0, 60);
      if (!codigo) continue;
      const q = Number(it.qtd);
      const vu = Number(it.valor_unit);
      itensNf.push({
        ordem: k, codigo, descricao: txt(it.descricao).slice(0, 160) || null, qtd: Number.isFinite(q) && q >= 0 ? Math.round(q) : 0,
        fator: Number(it.fator) === 2 ? 2 : 1, // conjunto: cada unidade da NF são 2 peças
        valor_unit: Number.isFinite(vu) && vu >= 0 ? vu : null,
      });
    }
  }

  // Valor da NF: o informado ou, se vier com preço por produto, a soma (preço unitário × unidades da NF)
  let valorNf = b.valor_nf !== undefined && b.valor_nf !== "" && Number.isFinite(Number(b.valor_nf)) ? Number(b.valor_nf) : null;
  if (valorNf === null && itensNf.length && itensNf.every((x) => x.valor_unit !== null)) valorNf = Math.round(itensNf.reduce((a, x) => a + x.valor_unit * x.qtd, 0) * 100) / 100;

  return comTransacao(async (c) => {
    let nota;
    try {
      const r = await c.query(
        `INSERT INTO cd_notas (numero_nf, serie, fornecedor, chave_nf, total_pecas_nf, volumes_nf, prioridade, observacao, criada_por, com_divergencia, etapa_atual, valor_nf, ranking)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2,$11,$12) RETURNING *`,
        [numero_nf, txt(b.serie) || null, fornecedor, chave || null, total, volNf, prioridade, txt(b.observacao) || null, acc.email, diverge, valorNf, ranking]
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
    for (const it of itensNf) {
      await c.query("INSERT INTO cd_nota_nf_itens (nota_id, ordem, codigo, descricao, qtd, fator, valor_unit) VALUES ($1,$2,$3,$4,$5,$6,$7)", [nota.id, it.ordem, it.codigo, it.descricao, it.qtd, it.fator, it.valor_unit]);
    }
    await evento(c, nota.id, 1, "nota_criada", acc.email, {
      ...(itensNf.length ? { produtos_na_nf: itensNf.length } : {}),
      numero_nf, serie: txt(b.serie) || null, fornecedor, total_pecas_nf: total, volumes_nf: volNf, volumes_recebidos: volRec,
      prioridade, ...(ranking ? { ranking } : {}), ...(diverge ? { divergencia: { tipo: "volumes", esperado: volNf, obtido: volRec, justificativa } } : {}),
    });
    return { id: nota.id };
  });
}


// Etapa de referência: a cor definida já vem da separação. Preenche o que o Estilo não trocou.
async function preencherCorDefinida(db, notaId) {
  await db.query(
    `UPDATE cd_nota_itens SET cor_def_codigo = cor_codigo, cor_definida = cor_codigo || ' ' || cor
      WHERE nota_id = $1 AND cor_def_codigo IS NULL AND cor_codigo IS NOT NULL AND (cor_definida IS NULL OR cor_definida = '')`, [notaId]);
  await db.query("UPDATE cd_nota_itens SET cor_definida = cor WHERE nota_id = $1 AND cor_codigo IS NULL AND (cor_definida IS NULL OR cor_definida = '')", [notaId]);
}

// ---------- iniciar ----------
async function iniciarEtapa(acc, notaId, n) {
  const def = etapaPorNumero(n);
  if (!def) throw erro(404, "Etapa inexistente.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status !== "aberta") throw erro(409, "Essa nota não está aberta.");
    if (!podeAtuar(acc, def)) throw erro(403, `Etapa ${def.n} é da mesa "${PERFIS[def.perfil]}".`);
    const { rows } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2 FOR UPDATE", [notaId, def.n]);
    if (rows[0].status !== "pendente") throw erro(409, rows[0].status === "concluida" ? "Essa etapa já foi concluída." : "Essa etapa já foi iniciada.");
    exigirDisponivel(nota, def, rows[0], "iniciar");
    await c.query("UPDATE cd_nota_etapas SET status = 'em_andamento', iniciada_em = now(), iniciada_por = $3 WHERE nota_id = $1 AND etapa = $2", [
      notaId, def.n, acc.email,
    ]);
    if (def.chave === "referencia") await preencherCorDefinida(c, notaId);
    await evento(c, notaId, def.n, "etapa_iniciada", acc.email, {});
    return { ok: true };
  });
}

// Cor do catálogo (código + nome): a cor das linhas sempre vem daqui, nunca digitada.
async function corPorCodigo(db, codigo) {
  const { rows } = await db.query("SELECT codigo, nome FROM cd_cores WHERE codigo = $1 AND ativo", [txt(codigo)]);
  return rows[0] || null;
}
async function listarCores() {
  const { rows } = await pool.query("SELECT codigo, nome, nome_en FROM cd_cores WHERE ativo ORDER BY nome, codigo");
  return { cores: rows };
}
async function criarCor(acc, b) {
  if (!ehGestor(acc)) throw erro(403, "Somente o gestor cadastra cor nova.");
  const codigo = txt(b.codigo), nome = txt(b.nome).toUpperCase();
  if (!/^\d{1,6}$/.test(codigo)) throw erro(400, "O código da cor deve ter só números (ex.: 0001).");
  if (nome.length < 2) throw erro(400, "Informe o nome da cor.");
  const { rows } = await pool.query("INSERT INTO cd_cores (codigo, nome, ativo) VALUES ($1,$2,true) ON CONFLICT (codigo) DO NOTHING RETURNING codigo, nome", [codigo, nome]);
  if (!rows.length) throw erro(409, `O código ${codigo} já existe no catálogo.`);
  return rows[0];
}

// ---------- itens (produto/cor/tamanho) ----------
async function salvarItens(acc, notaId, n, { itens = [], remover = [], dados } = {}) {
  const def = etapaPorNumero(n);
  if (!def || !def.itens) throw erro(400, "Essa etapa não tem itens para preencher.");
  const cadastra = def.chave === "separacao"; // só a separação cria/remove linhas
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (!podeAtuar(acc, def)) throw erro(403, "Sua mesa não edita esta etapa.");
    const { rows: er } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    if (nota.status !== "aberta" || !etapaDisponivel(nota, def, er[0])) throw erro(409, "Essa etapa não está disponível para edição.");
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
      for (const k of ["trocar_composicao", "trocar_marca", "trocar_codbarras"]) {
        if (k in dados) novoD[k] = dados[k] === true || dados[k] === "true" || dados[k] === 1;
      }
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
        mudancas.push({ acao: "removido", modelo: it.modelo, ref_fornecedor: it.ref_fornecedor, cor: it.cor, tamanho: it.tamanho });
      }
    }
    for (const raw of itens) {
      if (raw.id && porId.has(String(raw.id))) {
        const cur = porId.get(String(raw.id));
        const sets = [];
        const vals = [];
        for (const campo of permitidos) {
          if (!(campo in raw)) continue;
          let novo = valor(campo, raw[campo]);
          if (campo === "cor_def_codigo") {
            if (!novo) continue;
            const cd = await corPorCodigo(c, novo);
            if (!cd) throw erro(400, `Cor ${novo} não existe no catálogo.`);
            if ((cur.cor_def_codigo ?? null) === cd.codigo) continue;
            vals.push(cd.codigo); sets.push(`cor_def_codigo = $${vals.length}`);
            vals.push(`${cd.codigo} ${cd.nome}`); sets.push(`cor_definida = $${vals.length}`);
            mudancas.push({ item: cur.id, modelo: cur.modelo, ref_fornecedor: cur.ref_fornecedor, tamanho: cur.tamanho, campo: "cor definida", de: cur.cor_definida ?? corTxtSep(cur), para: `${cd.codigo} ${cd.nome}` });
            continue;
          }
          if (campo === "cor_codigo") {
            if (!novo) { if (cur.cor_codigo) throw erro(400, "Escolha a cor."); continue; } // linha antiga ainda sem cor do catálogo
            const cr = await corPorCodigo(c, novo);
            if (!cr) throw erro(400, `Cor ${novo} não existe no catálogo.`);
            if ((cur.cor_codigo ?? null) === cr.codigo) continue;
            vals.push(cr.codigo); sets.push(`cor_codigo = $${vals.length}`);
            vals.push(cr.nome); sets.push(`cor = $${vals.length}`);
            mudancas.push({ item: cur.id, modelo: cur.modelo, ref_fornecedor: cur.ref_fornecedor, tamanho: cur.tamanho, campo: "cor", de: cur.cor_codigo ? `${cur.cor_codigo} ${cur.cor}` : cur.cor, para: `${cr.codigo} ${cr.nome}` });
            continue;
          }
          if (campo === "modelo" || campo === "cor" || campo === "tamanho") {
            if (!novo) throw erro(400, "Produto, cor e tamanho são obrigatórios.");
          }
          if (campo === "tamanho" && novo === cur.tamanho) continue; // valor antigo (ex.: "Único/PP") é tolerado até alguém trocar
          if (campo === "tamanho") {
            const canon = tamanhoCanonico(novo);
            if (!canon) throw erro(400, `Tamanho inválido. Use: ${TAMANHOS.join(", ")}.`);
            novo = canon;
          }
          if (campo === "amostra_separada" ? Boolean(cur[campo]) === novo : (cur[campo] ?? null) === novo) continue;
          vals.push(novo);
          sets.push(`${campo} = $${vals.length}`);
          mudancas.push({ item: cur.id, modelo: cur.modelo, ref_fornecedor: cur.ref_fornecedor, cor: cur.cor, tamanho: cur.tamanho, campo, de: cur[campo] ?? null, para: novo });
        }
        if (sets.length) {
          vals.push(raw.id, notaId);
          await c.query(`UPDATE cd_nota_itens SET ${sets.join(", ")} WHERE id = $${vals.length - 1} AND nota_id = $${vals.length}`, vals);
        }
      } else if (cadastra && !raw.id) {
        const modelo = txt(raw.modelo);
        const corRow = raw.cor_codigo ? await corPorCodigo(c, txt(raw.cor_codigo)) : null;
        if (!corRow) throw erro(400, "Escolha a cor na lista do catálogo (código e nome).");
        const cor = corRow.nome;
        const refForn = txt(raw.ref_fornecedor);
        const refZ = txt(raw.ref_zinzane) || null;
        const tamanho = tamanhoCanonico(raw.tamanho);
        if (!modelo) throw erro(400, "Informe o produto.");
        if (!refForn) throw erro(400, "Informe a referência do fornecedor (código do produto na NF).");
        if (!tamanho) throw erro(400, `Informe o tamanho (${TAMANHOS.join(", ")}).`);
        const dup = [...porId.values()].some((i) => chaveRef(i.ref_fornecedor) === chaveRef(refForn) && chaveRef(i.modelo) === chaveRef(modelo) && (i.cor_codigo ? i.cor_codigo === corRow.codigo : chaveRef(i.cor) === chaveRef(cor)) && chaveRef(i.tamanho) === chaveRef(tamanho));
        if (dup) throw erro(409, `${modelo} / ${refForn} / ${cor} / ${tamanho} já está na lista.`);
        const r = await c.query("INSERT INTO cd_nota_itens (nota_id, modelo, ref_fornecedor, cor, cor_codigo, tamanho, ref_zinzane, amostra_separada) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [notaId, modelo, refForn, cor, corRow.codigo, tamanho, refZ, raw.amostra_separada === true || raw.amostra_separada === "true"]);
        porId.set(String(r.rows[0].id), r.rows[0]);
        mudancas.push({ acao: "incluido", modelo, ref_fornecedor: refForn, cor: `${corRow.codigo} ${cor}`, tamanho });
      }
    }
    if (mudancas.length) await evento(c, notaId, def.n, "itens_atualizados", acc.email, { mudancas });
    return { ok: true, alteracoes: mudancas.length };
  });
}

// ---------- conferência (travas) ----------
const soma = (arr, k) => arr.reduce((s, i) => s + (Number(i[k]) || 0), 0);

// Conjunto: cada unidade da NF vale 2 peças. Tudo que é conferido em peças usa estes helpers.
const pecasNf = (p) => p.qtd * (p.fator || 1);
const descProd = (p) => `Produto ${p.codigo}${p.descricao ? " (" + p.descricao + ")" : ""}`;
const notaConjunto = (p) => ((p.fator || 1) > 1 ? ` · NF: ${p.qtd} conjuntos = ${pecasNf(p)} peças` : "");
// Valor aproximado de uma diferença em peças (preço unitário da NF ÷ peças por unidade)
const valorDif = (p, dif) => (p.valor_unit ? Math.round(Math.abs(dif) * (Number(p.valor_unit) / (p.fator || 1)) * 100) / 100 : null);

/** Avalia se a etapa pode ser concluída. Não grava nada. */
function avaliarEtapa(def, nota, itens, etapasPorN, dados, nfItens = [], ext = {}) {
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
    if (!itens.length) erros.push("Cadastre pelo menos um produto, cor e tamanho.");
    for (const campo of def.itens) {
      if (["qtd_nf", "modelo", "ref_fornecedor", "cor", "tamanho", "justificativa_confronto", "qtd_defeito", "qtd_conserto"].includes(campo)) continue; // defeito/conserto vazios valem 0
      if (campo === "ref_zinzane" && def.chave === "separacao") continue; // opcional na separação; o Estilo define na etapa própria
      const faltando = itens.filter((i) => {
        if (campo === "amostra_separada") return !i.amostra_separada;
        if (campo === "cor_def_codigo") return !(i.cor_def_codigo || i.cor_definida || i.cor); // padrão: a cor da separação (preenchida ao concluir)
        const v = i[campo];
        return v === null || v === undefined || String(v).trim() === "";
      });
      if (faltando.length) {
        const rot = {
          qtd_contada: "contagem", qtd_ficha: "quantidade da ficha", qtd_checkout: "quantidade do checkout", contado_por: "o nome de quem contou",
          amostra_separada: "peça separada para o Estilo", cor_definida: "cor definida", cor_def_codigo: "cor definida", ref_zinzane: "referência Zinzane",
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
      // a separação não tem quantidade (quem confere as peças é a contagem): todo produto da NF precisa ter ao menos uma linha de cor/tamanho
      for (const p of nfItens) {
        if (!itens.some((i) => chaveRef(i.ref_fornecedor) === chaveRef(p.codigo))) divergencias.push({ tipo: "produto_sem_linha", descricao: `${descProd(p)} está na NF e nenhuma cor/tamanho foi separado (linhas)`, esperado: 1, obtido: 0, diferenca: -1 });
      }
      break;
    case "contagem_vs_nf":
      compara(def.trava, TRAVAS[def.trava], nota.total_pecas_nf, soma(itens, "qtd_contada"));
      // por produto da NF: soma das linhas (todas as cores e tamanhos) × quantidade da nota
      for (const p of nfItens) {
        const linhas = itens.filter((i) => chaveRef(i.ref_fornecedor) === chaveRef(p.codigo));
        if (!linhas.length || linhas.some((i) => i.qtd_contada === null)) continue;
        const contado = soma(linhas, "qtd_contada");
        if (contado !== pecasNf(p)) divergencias.push({ tipo: "contagem_produto", descricao: `${descProd(p)}: contado × NF (em peças${notaConjunto(p)})`, esperado: pecasNf(p), obtido: contado, diferenca: contado - pecasNf(p), valor_rs: valorDif(p, contado - pecasNf(p)) });
      }
      // defeito e conserto fazem parte da contagem: nunca podem passar do que foi contado na linha
      for (const i of itens) {
        const sub = (Number(i.qtd_defeito) || 0) + (Number(i.qtd_conserto) || 0);
        if (i.qtd_contada !== null && sub > i.qtd_contada) erros.push(`${rotulo(i)}: defeito (${Number(i.qtd_defeito) || 0}) + conserto (${Number(i.qtd_conserto) || 0}) passam do total contado (${i.qtd_contada}).`);
      }
      // havendo diferença com a NF, a recontagem é obrigatória e fica registrada (quem recontou, qual tentativa)
      if (divergencias.length) {
        const rcs = ext.recontagens || [];
        if (!rcs.length) erros.push("DIVERGÊNCIA com a NF: faça a RECONTAGEM e registre quem recontou (botão \"Registrar recontagem\").");
        else {
          const ult = rcs[rcs.length - 1], cont = soma(itens, "qtd_contada");
          if (ult.total !== cont) divergencias.push({ tipo: "recontagem", descricao: `Recontagem nº ${ult.tentativa} (${ult.por}) × contagem lançada (corrija as linhas ou justifique)`, esperado: cont, obtido: ult.total, diferenca: ult.total - cont });
        }
      }
      break;
    case "etiquetas_vs_contagem": {
      const e2 = (etapasPorN[numeroDe("separacao")] || {}).dados || {};
      const pedidas = [e2.trocar_composicao && "etiqueta de composição", e2.trocar_marca && "etiqueta de marca", e2.trocar_codbarras && "código de barras"].filter(Boolean);
      if (pedidas.length && !(d.trocas_confirmadas === true || d.trocas_confirmadas === "true")) erros.push(`A separação pediu a troca de: ${pedidas.join(", ")}. Confirme que foi feita.`);
      if ((etapasPorN[numeroDe("contagem")] || {}).status !== "concluida") erros.push("Conclua a contagem antes de encerrar as etiquetas: só fecha com 100% das peças da NF contadas.");
      if ((etapasPorN[numeroDe("referencia")] || {}).status !== "concluida") erros.push("Conclua a referência Zinzane antes de encerrar as etiquetas.");
      const lot = ext.lotes || { n: 0, total: 0 };
      if (lot.n > 0) compara(def.trava, TRAVAS[def.trava], soma(itens, "qtd_contada"), lot.total);
      else if (d.etiquetas_impressas !== undefined && d.etiquetas_impressas !== null && d.etiquetas_impressas !== "") compara(def.trava, TRAVAS[def.trava], soma(itens, "qtd_contada"), Number(d.etiquetas_impressas)); // notas antigas
      else erros.push("Registre pelo menos um lote de etiquetas.");
      break;
    }
    case "checkout_vs_contagem":
      for (const i of itens) if (i.qtd_checkout !== null && i.qtd_contada !== null && i.qtd_checkout !== i.qtd_contada) {
        divergencias.push({ tipo: "checkout_linha", item: i.id, descricao: `${rotulo(i)}: checkout × contagem`, esperado: i.qtd_contada, obtido: i.qtd_checkout, diferenca: i.qtd_checkout - i.qtd_contada, justificativa: i.justificativa_confronto || null });
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
    case "faturamento_vs_picking": {
      const sd = ext.saidas || [];
      if (!sd.length && !txt(d.numero_nf_saida)) erros.push("Envie ao menos uma NF de saída (XML ou PDF).");
      const sem = sd.filter((x) => x.pecas === null || x.pecas === undefined || !txt(x.destino_nome));
      if (sem.length) erros.push(`Complete a loja e as peças de ${sem.length} NF(s) de saída: ${sem.slice(0, 4).map((x) => x.numero || x.arquivo_nome).join(", ")}${sem.length > 4 ? "…" : ""}.`);
      const pick = Number(((etapasPorN[numeroDe("picking")] || {}).dados || {}).pecas_embaladas);
      if (sd.length && !sem.length && Number.isFinite(pick)) compara(def.trava, TRAVAS[def.trava], pick, sd.reduce((a, x) => a + Number(x.pecas), 0));
      break;
    }
    default:
  }

  let exigeGestor = false;
  if (def.chave === "confronto") {
    const semJust = divergencias.filter((x) => !x.justificativa || x.justificativa.length < 5);
    if (semJust.length) erros.push(`Justifique ${semJust.length} linha(s) com diferença entre checkout e contagem.`);
    if (divergencias.length) exigeGestor = true;
  } else if (divergencias.length && txt(d.justificativa).length < 5) {
    erros.push("Há divergência na conferência. Explique o motivo para concluir.");
  }
  return { erros, divergencias, exigeGestor };
}

async function carregarEstado(db, notaId) {
  const [{ rows: itens }, { rows: etapas }, { rows: nfItens }] = await Promise.all([
    db.query("SELECT * FROM cd_nota_itens WHERE nota_id = $1 ORDER BY id", [notaId]),
    db.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 ORDER BY etapa", [notaId]),
    db.query("SELECT id, ordem, codigo, descricao, qtd, fator, valor_unit FROM cd_nota_nf_itens WHERE nota_id = $1 ORDER BY ordem, id", [notaId]),
  ]);
  const porN = {};
  for (const e of etapas) porN[e.etapa] = e;
  return { itens, etapas, porN, nfItens };
}

// Registros que moram em tabelas próprias: recontagens, lotes de etiqueta e NFs de saída.
async function carregarExtras(db, notaId) {
  const [{ rows: recontagens }, { rows: lotes }, { rows: saidas }] = await Promise.all([
    db.query("SELECT * FROM cd_recontagens WHERE nota_id = $1 ORDER BY tentativa, id", [notaId]),
    db.query("SELECT * FROM cd_etiquetas_lotes WHERE nota_id = $1 ORDER BY criado_em, id", [notaId]),
    db.query("SELECT id, tipo, arquivo_nome, tamanho, numero, serie, chave, destino_nome, destino_cnpj, pecas, valor::float AS valor, enviada_por, enviada_em FROM cd_nfs_saida WHERE nota_id = $1 ORDER BY id", [notaId]),
  ]);
  return { recontagens, lotes: { n: lotes.length, total: lotes.reduce((a, l) => a + l.qtd, 0), itens: lotes }, saidas };
}

async function conferirEtapa(acc, notaId, n, dados) {
  const def = etapaPorNumero(n);
  if (!def) throw erro(404, "Etapa inexistente.");
  if (!podeAtuar(acc, def)) throw erro(403, `Etapa ${def.n} é da mesa "${PERFIS[def.perfil]}".`);
  const { rows } = await pool.query("SELECT * FROM cd_notas WHERE id = $1", [notaId]);
  if (!rows[0]) throw erro(404, "Nota não encontrada.");
  const st = await carregarEstado(pool, notaId);
  // o que não vier na chamada vale o que já está gravado na etapa (ex.: contador de fardos salvo na hora)
  const guardados = (st.porN[def.n] || {}).dados || {};
  return avaliarEtapa(def, rows[0], st.itens, st.porN, { ...guardados, ...(dados || {}) }, st.nfItens, await carregarExtras(pool, notaId));
}

// ---------- concluir ----------
async function concluirEtapa(acc, notaId, n, dados = {}) {
  const def = etapaPorNumero(n);
  if (!def) throw erro(404, "Etapa inexistente.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status !== "aberta") throw erro(409, "Essa nota não está aberta.");
    if (!podeAtuar(acc, def)) throw erro(403, `Etapa ${def.n} é da mesa "${PERFIS[def.perfil]}".`);
    const { rows: l0 } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    exigirDisponivel(nota, def, l0[0], "concluir");
    if (def.chave === "referencia") await preencherCorDefinida(c, notaId);
    const st = await carregarEstado(c, notaId);
    const ext = await carregarExtras(c, notaId);
    const atual = st.porN[def.n];
    if (atual.status !== "em_andamento") throw erro(409, "Inicie a etapa antes de concluir.");

    const limpo = {};
    for (const campo of def.campos || []) {
      const v = dados[campo.k] !== undefined ? dados[campo.k] : (atual.dados || {})[campo.k];
      limpo[campo.k] = campo.tipo === "int" ? (v === "" || v === undefined || v === null ? null : Number(v))
        : campo.tipo === "bool" ? (v === true || v === "true" || v === 1)
        : txt(v) || null;
    }
    if (txt(dados.justificativa)) limpo.justificativa = txt(dados.justificativa);
    if (def.chave === "contagem" && ext.recontagens.length) {
      const u = ext.recontagens[ext.recontagens.length - 1];
      Object.assign(limpo, { recontagens: ext.recontagens.length, recontagem_total: u.total, recontagem_metodo: u.metodo, recontagem_por: u.por });
    }
    if (def.chave === "etiquetas") {
      if (ext.lotes.n > 0) Object.assign(limpo, { etiquetas_impressas: ext.lotes.total, lotes_etiquetas: ext.lotes.n });
      else if (dados.etiquetas_impressas !== undefined && dados.etiquetas_impressas !== "") limpo.etiquetas_impressas = Number(dados.etiquetas_impressas);
    }
    if (def.chave === "faturamento" && ext.saidas.length) {
      Object.assign(limpo, {
        nfs_saida: ext.saidas.length, lojas_atendidas: new Set(ext.saidas.map((x) => txt(x.destino_cnpj) || txt(x.destino_nome).toLowerCase())).size,
        pecas_nfs_saida: ext.saidas.reduce((a, x) => a + (Number(x.pecas) || 0), 0),
      });
      if (dados.numero_nf_saida) limpo.numero_nf_saida = txt(dados.numero_nf_saida);
    }

    const av = avaliarEtapa(def, nota, st.itens, st.porN, limpo, st.nfItens, ext);
    if (av.erros.length) throw erro(422, av.erros[0], { erros: av.erros, divergencias: av.divergencias });
    if (av.exigeGestor && !ehGestor(acc)) {
      throw erro(403, "Há divergência entre checkout e contagem. Só o gestor pode encerrar esta etapa.", { divergencias: av.divergencias });
    }

    const diverge = av.divergencias.length > 0;
    limpo.divergencias = av.divergencias;
    await c.query(
      `UPDATE cd_nota_etapas SET status = 'concluida', concluida_em = now(), concluida_por = $3, dados = $4, divergencia = $5
       WHERE nota_id = $1 AND etapa = $2`,
      [notaId, def.n, acc.email, JSON.stringify(limpo), diverge]
    );
    // próxima etapa = a primeira ainda não concluída (contagem, referência e etiquetas andam juntas)
    const { rows: apos } = await c.query("SELECT etapa, status FROM cd_nota_etapas WHERE nota_id = $1 ORDER BY etapa", [notaId]);
    const aberta = apos.find((x) => x.status !== "concluida");
    const fim = !aberta;
    if (fim) {
      await c.query("UPDATE cd_notas SET status = 'concluida', concluida_em = now(), com_divergencia = com_divergencia OR $2 WHERE id = $1", [notaId, diverge]);
    } else {
      await c.query("UPDATE cd_notas SET etapa_atual = $2, com_divergencia = com_divergencia OR $3 WHERE id = $1", [notaId, aberta.etapa, diverge]);
      // a separação libera as três etapas da frente de uma vez; nas demais, libera a que ficou na vez
      const liberar = def.chave === "separacao" ? FRENTE : [aberta.etapa];
      await c.query("UPDATE cd_nota_etapas SET liberada_em = now() WHERE nota_id = $1 AND etapa = ANY($2::int[]) AND liberada_em IS NULL AND status <> 'concluida'", [notaId, liberar]);
    }
    await evento(c, notaId, def.n, "etapa_concluida", acc.email, {
      exec_min_uteis: minutosUteis(atual.iniciada_em, new Date()), dados: limpo, ...(diverge ? { divergencias: av.divergencias } : {}),
    });
    const nCont = numeroDe("contagem");
    if (def.chave === "checkout" && st.porN[nCont] && st.porN[nCont].concluida_por === atual.iniciada_por) {
      await evento(c, notaId, def.n, "alerta_segregacao", acc.email, {
        mensagem: `A mesma pessoa concluiu a contagem (etapa ${nCont}) e fez o checkout (etapa ${def.n}).`, usuario: acc.email,
      });
    }
    return { ok: true, nota_concluida: fim };
  });
}

// ---------- cancelar / comentar ----------
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
  const { rows: ls } = await pool.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1", [notaId]);
  if (!mesaEnvolvida(acc, ls)) throw erro(403, "Essa nota ainda não chegou à sua mesa.");
  if (!ehGestor(acc) && !etapa) { const m = minhasEtapas(acc); const l = ls.find((x) => m.includes(x.etapa) && x.status !== "concluida") || ls.find((x) => m.includes(x.etapa)); etapa = l ? l.etapa : rows[0].etapa_atual; }
  await evento(pool, notaId, etapa ? Number(etapa) : rows[0].etapa_atual, "comentario", acc.email, { texto: txt(texto) });
  return { ok: true };
}

// ---------- recontagem (etapa de contagem) ----------
// Cada recontagem fica registrada: quem recontou, qual tentativa foi (1ª, 2ª, 3ª...), quanto deu e de quem era a contagem.
async function registrarRecontagem(acc, notaId, b = {}) {
  const def = etapaPorNumero(numeroDe("contagem"));
  const por = txt(b.por).slice(0, 80);
  if (por.length < 2) throw erro(400, "Informe o nome de quem fez a recontagem.");
  if (b.metodo !== "manual" && b.metodo !== "checkout") throw erro(400, "Informe se a recontagem foi manual ou pelo checkout.");
  const total = inteiro(b.total, "Total recontado (peças)");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (!podeAtuar(acc, def)) throw erro(403, `A recontagem é da mesa "${PERFIS[def.perfil]}".`);
    const { rows: l } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    exigirDisponivel(nota, def, l[0], "registrar recontagem na");
    if (l[0].status !== "em_andamento") throw erro(409, "Inicie a contagem antes de registrar a recontagem.");
    const st = await carregarEstado(c, notaId);
    if (st.itens.some((i) => i.qtd_contada === null)) throw erro(409, "Preencha a contagem de todas as linhas antes de registrar a recontagem.");
    const contado = soma(st.itens, "qtd_contada");
    const av = avaliarEtapa(def, nota, st.itens, st.porN, {}, st.nfItens, { recontagens: [{ tentativa: 0, total: contado, por: "" }] });
    if (!av.divergencias.some((x) => x.tipo === "contagem_vs_nf" || x.tipo === "contagem_produto")) throw erro(409, "A contagem confere com a NF: não há o que recontar.");
    const { rows: ult } = await c.query("SELECT COALESCE(MAX(tentativa), 0) AS m FROM cd_recontagens WHERE nota_id = $1", [notaId]);
    const tentativa = Number(ult[0].m) + 1;
    const contadores = [...new Set(st.itens.map((i) => txt(i.contado_por)).filter(Boolean))];
    await c.query(
      "INSERT INTO cd_recontagens (nota_id, tentativa, por, registrado_por, metodo, total, contado, esperado, contadores, obs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [notaId, tentativa, por, acc.email, b.metodo, total, contado, nota.total_pecas_nf, contadores, txt(b.obs) || null]);
    await evento(c, notaId, def.n, "recontagem_registrada", acc.email, {
      tentativa, por, metodo: b.metodo, total, contado, esperado: nota.total_pecas_nf, diferenca_nf: total - nota.total_pecas_nf, contadores, ...(txt(b.obs) ? { obs: txt(b.obs) } : {}),
    });
    return { ok: true, tentativa, bate_com_nf: total === nota.total_pecas_nf, total, contado, esperado: nota.total_pecas_nf };
  });
}

// ---------- lotes de etiquetas (em paralelo com a contagem) ----------
async function registrarLoteEtiquetas(acc, notaId, b = {}) {
  const def = etapaPorNumero(numeroDe("etiquetas"));
  const qtd = inteiro(b.qtd, "Quantidade etiquetada (peças)", { min: 1 });
  const por = txt(b.por).slice(0, 80);
  if (por.length < 2) throw erro(400, "Informe o nome de quem etiquetou.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (!podeAtuar(acc, def)) throw erro(403, `As etiquetas são da mesa "${PERFIS[def.perfil]}".`);
    const { rows: l } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    exigirDisponivel(nota, def, l[0], "registrar etiquetas na");
    if (l[0].status !== "em_andamento") throw erro(409, "Inicie a etapa de etiquetas antes de registrar um lote.");
    const st = await carregarEstado(c, notaId);
    const liberadas = st.itens.filter((i) => i.qtd_contada !== null && txt(i.ref_zinzane)).reduce((a, i) => a + i.qtd_contada, 0);
    const { rows: [{ ja }] } = await c.query("SELECT COALESCE(SUM(qtd), 0)::int AS ja FROM cd_etiquetas_lotes WHERE nota_id = $1", [notaId]);
    const livre = liberadas - ja;
    if (qtd > livre) throw erro(422, `Só dá para etiquetar o que já foi contado e já tem referência Zinzane. Liberadas até agora: ${liberadas} peça(s); já etiquetadas: ${ja}; disponível para este lote: ${Math.max(0, livre)}.`);
    const { rows } = await c.query("INSERT INTO cd_etiquetas_lotes (nota_id, qtd, por, registrado_por, obs) VALUES ($1,$2,$3,$4,$5) RETURNING *", [notaId, qtd, por, acc.email, txt(b.obs) || null]);
    await evento(c, notaId, def.n, "etiquetas_lote", acc.email, { lote: rows[0].id, qtd, por, acumulado: ja + qtd, liberadas, restante_liberado: livre - qtd, esperado_total: nota.total_pecas_nf });
    return { ok: true, lote: rows[0], acumulado: ja + qtd, disponivel: livre - qtd };
  });
}

async function removerLoteEtiquetas(acc, notaId, loteId) {
  const def = etapaPorNumero(numeroDe("etiquetas"));
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (!podeAtuar(acc, def)) throw erro(403, `As etiquetas são da mesa "${PERFIS[def.perfil]}".`);
    const { rows: l } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    exigirDisponivel(nota, def, l[0], "corrigir lotes na");
    const { rows } = await c.query("DELETE FROM cd_etiquetas_lotes WHERE id = $1 AND nota_id = $2 RETURNING *", [loteId, notaId]);
    if (!rows[0]) throw erro(404, "Lote não encontrado.");
    await evento(c, notaId, def.n, "etiquetas_lote_removido", acc.email, { lote: rows[0].id, qtd: rows[0].qtd, por: rows[0].por });
    return { ok: true };
  });
}

// ---------- ranking de prioridade ----------
async function definirRanking(acc, notaId, ranking) {
  if (!ehGestor(acc) && !acc.cd_perfis.includes("recebimento")) throw erro(403, "Só o recebimento e o consolidado definem a prioridade.");
  let r = null;
  if (ranking !== undefined && ranking !== null && String(ranking).trim() !== "") {
    r = Number(ranking);
    if (!Number.isInteger(r) || r < 1 || r > 999) throw erro(400, "Posição de prioridade: informe um número inteiro de 1 a 999.");
  }
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status !== "aberta") throw erro(409, "Só dá para mudar a prioridade de nota em andamento.");
    if (nota.ranking === r) return { ok: true };
    await c.query("UPDATE cd_notas SET ranking = $2 WHERE id = $1", [notaId, r]);
    await evento(c, notaId, nota.etapa_atual, "ranking_alterado", acc.email, { de: nota.ranking, para: r });
    return { ok: true, ranking: r };
  });
}

// ---------- NFs de saída (faturamento) ----------
const tagXml = (src, t) => { const m = String(src || "").match(new RegExp(`<${t}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${t}>`)); return m ? m[1] : null; };
const blocoXml = (src, t) => { const m = String(src || "").match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)); return m ? m[1] : null; };
// Lê os dados que importam de uma NF-e (XML): número, série, chave, destinatário (loja), peças e valor.
function lerXmlSaida(xml) {
  if (!/<infNFe[\s>]/.test(xml)) return null;
  const chave = ((xml.match(/<infNFe[^>]*\sId="NFe(\d{44})"/) || [])[1]) || tagXml(xml, "chNFe") || null;
  const ide = blocoXml(xml, "ide"), dest = blocoXml(xml, "dest"), tot = blocoXml(xml, "ICMSTot");
  let pecas = 0, achou = false;
  for (const m of xml.matchAll(/<det\b[\s\S]*?<\/det>/g)) { const q = Number(String(tagXml(m[0], "qCom") || "").replace(",", ".")); if (Number.isFinite(q)) { pecas += q; achou = true; } }
  const vNF = Number(tagXml(tot, "vNF"));
  return {
    numero: tagXml(ide, "nNF"), serie: tagXml(ide, "serie"), chave,
    destino_nome: tagXml(dest, "xNome"), destino_cnpj: tagXml(dest, "CNPJ") || tagXml(dest, "CPF"),
    pecas: achou ? Math.round(pecas) : null, valor: Number.isFinite(vNF) ? vNF : null,
  };
}

async function enviarNfSaida(acc, notaId, b = {}) {
  const def = etapaPorNumero(numeroDe("faturamento"));
  const nome = txt(b.nome).slice(0, 200) || "arquivo";
  let buf;
  try { buf = Buffer.from(String(b.base64 || ""), "base64"); } catch (e) { buf = Buffer.alloc(0); }
  if (!buf.length) throw erro(400, "Arquivo vazio.");
  if (buf.length > 4 * 1024 * 1024) throw erro(413, `${nome}: arquivo maior que 4 MB.`);
  const ehPdf = buf.slice(0, 5).toString("latin1") === "%PDF-";
  const textoIni = buf.slice(0, 200).toString("utf8");
  const ehXml = !ehPdf && /^\s*(<\?xml|<)/.test(textoIni);
  if (!ehPdf && !ehXml) throw erro(422, `${nome}: envie o XML ou o PDF da NF.`);
  let m = { numero: null, serie: null, chave: null, destino_nome: null, destino_cnpj: null, pecas: null, valor: null };
  if (ehXml) {
    const lido = lerXmlSaida(buf.toString("utf8"));
    if (!lido) throw erro(422, `${nome}: esse XML não parece uma NF-e (não achei <infNFe>).`);
    m = lido;
  } else {
    // no PDF a leitura é do navegador (chave, número, série); loja e peças a pessoa confere na tela
    const chave = txt(b.chave).replace(/\s+/g, "");
    m = {
      numero: txt(b.numero) || null, serie: txt(b.serie) || null, chave: /^\d{44}$/.test(chave) ? chave : null, destino_nome: txt(b.destino_nome) || null,
      destino_cnpj: txt(b.destino_cnpj).replace(/\D/g, "") || null, pecas: b.pecas === "" || b.pecas === undefined || b.pecas === null ? null : Number(b.pecas), valor: b.valor === "" || b.valor === undefined || b.valor === null ? null : Number(b.valor),
    };
    if (m.pecas !== null && (!Number.isInteger(m.pecas) || m.pecas < 0)) m.pecas = null;
    if (m.valor !== null && !Number.isFinite(m.valor)) m.valor = null;
  }
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (!podeAtuar(acc, def)) throw erro(403, `O faturamento é da mesa "${PERFIS[def.perfil]}".`);
    const { rows: l } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    exigirDisponivel(nota, def, l[0], "enviar NFs de saída na");
    if (l[0].status !== "em_andamento") throw erro(409, "Inicie o faturamento antes de enviar as NFs.");
    if (m.chave) {
      const { rows: dup } = await c.query("SELECT nota_id, numero FROM cd_nfs_saida WHERE chave = $1", [m.chave]);
      if (dup[0]) throw erro(409, `${nome}: essa NF (${dup[0].numero || m.chave}) já foi enviada${String(dup[0].nota_id) === String(notaId) ? " nesta nota" : " em outra nota"}.`);
    }
    const { rows } = await c.query(
      `INSERT INTO cd_nfs_saida (nota_id, tipo, arquivo_nome, tamanho, numero, serie, chave, destino_nome, destino_cnpj, pecas, valor, enviada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, tipo, arquivo_nome, tamanho, numero, serie, chave, destino_nome, destino_cnpj, pecas, valor::float AS valor, enviada_por, enviada_em`,
      [notaId, ehPdf ? "pdf" : "xml", nome, buf.length, m.numero, m.serie, m.chave, m.destino_nome, m.destino_cnpj, m.pecas, m.valor, acc.email]);
    await c.query("INSERT INTO cd_nfs_saida_arq (nfs_id, conteudo) VALUES ($1,$2)", [rows[0].id, buf]);
    await evento(c, notaId, def.n, "nf_saida_enviada", acc.email, { id: rows[0].id, arquivo: nome, tipo: rows[0].tipo, numero: m.numero, destino: m.destino_nome, pecas: m.pecas });
    return { ok: true, nf: rows[0] };
  });
}

async function editarNfSaida(acc, notaId, sid, b = {}) {
  const def = etapaPorNumero(numeroDe("faturamento"));
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (!podeAtuar(acc, def)) throw erro(403, `O faturamento é da mesa "${PERFIS[def.perfil]}".`);
    const { rows: l } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    exigirDisponivel(nota, def, l[0], "corrigir NFs de saída na");
    const { rows: cur } = await c.query("SELECT * FROM cd_nfs_saida WHERE id = $1 AND nota_id = $2", [sid, notaId]);
    if (!cur[0]) throw erro(404, "NF de saída não encontrada.");
    const sets = [], vals = [], mud = [];
    const set = (col, v, antes) => { vals.push(v); sets.push(`${col} = $${vals.length}`); mud.push({ campo: col, de: antes ?? null, para: v }); };
    if ("destino_nome" in b) { const v = txt(b.destino_nome).slice(0, 120) || null; if (v !== cur[0].destino_nome) set("destino_nome", v, cur[0].destino_nome); }
    if ("destino_cnpj" in b) { const v = txt(b.destino_cnpj).replace(/\D/g, "") || null; if (v !== cur[0].destino_cnpj) set("destino_cnpj", v, cur[0].destino_cnpj); }
    if ("numero" in b) { const v = txt(b.numero).slice(0, 20) || null; if (v !== cur[0].numero) set("numero", v, cur[0].numero); }
    if ("serie" in b) { const v = txt(b.serie).slice(0, 10) || null; if (v !== cur[0].serie) set("serie", v, cur[0].serie); }
    if ("pecas" in b) {
      const v = b.pecas === "" || b.pecas === null ? null : inteiro(b.pecas, "Peças");
      if (v !== cur[0].pecas) set("pecas", v, cur[0].pecas);
    }
    if ("valor" in b) {
      const v = b.valor === "" || b.valor === null ? null : Number(b.valor);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw erro(400, "Valor da NF inválido.");
      if (v !== (cur[0].valor === null ? null : Number(cur[0].valor))) set("valor", v, cur[0].valor);
    }
    if (!sets.length) return { ok: true };
    vals.push(sid);
    await c.query(`UPDATE cd_nfs_saida SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    await evento(c, notaId, def.n, "nf_saida_editada", acc.email, { id: Number(sid), numero: cur[0].numero, mudancas: mud });
    return { ok: true };
  });
}

async function removerNfSaida(acc, notaId, sid) {
  const def = etapaPorNumero(numeroDe("faturamento"));
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (!podeAtuar(acc, def)) throw erro(403, `O faturamento é da mesa "${PERFIS[def.perfil]}".`);
    const { rows: l } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    exigirDisponivel(nota, def, l[0], "remover NFs de saída na");
    const { rows } = await c.query("DELETE FROM cd_nfs_saida WHERE id = $1 AND nota_id = $2 RETURNING numero, arquivo_nome, destino_nome", [sid, notaId]);
    if (!rows[0]) throw erro(404, "NF de saída não encontrada.");
    await evento(c, notaId, def.n, "nf_saida_removida", acc.email, { id: Number(sid), numero: rows[0].numero, arquivo: rows[0].arquivo_nome, destino: rows[0].destino_nome });
    return { ok: true };
  });
}

async function baixarNfSaida(acc, notaId, sid) {
  const def = etapaPorNumero(numeroDe("faturamento"));
  if (!podeAtuar(acc, def)) throw erro(403, "O arquivo da NF de saída é do faturamento e do consolidado.");
  const { rows } = await pool.query(
    "SELECT s.arquivo_nome, s.tipo, a.conteudo FROM cd_nfs_saida s JOIN cd_nfs_saida_arq a ON a.nfs_id = s.id WHERE s.id = $1 AND s.nota_id = $2", [sid, notaId]);
  if (!rows[0]) throw erro(404, "NF de saída não encontrada.");
  return { nome: rows[0].arquivo_nome, tipo: rows[0].tipo, conteudo: rows[0].conteudo };
}

// ---------- reabrir ----------
async function reabrirEtapa(acc, notaId, n, motivo) {
  if (!ehGestor(acc)) throw erro(403, "Somente o consolidado (gestor) pode reabrir uma etapa.");
  const def = etapaPorNumero(n);
  if (!def || def.n === 1) throw erro(400, "Essa etapa não pode ser reaberta.");
  if (txt(motivo).length < 5) throw erro(422, "Explique o motivo da reabertura.");
  return comTransacao(async (c) => {
    const nota = await travarNota(c, notaId);
    if (nota.status === "cancelada") throw erro(409, "Nota cancelada.");
    const { rows: ls } = await c.query("SELECT * FROM cd_nota_etapas WHERE nota_id = $1 AND etapa = $2", [notaId, def.n]);
    if (def.n > nota.etapa_atual && ls[0].status === "pendente") throw erro(409, "Essa etapa ainda não foi alcançada.");
    // o que reinicia: a própria etapa e tudo que depende dela. Na frente (contagem/referência/etiquetas) a contagem e a
    // referência só reiniciam as etiquetas; a separação e as etapas de 6 em diante reiniciam tudo que vem depois.
    const frente = FRENTE.includes(def.n);
    const reinicia = ETAPAS.map((e) => e.n).filter((x) => {
      if (x === def.n) return true;
      if (x < def.n) return false;
      if (!frente) return true;
      if (FRENTE.includes(x)) return x === numeroDe("etiquetas") && def.n !== x;
      return true;
    });
    const liberar = frente ? reinicia.filter((x) => FRENTE.includes(x)) : [def.n];
    await c.query(
      `UPDATE cd_nota_etapas SET status = 'pendente', iniciada_em = NULL, iniciada_por = NULL, concluida_em = NULL, concluida_por = NULL, divergencia = false,
         liberada_em = CASE WHEN etapa = ANY($3::int[]) THEN now() ELSE NULL END
       WHERE nota_id = $1 AND etapa = ANY($2::int[])`,
      [notaId, reinicia, liberar]
    );
    const { rows: apos } = await c.query("SELECT etapa, status FROM cd_nota_etapas WHERE nota_id = $1 ORDER BY etapa", [notaId]);
    const aberta = apos.find((x) => x.status !== "concluida");
    await c.query("UPDATE cd_notas SET status = 'aberta', etapa_atual = $2, concluida_em = NULL WHERE id = $1", [notaId, aberta.etapa]);
    await evento(c, notaId, def.n, "etapa_reaberta", acc.email, { motivo: txt(motivo), etapas_reiniciadas: reinicia.join(", ") });
    return { ok: true };
  });
}

// ---------- leitura ----------
function resumoTempo(def, linha, agora) {
  // linha = cd_nota_etapas da etapa em questão
  const aguardando = linha.status === "pendente";
  const desde = aguardando ? linha.liberada_em : linha.iniciada_em;
  const minutos = desde ? minutosUteis(desde, agora) : 0;
  const meta = aguardando ? def.sla_fila_min : def.sla_exec_min;
  return { estado: aguardando ? "aguardando" : "em_andamento", desde, minutos, meta, atrasada: minutos > meta };
}

// A mesa só enxerga as notas que já chegaram (ou já passaram) por ela. O consolidado (gestor) enxerga todas.
const mesaEnvolvida = (acc, linhas) => {
  if (ehGestor(acc)) return true;
  const meus = minhasEtapas(acc);
  return linhas.some((l) => meus.includes(l.etapa) && (l.liberada_em || l.status !== "pendente" || l.concluida_em));
};
const ordemFila = (a, b) => ((a.ranking || 9999) - (b.ranking || 9999)) || (b.atrasada - a.atrasada) || ((b.prioridade === "urgente") - (a.prioridade === "urgente")) || (b.minutos / b.meta - a.minutos / a.meta);

async function listarNotas(acc, { status = "aberta", q, limit = 100 } = {}) {
  const cfg = await etapasConfig();
  const params = [];
  const where = [];
  if (status && status !== "todas") { params.push(status); where.push(`n.status = $${params.length}`); }
  if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(lower(n.numero_nf) LIKE $${params.length} OR lower(n.fornecedor) LIKE $${params.length})`); }
  const meus = minhasEtapas(acc);
  if (!ehGestor(acc)) {
    params.push(meus);
    where.push(`n.id IN (SELECT nota_id FROM cd_nota_etapas WHERE etapa = ANY($${params.length}::int[]) AND (liberada_em IS NOT NULL OR status <> 'pendente'))`);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await pool.query(
    `SELECT n.*, e.status AS etapa_status, e.liberada_em, e.iniciada_em, e.iniciada_por
       FROM cd_notas n LEFT JOIN cd_nota_etapas e ON e.nota_id = n.id AND e.etapa = n.etapa_atual
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY CASE WHEN n.status = 'aberta' THEN n.ranking END ASC NULLS LAST, n.criada_em DESC LIMIT $${params.length}`,
    params
  );
  // na mesa, o cartão mostra a etapa DA MESA (não a etapa atual da nota)
  let minhasLinhas = new Map();
  if (!ehGestor(acc) && rows.length) {
    const { rows: ls } = await pool.query(
      "SELECT * FROM cd_nota_etapas WHERE nota_id = ANY($1::bigint[]) AND etapa = ANY($2::int[]) ORDER BY etapa", [rows.map((r) => r.id), meus]);
    for (const l of ls) {
      const cur = minhasLinhas.get(l.nota_id);
      const ativa = l.status !== "concluida";
      if (!cur || (ativa && cur.status === "concluida")) minhasLinhas.set(l.nota_id, l);
    }
  }
  const agora = new Date();
  return {
    notas: rows.map((n) => {
      let etapa = n.etapa_atual, linha = { status: n.etapa_status, liberada_em: n.liberada_em, iniciada_em: n.iniciada_em, iniciada_por: n.iniciada_por };
      if (minhasLinhas.has(n.id)) { const l = minhasLinhas.get(n.id); etapa = l.etapa; linha = l; }
      const def = cfg.find((x) => x.n === etapa);
      const t = n.status === "aberta" && def && linha.status !== "concluida" ? resumoTempo(def, linha, agora) : null;
      return {
        id: n.id, numero_nf: n.numero_nf, serie: n.serie, fornecedor: n.fornecedor, total_pecas_nf: n.total_pecas_nf, prioridade: n.prioridade, ranking: n.ranking,
        status: n.status, etapa_atual: etapa, etapa_nome: def && def.nome, perfil_atual: def && def.perfil, com_divergencia: n.com_divergencia,
        responsavel: linha.status === "em_andamento" ? linha.iniciada_por : null, criada_em: n.criada_em, concluida_em: n.concluida_em,
        minha_etapa_concluida: !!minhasLinhas.has(n.id) && linha.status === "concluida",
        tempo_total_min: minutosUteis(n.criada_em, n.concluida_em || agora), ...(t || {}),
      };
    }),
  };
}

const MASC_CONTAGEM = ["qtd_contada", "qtd_defeito", "qtd_conserto", "contado_por"];

async function detalheNota(acc, notaId) {
  const { rows } = await pool.query("SELECT * FROM cd_notas WHERE id = $1", [notaId]);
  const nota = rows[0];
  if (!nota) throw erro(404, "Nota não encontrada.");
  const cfg = await etapasConfig();
  const st = await carregarEstado(pool, notaId);
  if (!mesaEnvolvida(acc, st.etapas)) throw erro(403, "Essa nota ainda não chegou à sua mesa.");
  const gestor = ehGestor(acc), meus = minhasEtapas(acc);
  const ext = await carregarExtras(pool, notaId);
  let { rows: eventos } = await pool.query("SELECT id, etapa, tipo, usuario, detalhe, criado_em FROM cd_eventos WHERE nota_id = $1 ORDER BY criado_em ASC, id ASC", [notaId]);
  const agora = new Date();
  const etapas = cfg.map((def) => {
    const l = st.porN[def.n];
    const anterior = st.porN[def.n - 1];
    const ativa = etapaAtiva(nota, l);
    const meu = meus.includes(def.n);
    return {
      n: def.n, nome: def.nome, perfil: def.perfil, status: l.status, iniciada_em: l.iniciada_em, iniciada_por: meu ? l.iniciada_por : null,
      concluida_em: l.concluida_em, concluida_por: meu ? l.concluida_por : null, divergencia: l.divergencia, dados: meu ? l.dados : {},
      fila_min: l.iniciada_em && l.liberada_em ? minutosUteis(l.liberada_em, l.iniciada_em) : null,
      exec_min: l.concluida_em && l.iniciada_em ? minutosUteis(l.iniciada_em, l.concluida_em) : null,
      sla_exec_min: def.sla_exec_min, sla_fila_min: def.sla_fila_min, ativa, meu, paralela: !!def.paralela,
      ...(ativa ? { tempo: resumoTempo(def, l, agora) } : {}),
      _anterior: anterior ? anterior.status : null,
    };
  });
  // conferência ao vivo de cada etapa em andamento que o usuário pode executar
  const conferencias = {};
  for (const def of cfg) {
    const l = st.porN[def.n];
    if (etapaAtiva(nota, l) && l.status === "em_andamento" && podeAtuar(acc, def)) {
      conferencias[def.n] = avaliarEtapa(def, nota, st.itens, st.porN, l.dados || {}, st.nfItens, ext);
    }
  }
  const podeAtuarEm = cfg.filter((d) => etapaAtiva(nota, st.porN[d.n]) && podeAtuar(acc, d)).map((d) => d.n);

  // mesa: histórico só da própria mesa; o resto do consolidado fica de fora
  let itens = st.itens, nfItens = st.nfItens, notaOut = { ...nota };
  if (!gestor) {
    eventos = eventos.filter((e) => e.etapa && meus.includes(e.etapa));
    const veValor = acc.cd_perfis.includes("recebimento");
    if (!veValor) { notaOut.valor_nf = null; nfItens = nfItens.map((p) => ({ ...p, valor_unit: null })); }
    const cego = acc.cd_perfis.includes("checkout") && !acc.cd_perfis.includes("contagem") && !acc.cd_perfis.includes("confronto") && st.porN[numeroDe("checkout")].status !== "concluida";
    if (cego) itens = itens.map((i) => { const o = { ...i }; for (const k of MASC_CONTAGEM) o[k] = null; return o; });
  }
  const verRecont = gestor || acc.cd_perfis.includes("contagem");
  const verEtiq = gestor || acc.cd_perfis.includes("etiquetas");
  const verSaidas = gestor || acc.cd_perfis.includes("faturamento");
  const disponivelEtiq = Math.max(0, st.itens.filter((i) => i.qtd_contada !== null && txt(i.ref_zinzane)).reduce((a, i) => a + i.qtd_contada, 0) - ext.lotes.total);
  const ativas = etapas.filter((e) => e.ativa).map((e) => e.n);
  return {
    nota: notaOut, etapas, itens, itens_nf: nfItens, eventos, conferencia: conferencias[nota.etapa_atual] || null, conferencias,
    recontagens: verRecont ? ext.recontagens : [],
    etiquetas: verEtiq ? { lotes: ext.lotes.itens, total: ext.lotes.total, disponivel: disponivelEtiq, contado_com_ref: st.itens.filter((i) => i.qtd_contada !== null && txt(i.ref_zinzane)).reduce((a, i) => a + i.qtd_contada, 0) } : null,
    saidas: verSaidas ? ext.saidas : [],
    tempo_total_min: minutosUteis(nota.criada_em, nota.concluida_em || agora),
    etapas_ativas: ativas,
    permissoes: {
      pode_atuar_etapa_atual: nota.status === "aberta" && podeAtuarEm.includes(nota.etapa_atual),
      pode_atuar: podeAtuarEm,
      gestor,
      pode_definir_ranking: gestor || acc.cd_perfis.includes("recebimento"),
    },
  };
}

// ---------- painel de movimentação ----------
async function painel(acc) {
  const cfg = await etapasConfig();
  const agora = new Date();
  const gestor = ehGestor(acc), meus = minhasEtapas(acc);
  // uma linha por (nota, etapa no ar): contagem, referência e etiquetas aparecem nas três filas ao mesmo tempo
  const { rows: abertas } = await pool.query(
    `SELECT n.*, e.etapa AS e_etapa, e.status AS etapa_status, e.liberada_em, e.iniciada_em, e.iniciada_por
       FROM cd_notas n JOIN cd_nota_etapas e ON e.nota_id = n.id
      WHERE n.status = 'aberta' AND e.status <> 'concluida' AND (e.liberada_em IS NOT NULL OR e.status = 'em_andamento')`
  );
  const todas = abertas.map((n) => {
    const def = cfg.find((x) => x.n === n.e_etapa);
    const t = resumoTempo(def, { status: n.etapa_status, liberada_em: n.liberada_em, iniciada_em: n.iniciada_em }, agora);
    return {
      id: n.id, status: "aberta", numero_nf: n.numero_nf, fornecedor: n.fornecedor, total_pecas_nf: n.total_pecas_nf, prioridade: n.prioridade, ranking: n.ranking, com_divergencia: n.com_divergencia,
      etapa_atual: n.e_etapa, etapa_nome: def.nome, perfil_atual: def.perfil, proximo_perfil: (cfg.find((x) => x.n === n.e_etapa + 1) || {}).perfil || null,
      responsavel: n.etapa_status === "em_andamento" ? n.iniciada_por : null, criada_em: n.criada_em,
      tempo_total_min: minutosUteis(n.criada_em, agora), ...t,
    };
  });
  todas.sort(ordemFila);
  const notas = gestor ? todas : todas.filter((n) => meus.includes(n.etapa_atual));
  // a caminho da mesa: a etapa anterior está no ar e a minha ainda não foi liberada (só o essencial, sem abrir a nota)
  let caminho = [];
  if (!gestor) {
    const { rows: pend } = await pool.query(
      `SELECT n.id, n.numero_nf, n.fornecedor, n.total_pecas_nf, n.prioridade, n.ranking, e.etapa
         FROM cd_notas n JOIN cd_nota_etapas e ON e.nota_id = n.id
        WHERE n.status = 'aberta' AND e.status = 'pendente' AND e.liberada_em IS NULL AND e.etapa = ANY($1::int[])`, [meus]);
    const ativasPorNota = new Map(); for (const x of todas) { (ativasPorNota.get(x.id) || ativasPorNota.set(x.id, []).get(x.id)).push(x); }
    caminho = pend.filter((p) => (ativasPorNota.get(p.id) || []).length).map((p) => ({
      id: p.id, numero_nf: p.numero_nf, fornecedor: p.fornecedor, total_pecas_nf: p.total_pecas_nf, prioridade: p.prioridade, ranking: p.ranking, minha_etapa: p.etapa,
      etapa_nome: ((ativasPorNota.get(p.id)[0]) || {}).etapa_nome,
    })).sort((a, b) => ((a.ranking || 9999) - (b.ranking || 9999)));
  }

  const etapas = cfg.filter((d) => gestor || meus.includes(d.n)).map((def) => {
    const aqui = notas.filter((n) => n.etapa_atual === def.n);
    const aguardando = aqui.filter((n) => n.estado === "aguardando");
    const andamento = aqui.filter((n) => n.estado === "em_andamento");
    return {
      n: def.n, nome: def.nome, perfil: def.perfil, paralela: !!def.paralela, sla_exec_min: def.sla_exec_min, sla_fila_min: def.sla_fila_min,
      aguardando: aguardando.length, em_andamento: andamento.length, atrasadas: aqui.filter((x) => x.atrasada).length,
      pecas: aqui.reduce((s, x) => s + x.total_pecas_nf, 0), mais_antiga_min: aqui.length ? Math.max(...aqui.map((x) => x.minutos)) : 0,
    };
  });

  const hoje = diaLocal(agora);
  let resumo;
  const idsDistintos = (arr) => new Set(arr.map((n) => n.id)).size;
  if (gestor) {
    const { rows: concl } = await pool.query(
      "SELECT id, criada_em, concluida_em, com_divergencia FROM cd_notas WHERE status = 'concluida' AND concluida_em >= now() - interval '30 days'"
    );
    const leads = concl.map((n) => minutosUteis(n.criada_em, n.concluida_em));
    resumo = {
      abertas: idsDistintos(todas),
      atrasadas: idsDistintos(todas.filter((n) => n.atrasada)),
      com_divergencia: idsDistintos(todas.filter((n) => n.com_divergencia)),
      urgentes: idsDistintos(todas.filter((n) => n.prioridade === "urgente")),
      concluidas_hoje: concl.filter((n) => diaLocal(n.concluida_em) === hoje).length,
      concluidas_30d: concl.length,
      lead_time_medio_min: leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : null,
    };
  } else {
    const { rows: feitas } = await pool.query(
      "SELECT concluida_em FROM cd_nota_etapas WHERE concluida_por = $1 AND etapa = ANY($2::int[]) AND status = 'concluida' AND concluida_em >= now() - interval '30 days'", [acc.email, meus]);
    resumo = {
      mesa: true, abertas: notas.length, em_curso: notas.filter((n) => n.estado === "em_andamento").length,
      atrasadas: notas.filter((n) => n.atrasada).length, com_divergencia: notas.filter((n) => n.com_divergencia).length, urgentes: notas.filter((n) => n.prioridade === "urgente").length,
      concluidas_hoje: feitas.filter((r) => diaLocal(r.concluida_em) === hoje).length, concluidas_30d: feitas.length, lead_time_medio_min: null,
    };
  }
  return { gerado_em: agora, resumo, etapas, notas, caminho, mesa: !gestor };
}

async function gargalos(acc, { dias = 30 } = {}) {
  exigirGestor(acc, "Os gargalos do processo");
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

// Ranking de fornecedores: quem manda mais peça com defeito, mais conserto e mais diferença com a NF
async function fornecedores(acc, { dias = 90 } = {}) {
  exigirGestor(acc, "O ranking de fornecedores");
  const d = Math.min(Math.max(Number(dias) || 90, 1), 730);
  const { rows } = await pool.query(
    `SELECT n.fornecedor,
            COUNT(*)::int AS notas,
            COALESCE(SUM(n.total_pecas_nf),0)::int AS pecas_nf,
            COALESCE(SUM(n.valor_nf),0)::float AS valor_nf,
            COALESCE(SUM(t.contado),0)::int AS contadas,
            COALESCE(SUM(t.defeito),0)::int AS defeito,
            COALESCE(SUM(t.conserto),0)::int AS conserto,
            COUNT(*) FILTER (WHERE t.contado IS NOT NULL AND t.contado <> n.total_pecas_nf)::int AS notas_com_diferenca,
            COALESCE(SUM(CASE WHEN t.contado IS NOT NULL THEN t.contado - n.total_pecas_nf ELSE 0 END),0)::int AS saldo_pecas
       FROM cd_notas n
       LEFT JOIN (SELECT nota_id, SUM(qtd_contada) AS contado, SUM(COALESCE(qtd_defeito,0)) AS defeito, SUM(COALESCE(qtd_conserto,0)) AS conserto
                    FROM cd_nota_itens WHERE qtd_contada IS NOT NULL AND nota_id IN (SELECT nota_id FROM cd_nota_etapas WHERE etapa = $2 AND status = 'concluida') GROUP BY nota_id) t ON t.nota_id = n.id
      WHERE n.status <> 'cancelada' AND n.criada_em >= now() - ($1 || ' days')::interval
      GROUP BY n.fornecedor`, [String(d), numeroDe("contagem")]
  );
  const lista = rows.map((r) => ({
    ...r,
    pct_defeito: r.contadas ? Math.round((r.defeito / r.contadas) * 1000) / 10 : null,
    pct_conserto: r.contadas ? Math.round((r.conserto / r.contadas) * 1000) / 10 : null,
  })).sort((a, b) => ((b.defeito + b.conserto) - (a.defeito + a.conserto)) || (b.notas_com_diferenca - a.notas_com_diferenca));
  return { dias: d, fornecedores: lista };
}

module.exports = {
  configPublica, salvarConfigEtapas, criarNota, iniciarEtapa, salvarItens, conferirEtapa, concluirEtapa, reabrirEtapa, cancelarNota,
  comentar, listarNotas, detalheNota, painel, gargalos, listarCores, criarCor, fornecedores,
  registrarRecontagem, registrarLoteEtiquetas, removerLoteEtiquetas, definirRanking,
  enviarNfSaida, editarNfSaida, removerNfSaida, baixarNfSaida, lerXmlSaida,
};
