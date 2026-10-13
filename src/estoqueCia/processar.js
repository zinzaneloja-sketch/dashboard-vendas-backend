// Calcula tudo o que o menu "Estoque Cia" mostra a partir das linhas da planilha de estoque
// (ver lerPlanilha.js). Roda uma vez por carga e o resultado fica salvo pronto em
// estoque_cia_datasets — o painel só lê, não recalcula nada na hora.
//
// Regras (as mesmas da análise validada com o time):
//  - Tipo do local: "CD / Outros" para filiais que começam com RJ / MARKETING / MOSTRUARIO
//    (distribuidoras, retorno de defeito/devolução, CQ, marketing, mostruário); senão
//    "OMNI" ou "Loja não OMNI" conforme a coluna Omni da planilha.
//  - Estoque negativo do sistema conta como 0.
//  - Disponível e-com: só lojas OMNI, deflator de 1 peça por SKU (ref × cor × tamanho) por loja.
//  - Grade quebrada: a loja tem menos da metade dos tamanhos que a referência tem na
//    companhia (só refs com 3+ tamanhos). Peça solta: 1 peça só da referência na loja.
//  - Completar grade: para cada loja × ref com tamanho faltando, manda 1 peça de cada
//    tamanho que a distribuidora tem, dividindo o saldo do CD (prioridade: grade quebrada,
//    depois lojas com mais peças da ref).
//  - Distribuir parados: refs com 20+ peças na distribuidora e em até 5 lojas → lojas que
//    mais têm a categoria e não têm a ref, 1 peça por tamanho em cada (até 10 lojas).
//  - Mix: loja × categoria 3 p.p. ou mais longe da média das lojas e 20+ peças de ajuste.
const { NUM_TAMANHOS } = require("./lerPlanilha");

const CD_OUTROS = "CD / Outros";
const PREFIXOS_CD = ["RJ ", "MARKETING", "MOSTRUARIO"];
const DISTRIBUIDORAS = ["RJ DISTRIBUIDORA", "RJ CQ DISTRIBUIDORA"];
const RETORNO_DEFEITO = "RJ RETORNO DEFEITO";
const DEFLATOR_ECOM = 1;
const CD_MIN_PECAS = 20;
const CD_MAX_LOJAS = 5;
const CD_MAX_LOJAS_SUGERIDAS = 10;
const MIX_MIN_PP = 3;
const MIX_MIN_PECAS = 20;
const MIX_MIN_SHARE_REDE = 0.02;

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const soma = (a) => a.reduce((s, x) => s + x, 0);
const div = (a, b) => (b ? a / b : 0);

function tipoDoLocal(filial, omni) {
  if (PREFIXOS_CD.some((p) => filial.startsWith(p))) return CD_OUTROS;
  return omni ? "OMNI" : "Loja não OMNI";
}

function processarEstoque({ itens, produtos }) {
  // ---- 1. linhas enriquecidas (só com peça > 0) ----
  const linhas = [];
  for (const i of itens) {
    const q = soma(i.tam);
    if (q <= 0) continue;
    const p = produtos.get(i.produto) || {};
    const tipo = tipoDoLocal(i.filial, i.omni);
    linhas.push({
      ref: i.refCor, produto: i.produto, filial: i.filial, tipo,
      outlet: i.filial.includes("OUTLET"),
      nome: i.nome || p.nome || "", grupo: p.grupo || "SEM GRUPO", linha: p.linha || "SEM LINHA",
      liqui: !!p.liqui, foto: !!i.foto, preco: i.preco || 0,
      tam: i.tam, q, valor: q * (i.preco || 0),
      ecom: tipo === "OMNI" ? soma(i.tam.map((x) => Math.max(0, x - DEFLATOR_ECOM))) : 0,
    });
  }
  const ehLoja = (l) => l.tipo !== CD_OUTROS;

  // tamanhos existentes de cada ref na companhia toda
  const tamCia = new Map();
  for (const l of linhas) {
    let t = tamCia.get(l.ref);
    if (!t) { t = new Array(NUM_TAMANHOS).fill(false); tamCia.set(l.ref, t); }
    l.tam.forEach((x, j) => { if (x > 0) t[j] = true; });
  }
  const nTamCia = new Map([...tamCia].map(([k, t]) => [k, t.filter(Boolean).length]));
  const ultimoTam = new Map([...tamCia].map(([k, t]) => [k, t.lastIndexOf(true) + 1 || 1]));

  for (const l of linhas) {
    const tCia = tamCia.get(l.ref);
    l.nsz = l.tam.filter((x) => x > 0).length;
    l.nszCia = nTamCia.get(l.ref);
    l.gradeQ = l.nszCia >= 3 && l.nsz / l.nszCia < 0.5;
    l.solta = l.q === 1;
    l.status = l.q === 1 ? "Solta" : l.nsz >= l.nszCia ? "Completa" : l.gradeQ ? "Quebrada" : "Incompleta";
    l.faltaIdx = [];
    tCia.forEach((tem, j) => { if (tem && !(l.tam[j] > 0)) l.faltaIdx.push(j); });
  }

  // ---- 2. agregações genéricas ----
  function agg(rows) {
    const refs = new Set(), refsQ = new Set(), refsS = new Set();
    let pecas = 0, valor = 0, liq = 0, semFoto = 0, ecom = 0;
    for (const l of rows) {
      pecas += l.q; valor += l.valor; ecom += l.ecom;
      if (l.liqui) liq += l.q;
      if (!l.foto) semFoto += l.q;
      refs.add(l.ref);
      if (l.gradeQ) refsQ.add(l.ref);
      if (l.solta) refsS.add(l.ref);
    }
    return { pecas, refs: refs.size, valor: r2(valor), pecas_liqui: liq, pecas_sem_foto: semFoto,
      refs_grade_quebrada: refsQ.size, refs_peca_solta: refsS.size, ecom };
  }
  const agrupar = (rows, keyFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(r); }
    return m;
  };

  const linhasLoja = linhas.filter(ehLoja);
  const distrib = linhas.filter((l) => DISTRIBUIDORAS.includes(l.filial));

  // ---- 3. completar grade com o CD ----
  const saldoCd = new Map();
  for (const l of distrib) {
    let s = saldoCd.get(l.ref);
    if (!s) { s = new Array(NUM_TAMANHOS).fill(0); saldoCd.set(l.ref, s); }
    l.tam.forEach((x, j) => { s[j] += x; });
  }
  const cdOriginal = new Map([...saldoCd].map(([k, v]) => [k, v.slice()]));
  const pri = { Quebrada: 0, Incompleta: 1, Solta: 2, Completa: 3 };
  const candidatos = linhasLoja.filter((l) => l.faltaIdx.length && saldoCd.has(l.ref))
    .sort((a, b) => pri[a.status] - pri[b.status] || b.q - a.q || a.filial.localeCompare(b.filial));
  const acoesGrade = [];
  for (const l of candidatos) {
    const s = saldoCd.get(l.ref);
    const env = [];
    for (const j of l.faltaIdx) if (s[j] > 0) { s[j] -= 1; env.push("T" + (j + 1)); }
    if (env.length) {
      acoesGrade.push({ filial: l.filial, tipo: l.tipo, ref: l.ref, nome: l.nome, grupo: l.grupo, status: l.status,
        pecas_loja: l.q, falta: l.faltaIdx.map((j) => "T" + (j + 1)).join(","), enviar: env.join(", "), pecas_enviar: env.length });
    }
  }

  // ---- 4. distribuir referências paradas no CD ----
  const lojasDaRef = agrupar(linhasLoja, (l) => l.ref);
  const pecasCdDist = new Map();
  for (const l of distrib) pecasCdDist.set(l.ref, (pecasCdDist.get(l.ref) || 0) + l.q);
  const lojaCatPecas = new Map(); // grupo -> [[filial, pecas]] ordenado
  for (const [g, rows] of agrupar(linhasLoja, (l) => l.grupo)) {
    const m = new Map();
    rows.forEach((l) => m.set(l.filial, (m.get(l.filial) || 0) + l.q));
    lojaCatPecas.set(g, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((x) => x[0]));
  }
  const infoRef = new Map();
  linhas.forEach((l) => { if (!infoRef.has(l.ref)) infoRef.set(l.ref, l); });
  const acoesCd = [];
  for (const [ref, q] of pecasCdDist) {
    const atuais = new Set((lojasDaRef.get(ref) || []).map((l) => l.filial));
    if (q < CD_MIN_PECAS || atuais.size > CD_MAX_LOJAS) continue;
    const info = infoRef.get(ref);
    const porLoja = Math.max(1, nTamCia.get(ref));
    const k = Math.min(CD_MAX_LOJAS_SUGERIDAS, Math.floor(q / porLoja));
    const sug = (lojaCatPecas.get(info.grupo) || []).filter((f) => !atuais.has(f)).slice(0, k);
    acoesCd.push({ ref, nome: info.nome, grupo: info.grupo, liqui: info.liqui ? "Liqui" : "Não liqui", foto: info.foto ? "Com foto" : "Sem foto",
      pecas_cd: q, lojas_atuais: atuais.size, tamanhos: porLoja, lojas_sugeridas: sug.length, pecas_distribuir: sug.length * porLoja, sugestao: sug.join(", ") });
  }
  acoesCd.sort((a, b) => b.pecas_cd - a.pecas_cd);

  // ---- 5. mix loja × categoria ----
  const pecasLoja = new Map(), pecasGrupoRede = new Map(), pecasLojaGrupo = new Map(), tipoLoja = new Map();
  for (const l of linhasLoja) {
    pecasLoja.set(l.filial, (pecasLoja.get(l.filial) || 0) + l.q);
    pecasGrupoRede.set(l.grupo, (pecasGrupoRede.get(l.grupo) || 0) + l.q);
    const k = l.filial + "\u0000" + l.grupo;
    pecasLojaGrupo.set(k, (pecasLojaGrupo.get(k) || 0) + l.q);
    tipoLoja.set(l.filial, l.tipo);
  }
  const totalRede = soma([...pecasGrupoRede.values()]);
  const shareRede = new Map([...pecasGrupoRede].map(([g, q]) => [g, div(q, totalRede)]));
  const acoesMix = [];
  const gruposRelevantes = [...shareRede].filter(([, s]) => s >= MIX_MIN_SHARE_REDE).map(([g]) => g);
  for (const [filial, tot] of pecasLoja) {
    const grupos = new Set(gruposRelevantes);
    for (const k of pecasLojaGrupo.keys()) { const [f, g] = k.split("\u0000"); if (f === filial) grupos.add(g); }
    for (const g of grupos) {
      const q = pecasLojaGrupo.get(filial + "\u0000" + g) || 0;
      const sl = div(q, tot), sr = shareRede.get(g) || 0;
      const difPp = Math.round((sl - sr) * 1000) / 10;
      const gap = Math.round(sr * tot - q);
      if (Math.abs(difPp) >= MIX_MIN_PP && Math.abs(gap) >= MIX_MIN_PECAS) {
        acoesMix.push({ filial, tipo: tipoLoja.get(filial), grupo: g, acao: gap > 0 ? "Reforçar" : "Reduzir", pecas_cat: q,
          share_loja: r4(sl), share_rede: r4(sr), dif_pp: difPp, pecas_ajuste: Math.abs(gap) });
      }
    }
  }
  acoesMix.sort((a, b) => b.pecas_ajuste - a.pecas_ajuste);

  // ---- 6. lojas ----
  const sugPorLoja = new Map();
  acoesCd.forEach((a) => a.sugestao.split(", ").filter(Boolean).forEach((f) => sugPorLoja.set(f, (sugPorLoja.get(f) || 0) + 1)));
  const somaPor = (rows, key, f) => { const m = new Map(); rows.forEach((r) => m.set(r[key], (m.get(r[key]) || 0) + f(r))); return m; };
  const repRefs = somaPor(acoesGrade, "filial", () => 1), repPecas = somaPor(acoesGrade, "filial", (r) => r.pecas_enviar);
  const mixRef = somaPor(acoesMix.filter((r) => r.acao === "Reforçar"), "filial", (r) => r.pecas_ajuste);
  const mixRed = somaPor(acoesMix.filter((r) => r.acao === "Reduzir"), "filial", (r) => r.pecas_ajuste);
  const lojas = [];
  for (const [filial, rows] of agrupar(linhas, (l) => l.filial)) {
    const a = agg(rows);
    lojas.push({ filial, tipo: rows[0].tipo, outlet: rows[0].outlet, ...a,
      prof: r2(div(a.pecas, a.refs)), pct_grade_quebrada: r4(div(a.refs_grade_quebrada, a.refs)), pct_liqui: r4(div(a.pecas_liqui, a.pecas)),
      pct_sem_foto: r4(div(a.pecas_sem_foto, a.pecas)), pct_peca_solta: r4(div(a.refs_peca_solta, a.refs)),
      ncat: new Set(rows.map((r) => r.grupo)).size,
      rep_refs: repRefs.get(filial) || 0, rep_pecas: repPecas.get(filial) || 0, cd_refs_sugeridas: sugPorLoja.get(filial) || 0,
      mix_reforcar: mixRef.get(filial) || 0, mix_reduzir: mixRed.get(filial) || 0 });
  }
  lojas.sort((a, b) => b.pecas - a.pecas);

  // ---- 7. loja × categoria ----
  const lojaCategoria = [];
  const totLoja = somaPor(linhas, "filial", (l) => l.q);
  for (const [, rows] of agrupar(linhas, (l) => l.filial + "\u0000" + l.grupo)) {
    const a = agg(rows);
    lojaCategoria.push({ filial: rows[0].filial, tipo: rows[0].tipo, grupo: rows[0].grupo, ...a,
      share_loja: r4(div(a.pecas, totLoja.get(rows[0].filial))), share_rede: r4(shareRede.get(rows[0].grupo) || 0), prof: r2(div(a.pecas, a.refs)) });
  }

  // ---- 8. categorias por escopo ----
  const categorias = [];
  const escopos = [["Todas", () => true], ["Lojas", ehLoja], ["OMNI", (l) => l.tipo === "OMNI"],
    ["Loja não OMNI", (l) => l.tipo === "Loja não OMNI"], [CD_OUTROS, (l) => l.tipo === CD_OUTROS]];
  for (const [escopo, f] of escopos) {
    const s = linhas.filter(f);
    if (!s.length) continue;
    for (const [grupo, rows] of agrupar(s, (l) => l.grupo)) {
      const a = agg(rows);
      categorias.push({ escopo, grupo, ...a, lojas: new Set(rows.map((r) => r.filial)).size, prof: r2(div(a.pecas, a.refs)) });
    }
    const a = agg(s);
    categorias.push({ escopo, grupo: "TOTAL", ...a, lojas: new Set(s.map((r) => r.filial)).size, prof: r2(div(a.pecas, a.refs)) });
  }

  // ---- 9. grade por categoria (lojas) ----
  const gradeCategoria = [];
  for (const [grupo, rows] of agrupar(linhasLoja, (l) => l.grupo)) {
    const t = new Array(NUM_TAMANHOS).fill(0);
    rows.forEach((l) => l.tam.forEach((x, j) => { t[j] += x; }));
    t.forEach((x, j) => { if (x > 0) gradeCategoria.push({ grupo, tamanho: "T" + (j + 1), pecas: x }); });
  }

  // ---- 10. produtos ----
  const produtosOut = [];
  for (const [ref, rows] of agrupar(linhas, (l) => l.ref)) {
    const i0 = rows[0];
    const lojasRows = rows.filter(ehLoja);
    const pecas = soma(rows.map((r) => r.q)), pecasLojas = soma(lojasRows.map((r) => r.q));
    produtosOut.push({ Ref_Cor: ref, nome: i0.nome, grupo: i0.grupo, linha: i0.linha, preco: i0.preco,
      foto: i0.foto ? "Com foto" : "Sem foto", liqui: i0.liqui ? "Liqui" : "Não liqui",
      pecas, lojas: new Set(lojasRows.map((r) => r.filial)).size, ecom: soma(rows.map((r) => r.ecom)),
      pecas_lojas: pecasLojas, pecas_cd: pecas - pecasLojas, pecas_cd_dist: pecasCdDist.get(ref) || 0 });
  }
  produtosOut.sort((a, b) => b.pecas - a.pecas);

  // ---- 11. produto × loja (com grade e o que o CD tem dos tamanhos que faltam) ----
  // É a base dos filtros do painel: com ela + produtos + lojas o navegador recalcula
  // qualquer combinação de tipo de loja, lojas, categorias e linhas.
  const skuLoja = linhas.map((l) => {
    const loja = ehLoja(l);
    const cd = cdOriginal.get(l.ref);
    return {
      ref: l.ref, filial: l.filial, pecas: l.q, ecom: l.ecom,
      status: l.status,
      falta: loja ? l.faltaIdx.map((j) => "T" + (j + 1)).join(",") : "",
      grade: l.tam.slice(0, ultimoTam.get(l.ref)).join("-"),
      cd: loja && cd ? l.faltaIdx.filter((j) => cd[j] > 0).map((j) => `T${j + 1}:${cd[j]}`).join(" ") : "",
    };
  });

  // ---- 12. resumo das decisões ----
  const soltas = linhasLoja.filter((l) => l.solta && l.nszCia >= 2);
  const defeito = linhas.filter((l) => l.filial === RETORNO_DEFEITO);
  const mixR = acoesMix.filter((r) => r.acao === "Reforçar"), mixD = acoesMix.filter((r) => r.acao === "Reduzir");
  const uniq = (a) => new Set(a).size;
  const decisoes = [
    { id: "grade", ordem: 1, acao: "Completar grade com estoque do CD", pecas: soma(acoesGrade.map((r) => r.pecas_enviar)), refs: uniq(acoesGrade.map((r) => r.ref)), lojas: uniq(acoesGrade.map((r) => r.filial)),
      como: "Enviar 1 peça de cada tamanho que falta na loja, usando o saldo da RJ DISTRIBUIDORA e RJ CQ DISTRIBUIDORA. Prioridade para referências com grade quebrada." },
    { id: "cd", ordem: 2, acao: "Distribuir referências paradas no CD", pecas: soma(acoesCd.map((r) => r.pecas_distribuir)), refs: acoesCd.length, lojas: sugPorLoja.size,
      como: "Referências com 20+ peças no CD e em até 5 lojas. Sugestão: 1 peça por tamanho para as lojas que mais têm a categoria e ainda não têm a referência." },
    { id: "reforcar", ordem: 3, acao: "Reforçar categorias abaixo do mix", pecas: soma(mixR.map((r) => r.pecas_ajuste)), refs: mixR.length, lojas: uniq(mixR.map((r) => r.filial)),
      como: "Loja × categoria 3 p.p. ou mais abaixo do mix médio das lojas. Peças = quanto falta para chegar no mix da rede. Confirmar com a venda antes de mandar." },
    { id: "reduzir", ordem: 4, acao: "Reduzir categorias acima do mix", pecas: soma(mixD.map((r) => r.pecas_ajuste)), refs: mixD.length, lojas: uniq(mixD.map((r) => r.filial)),
      como: "Loja × categoria 3 p.p. ou mais acima do mix das lojas: segurar reposição e usar como origem de transferências." },
    { id: "soltas", ordem: 5, acao: "Consolidar peças soltas", pecas: soma(soltas.map((r) => r.q)), refs: uniq(soltas.map((r) => r.ref)), lojas: uniq(soltas.map((r) => r.filial)),
      como: "Referências com 1 peça só na loja (de produtos com 2+ tamanhos). Juntar na loja que tem mais grade da referência ou mandar para liquidação/outlet." },
    { id: "defeito", ordem: 6, acao: "Destravar retorno de defeito", pecas: soma(defeito.map((r) => r.q)), refs: uniq(defeito.map((r) => r.ref)), lojas: defeito.length ? 1 : 0,
      como: "Peças paradas no RJ RETORNO DEFEITO. Separar o que é conserto, o que volta para loja/outlet e o que é baixa." },
  ];

  // ---- 13. histórico enxuto (loja × categoria) ----
  const historico = lojaCategoria.map((r) => ({ filial: r.filial, grupo: r.grupo, pecas: r.pecas, refs: r.refs, valor: r.valor }));

  const total = categorias.find((c) => c.escopo === "Todas" && c.grupo === "TOTAL") || {};
  return {
    resumo: { linhas: itens.length, pecas: total.pecas || 0, refs: total.refs || 0, locais: lojas.length },
    datasets: {
      lojas, loja_categoria: lojaCategoria, categorias, grade_categoria: gradeCategoria, produtos: produtosOut,
      sku_loja: skuLoja, acoes_grade: acoesGrade, acoes_cd: acoesCd, acoes_mix: acoesMix, decisoes,
    },
    historico,
  };
}

module.exports = { processarEstoque, DATASETS: ["lojas", "loja_categoria", "categorias", "grade_categoria", "produtos", "sku_loja", "acoes_grade", "acoes_cd", "acoes_mix", "decisoes"] };
