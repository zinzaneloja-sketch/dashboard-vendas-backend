// Vendas por GO: relatórios prontos para WhatsApp (Diretoria → grupo das GOs · GO → gerentes de cada loja).
// O servidor só monta o texto; quem envia é a pessoa, pelo botão "Enviar no WhatsApp" (nada é enviado sozinho).
const V = require("./vendasgo");
const { erro, addDias, iniMes, fimMes, dow, diasEntre, segunda, S, somaS, ZERO, ticket, pa, varPct } = V;

// ---------- formatação (pt-BR) ----------
const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const dd = (s) => s.slice(8, 10) + "/" + s.slice(5, 7);
const diaSem = (s) => DIAS[dow(s)];
const milhar = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const dec = (n, c = 1) => Number(n).toFixed(c).replace(".", ",");
const brl = (v) => (v === null || v === undefined || isNaN(v) ? "—" : Math.abs(v) >= 1e6 ? "R$ " + dec(v / 1e6, 2) + " mi" : "R$ " + milhar(v));
const brl2 = (v) => (v === null || v === undefined || isNaN(v) ? "—" : "R$ " + dec(v, 2).replace(/\B(?=(\d{3})+(?!\d))/g, "."));
const pct = (v) => (v === null || v === undefined || isNaN(v) ? "sem base de comparação" : (Math.abs(v) < 0.05 ? "⚪ 0,0%" : (v > 0 ? "🟢 +" : "🔴 −") + dec(Math.abs(v), 1) + "%"));
const primeiro = (n) => { const t = String(n || "").trim().split(/\s+/)[0] || ""; return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : ""; };
const saudacao = () => { const h = new Date(Date.now() - 3 * 3600e3).getUTCHours(); return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"; };
const medalha = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + "º");
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

// ---------- coleta ----------
const JANELAS = ["dia", "diaAnt", "sem", "semAnt", "mes", "mesAnt", "maTot"];
async function coletar(p, filtros) {
  const base = await V.dataBaseVendas();
  if (!base) throw erro(409, "Ainda não há vendas sincronizadas. Atualize os dados primeiro.");
  const lojas = await V.lojasDoEscopo(p, filtros || {});
  if (!lojas.length) throw erro(404, "Nenhuma loja encontrada para esse filtro.");
  const hoje = V.hojeSP();
  const mI = iniMes(base), maI = iniMes(addDias(mI, -1)), maF = addDias(mI, -1);
  const maMesmo = addDias(maI, Math.min(diasEntre(mI, base), diasEntre(maI, maF)));
  // Semana: seg → data-base. Se a data-base é segunda, usa a semana fechada anterior (seg–dom), para não comparar um dia só.
  const fechada = dow(base) === 1;
  const sI = fechada ? addDias(segunda(base), -7) : segunda(base), sF = fechada ? addDias(segunda(base), -1) : base;
  const win = { dia: [base, base], diaAnt: [addDias(base, -7), addDias(base, -7)], sem: [sI, sF], semAnt: [addDias(sI, -7), addDias(sF, -7)], mes: [mI, base], mesAnt: [maI, maMesmo], maTot: [maI, maF] };
  const cods = lojas.map((l) => l.cod);
  const sm = await V.somas(win, cods), pj = await V.projecoes(cods, base);
  const itens = lojas.map((l) => {
    const r = sm.get(l.cod); const w = {}; JANELAS.forEach((k) => { w[k] = S(r, k); });
    return { ...l, w, projecao: pj.get(l.cod) || 0 };
  });
  const restantes = Math.max(0, diasEntre(base, fimMes(base)));
  return { base, hoje, ontem: base === addDias(hoje, -1), win, semFechada: fechada, restantes, mesFechado: restantes === 0, itens, seed: Number(base.slice(8)) + Number(base.slice(5, 7)) };
}
function agrega(itens) {
  const w = {}; JANELAS.forEach((k) => { w[k] = itens.reduce((a, i) => somaS(a, i.w[k]), ZERO()); });
  const projecao = itens.reduce((a, i) => a + i.projecao, 0);
  const hcN = itens.reduce((a, i) => a + (i.hc_necessario || 0), 0), hcR = itens.reduce((a, i) => a + (i.hc_real || 0), 0);
  return { lojas: itens.length, w, projecao, hcN, hcR, hcFalta: itens.filter((i) => i.hc_real !== null && i.hc_necessario !== null && i.hc_real < i.hc_necessario).length };
}
// Indicadores de uma janela: venda, variação contra a janela anterior, ticket, PA
function ind(a, k, ant) { const x = a.w[k], y = a.w[ant]; return { venda: x.venda, ant: y.venda, var: varPct(x.venda, y.venda), ticket: ticket(x), pa: pa(x), tickets: x.tickets }; }
function resumo(a, c) {
  const dia = ind(a, "dia", "diaAnt"), sem = ind(a, "sem", "semAnt"), mes = ind(a, "mes", "mesAnt");
  const maTot = a.w.maTot.venda;
  const faltaIgualar = Math.max(0, maTot - a.w.mes.venda);
  return { dia, sem, mes, projecao: a.projecao, var_projecao: varPct(a.projecao, maTot), mes_anterior_total: maTot, falta_igualar: faltaIgualar, falta_por_dia: c.restantes > 0 ? faltaIgualar / c.restantes : null, ja_passou: a.w.mes.venda >= maTot };
}

// ---------- blocos de texto ----------
const rotulos = (c) => {
  const w = c.win;
  return {
    dia: c.ontem ? `ONTEM (${diaSem(c.base)} ${dd(c.base)})` : `ÚLTIMO DIA COM VENDA (${diaSem(c.base)} ${dd(c.base)})`,
    diaVs: `vs ${diaSem(w.diaAnt[0])} passada`,
    sem: c.semFechada ? `SEMANA PASSADA (${dd(w.sem[0])} a ${dd(w.sem[1])})` : `SEMANA (${dd(w.sem[0])} a ${dd(w.sem[1])})`,
    semVs: "vs semana anterior",
    mes: `MÊS (${dd(w.mes[0])} a ${dd(w.mes[1])})`,
    mesVs: "vs mesmo período do mês passado",
  };
};
function blocoIndicadores(r, c) {
  const L = rotulos(c); const out = [];
  const lin = (tit, i, vs) => { out.push(`*${tit}*`); out.push(`💰 ${brl(i.venda)}  ${pct(i.var)} ${vs}`); out.push(`🧾 Ticket ${brl2(i.ticket)} · PA ${i.pa === null ? "—" : dec(i.pa, 2)}`); out.push(""); };
  lin(L.dia, r.dia, L.diaVs); lin(L.sem, r.sem, L.semVs); lin(L.mes, r.mes, L.mesVs);
  out.push(`🎯 *Projeção de fechamento:* ${brl(r.projecao)} (${pct(r.var_projecao)} vs mês passado fechado)`);
  if (c.restantes > 0) {
    if (r.ja_passou) out.push(`✅ Já passamos o total do mês passado (${brl(r.mes_anterior_total)}). Agora é ampliar a vantagem.`);
    else out.push(`⏳ Para igualar o mês passado faltam ${brl(r.falta_igualar)} — são *${brl(r.falta_por_dia)} por dia* nos ${c.restantes} dias que restam.`);
  }
  return out.join("\n");
}
const cortaLinhas = (t) => t.replace(/\n{3,}/g, "\n\n").trim();

function puxadaRede(r, c, pior) {
  const sobe = r.mes.var !== null && r.mes.var >= 0;
  const falta = c.restantes > 0 && !r.ja_passou ? `Faltam *${brl(r.falta_por_dia)} por dia* pra igualar o mês passado.` : "";
  const lojasRuim = pior.length ? `Olhem as lojas em vermelho (${pior.slice(0, 3).map((x) => x.nome).join(", ")}): ligação pra gerente *antes da abertura*, meta do dia combinada e retorno até o meio-dia.` : "Sigam checando loja a loja antes da abertura: meta do dia combinada e retorno até o meio-dia.";
  const semBase = r.mes.var === null;
  const abre = semBase ? pick([`Time, o mês está rodando e cada dia conta. Vamos acelerar já hoje. 🚀`, `Resultado se constrói todo dia: hoje é dia de vender mais que ontem. 🔥`], c.seed) : sobe
    ? pick([`Time, estamos ${dec(r.mes.var, 1)}% acima do mês passado — mas quem joga pra ganhar não comemora, acelera. 🚀`, `Resultado bom não é teto, é piso. Estamos +${dec(r.mes.var, 1)}% à frente do mês passado e dá pra abrir ainda mais vantagem. 🔥`, `Estamos no azul (+${dec(r.mes.var, 1)}%), e o azul só vale se fechar o mês no azul. Bora segurar o ritmo! 💪`], c.seed)
    : pick([`Time, estamos ${dec(Math.abs(r.mes.var === null ? 0 : r.mes.var), 1)}% abaixo do mês passado. Dá pra virar — mas só com ação HOJE. 🚨`, `O mês ainda não acabou e a virada começa hoje. Estamos ${dec(Math.abs(r.mes.var === null ? 0 : r.mes.var), 1)}% atrás: cada GO tem que olhar a sua régua agora. ⚡`, `Sem drama e sem desculpa: estamos ${dec(Math.abs(r.mes.var === null ? 0 : r.mes.var), 1)}% abaixo e o que decide é o que acontece nos próximos dias. 🎯`], c.seed);
  return [`*🔥 PUXADA DO DIA*`, abre, falta, lojasRuim, `Venda que não foi feita hoje não volta amanhã. Cada atendimento conta, cada peça a mais no ticket conta. *Quero ver movimento em todas as lojas até o fim do dia!* 👊`].filter(Boolean).join("\n");
}

function rankingGos(gos, c, texto) {
  const lista = gos.slice().sort((a, b) => (b.r.mes.var === null ? -1e9 : b.r.mes.var) - (a.r.mes.var === null ? -1e9 : a.r.mes.var));
  const linhas = lista.map((g, i) => `${medalha(i)} *${g.go}* — ${brl(g.r.mes.venda)} no mês ${pct(g.r.mes.var)} · proj. ${brl(g.r.projecao)}`);
  return { lista, linhas };
}

// ---------- mensagem da Diretoria para o grupo das GOs ----------
function msgRede(c, itens, gos, titulo) {
  const a = agrega(itens), r = resumo(a, c);
  const cab = `*📊 ${titulo || "RESULTADO DA REDE"} — ${diaSem(c.hoje)} ${dd(c.hoje)}*`;
  const { linhas } = rankingGos(gos, c);
  const comBase = itens.filter((i) => i.w.mesAnt.venda > 0).map((i) => ({ nome: i.nome, v: varPct(i.w.mes.venda, i.w.mesAnt.venda) }));
  const piores = comBase.filter((x) => x.v !== null && x.v < 0).sort((x, y) => x.v - y.v), melhores = comBase.filter((x) => x.v !== null && x.v > 0).sort((x, y) => y.v - x.v);
  const aten = [];
  aten.push(`📉 ${piores.length} de ${itens.length} lojas estão abaixo do mês passado.`);
  piores.slice(0, 5).forEach((x) => aten.push(`   • ${x.nome} ${pct(x.v)}`));
  if (a.hcFalta) aten.push(`👥 ${a.hcFalta} loja(s) com equipe abaixo do quadro necessário (${a.hcR} de ${a.hcN} pessoas na rede).`);
  const dest = melhores.slice(0, 3).map((x) => `${x.nome} ${pct(x.v)}`);
  const txt = [cab, "", blocoIndicadores(r, c), "", "*🏆 RANKING DAS GOs (crescimento no mês)*", ...linhas, "", ...(dest.length ? ["*⭐ DESTAQUES*", ...dest.map((d) => "• " + d), ""] : []), "*⚠️ PONTOS DE ATENÇÃO*", ...aten, "", puxadaRede(r, c, piores)].join("\n");
  return { texto: cortaLinhas(txt), resumo: r };
}

// ---------- mensagem de uma GO (cópia para a Diretoria cobrar uma GO específica) ----------
function msgGo(c, itens, go, posicao, total) {
  const a = agrega(itens), r = resumo(a, c);
  const comBase = itens.map((i) => ({ nome: i.nome, v: varPct(i.w.mes.venda, i.w.mesAnt.venda), venda: i.w.mes.venda })).sort((x, y) => (y.v === null ? -1e9 : y.v) - (x.v === null ? -1e9 : x.v) || y.venda - x.venda);
  const rk = comBase.map((x, i) => `${medalha(i)} ${x.nome} — ${brl(x.venda)} ${pct(x.v)}`);
  const piores = comBase.filter((x) => x.v !== null && x.v < 0).reverse();
  const pos = posicao ? `Você está em *${posicao}º de ${total}* GOs no crescimento do mês.` : "";
  const txt = [`*📊 ${go.toUpperCase()} — ${diaSem(c.hoje)} ${dd(c.hoje)}*`, pos, "", blocoIndicadores(r, c), "", "*🏪 RANKING DAS SUAS LOJAS (mês)*", ...rk, "", ...(a.hcFalta ? [`👥 ${a.hcFalta} loja(s) com equipe abaixo do quadro.`, ""] : []), puxadaRede(r, c, piores.map((p) => ({ nome: p.nome })))].join("\n");
  return { texto: cortaLinhas(txt), resumo: r };
}

// ---------- mensagem de uma loja (GO → gerente) ----------
function msgLoja(c, l, irmaos) {
  const a = agrega([l]), r = resumo(a, c); const ag = agrega(irmaos), rg = resumo(ag, c);
  const ordem = irmaos.map((i) => ({ cod: i.cod, v: varPct(i.w.mes.venda, i.w.mesAnt.venda) })).sort((x, y) => (y.v === null ? -1e9 : y.v) - (x.v === null ? -1e9 : x.v));
  const pos = ordem.findIndex((x) => x.cod === l.cod) + 1;
  const nome = primeiro(l.gerente);
  const sobe = r.mes.var !== null && r.mes.var >= 0;
  const dicas = [];
  const paLoja = r.mes.pa, paGo = rg.mes.pa, tkLoja = r.mes.ticket, tkGo = rg.mes.ticket;
  if (paLoja !== null && paGo !== null && paLoja < paGo - 0.05) dicas.push(`PA da loja ${dec(paLoja, 2)} contra ${dec(paGo, 2)} da média da GO: *sugira a segunda peça em todo atendimento* (look completo, acessório no caixa).`);
  if (tkLoja !== null && tkGo !== null && tkLoja < tkGo * 0.95) dicas.push(`Ticket médio ${brl2(tkLoja)} abaixo da média da GO (${brl2(tkGo)}): trabalhe venda adicional e peças de maior valor.`);
  if (l.hc_real !== null && l.hc_necessario !== null && l.hc_real < l.hc_necessario) dicas.push(`Equipe com ${l.hc_real} de ${l.hc_necessario} pessoas: organizem os horários de pico e ninguém fica sem cliente no salão.`);
  const meta = c.restantes > 0 && !r.ja_passou && r.falta_por_dia !== null ? `🎯 *Meta pra hoje:* ${brl(r.falta_por_dia)} (é o que falta por dia pra igualar o mês passado).` : (r.ja_passou && c.restantes > 0 ? `🎯 Já passamos o mês passado! Meta pra hoje: bater ${brl(r.mes.venda / Math.max(1, diasEntre(c.win.mes[0], c.base) + 1))} (nossa média diária do mês) ou mais.` : "");
  const abre = r.mes.var === null ? `hoje é dia de vender mais que ontem: foco total em atendimento e conversão. 🎯` : sobe
    ? pick([`parabéns pelo resultado! Mas a gente joga pra ganhar o mês inteiro. 🚀`, `a loja está no azul, vamos abrir ainda mais vantagem! 🔥`, `bom trabalho! Agora é manter o ritmo e fechar o mês lá em cima. 💪`], c.seed + l.cod.length)
    : pick([`a loja está abaixo do mês passado, mas dá pra virar com ação já hoje. 💥`, `precisamos acelerar. O mês ainda tem dias e eu sei que a sua equipe consegue reagir. ⚡`, `hoje é dia de virar a chave: foco total em atendimento e conversão. 🎯`], c.seed + l.cod.length);
  const txt = [`${saudacao()}${nome ? ", " + nome : ""}! 👋`, `*${l.nome}* — resultado até ${diaSem(c.base)} ${dd(c.base)}`, "", blocoIndicadores(r, c).replace(/\n⏳.*|\n✅.*/g, ""), "",
    `🏅 *Posição na GO:* ${pos}º de ${irmaos.length} lojas no crescimento do mês.`, ...(l.hc_real !== null && l.hc_necessario !== null ? [`👥 Quadro: ${l.hc_real} de ${l.hc_necessario}${l.hc_real < l.hc_necessario ? " (faltam " + (l.hc_necessario - l.hc_real) + ")" : ""}`] : []), "",
    meta, ...(dicas.length ? ["", "*💡 Onde ganhar hoje*", ...dicas.map((d) => "• " + d)] : []), "", `${nome ? nome + ", " : ""}${abre}`, `Conto com você e com o time. *Vamos pra cima!* 👊`].join("\n");
  return { texto: cortaLinhas(txt), resumo: r, posicao: pos };
}

// ---------- API ----------
async function geral(acc, q = {}) {
  const p = await V.papelDe(acc); V.exigirDiretoria(p);
  const c = await coletar(p, { cluster: q.cluster, uf: q.uf, regiao: q.regiao });
  const porGo = new Map(); c.itens.forEach((i) => { const k = (i.go || "").trim() || "(sem GO)"; if (!porGo.has(k)) porGo.set(k, []); porGo.get(k).push(i); });
  const gos = [...porGo.entries()].map(([go, it]) => ({ go, itens: it, r: resumo(agrega(it), c) }));
  const rede = msgRede(c, c.itens, gos);
  const ord = gos.slice().sort((a, b) => (b.r.mes.var === null ? -1e9 : b.r.mes.var) - (a.r.mes.var === null ? -1e9 : a.r.mes.var));
  const porGoMsgs = ord.map((g, i) => { const m = msgGo(c, g.itens, g.go, i + 1, ord.length); return { go: g.go, lojas: g.itens.length, texto: m.texto, mes_var: g.r.mes.var, venda_mes: g.r.mes.venda, projecao: g.r.projecao }; });
  return { data_base: c.base, ontem: c.ontem, lojas: c.itens.length, rede: { texto: rede.texto, ...rede.resumo }, por_go: porGoMsgs };
}
async function lojas(acc, q = {}) {
  const p = await V.papelDe(acc); V.exigirGO(p);
  const c = await coletar(p, { go: q.go, cluster: q.cluster, uf: q.uf, regiao: q.regiao });
  const porGo = new Map(); c.itens.forEach((i) => { const k = (i.go || "").trim() || "(sem GO)"; if (!porGo.has(k)) porGo.set(k, []); porGo.get(k).push(i); });
  const out = c.itens.map((l) => { const m = msgLoja(c, l, porGo.get((l.go || "").trim() || "(sem GO)")); return { cod: l.cod, nome: l.nome, go: l.go, gerente: l.gerente, whatsapp: l.gerente_whatsapp, texto: m.texto, posicao: m.posicao, mes_var: m.resumo.mes.var, venda_mes: m.resumo.mes.venda, venda_dia: m.resumo.dia.venda }; });
  out.sort((a, b) => (a.go || "").localeCompare(b.go || "", "pt-BR") || (b.mes_var === null ? -1e9 : b.mes_var) - (a.mes_var === null ? -1e9 : a.mes_var));
  return { data_base: c.base, ontem: c.ontem, lojas: out };
}

module.exports = { geral, lojas, _fmt: { brl, pct, dec } };
