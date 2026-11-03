// Regras de pontuação do auditor de VM. Funções puras, sem banco, para a nota ser sempre reproduzível:
// a IA só diz o que viu em cada critério; quem calcula a nota e decide é o sistema.
const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const EM_ANALISE = ["recebida", "analisando"];
const FALHA_IA = ["erro_ia", "ia_indisponivel"];

function calcular({ ambientes, fotos, criterios, avaliacoes, config }) {
  const lim = Number(config.limiar_aprovacao), maxNv = Number(config.max_nv_pct), maxRe = Number(config.max_reenvios);
  const motivos = [];
  const fotoDe = (a) => fotos.find((f) => (f.checklist_id && Number(f.checklist_id) === Number(a.id)) || norm(f.ambiente) === norm(a.ambiente));
  const faltando = ambientes.filter((a) => a.obrigatorio && !fotoDe(a));
  faltando.forEach((a) => motivos.push({ tipo: "foto_faltando", ambiente: a.ambiente, texto: "Falta enviar a foto de " + a.ambiente + "." }));
  const sem = (st, extra) => ({ status: st, score: null, motivos, ...(extra || {}) });
  if (faltando.length) return sem("pendente");
  if (fotos.some((f) => EM_ANALISE.includes(f.status))) return sem("em_analise");
  const falhas = fotos.filter((f) => FALHA_IA.includes(f.status));
  if (falhas.length) { falhas.forEach((f) => motivos.push({ tipo: "ia_indisponivel", ambiente: f.ambiente, texto: "A análise de " + f.ambiente + " não foi concluída (IA indisponível). Será reprocessada." })); return sem("ia_indisponivel"); }
  // foto inutilizável: pede nova foto enquanto houver reenvios; depois disso vai para revisão humana
  let precisaReenviar = false, inutilEsgotado = false;
  for (const f of fotos) {
    if (f.status !== "foto_inutilizavel") continue;
    if (Number(f.rodada) <= maxRe) { precisaReenviar = true; motivos.push({ tipo: "foto_inutilizavel", ambiente: f.ambiente, texto: "A foto de " + f.ambiente + " não pôde ser avaliada: " + (f.observacao_ia || "refaça a foto") }); }
    else { inutilEsgotado = true; motivos.push({ tipo: "foto_inutilizavel_esgotada", ambiente: f.ambiente, texto: "A foto de " + f.ambiente + " continuou inutilizável após os reenvios; precisa de revisão humana." }); }
  }
  if (precisaReenviar) return sem("pendente");
  const crit = criterios.filter((c) => ambientes.some((a) => norm(a.ambiente) === norm(c.ambiente) && fotoDe(a)));
  let wC = 0, wNC = 0, wNV = 0, criticoNC = false, criticoNV = false;
  for (const c of crit) {
    const a = ambientes.find((x) => norm(x.ambiente) === norm(c.ambiente)); const f = fotoDe(a);
    const av = f && f.status === "analisada" ? avaliacoes.find((x) => Number(x.foto_id) === Number(f.id) && Number(x.criterio_id) === Number(c.id)) : null;
    const res = av ? (av.revisado_resultado || av.resultado) : "nao_verificavel";
    const w = Number(c.peso) || 0;
    if (res === "conforme") wC += w;
    else if (res === "nao_conforme") { wNC += w; if (c.critico) criticoNC = true; motivos.push({ tipo: c.critico ? "critico_nao_conforme" : "nao_conforme", ambiente: c.ambiente, criterio_id: Number(c.id), texto: c.descricao, orientacao: av && av.orientacao }); }
    else { wNV += w; if (c.critico) criticoNV = true; motivos.push({ tipo: c.critico ? "critico_nao_verificavel" : "nao_verificavel", ambiente: c.ambiente, criterio_id: Number(c.id), texto: c.descricao }); }
  }
  const total = wC + wNC + wNV;
  const score = wC + wNC > 0 ? Math.round((1000 * wC) / (wC + wNC)) / 10 : null;
  const nvPct = total > 0 ? (100 * wNV) / total : 0;
  const base = { score, limiar: lim, nv_pct: Math.round(nvPct * 10) / 10 };
  if (criticoNC) return { status: "reprovada", motivos, ...base };
  if (!crit.length || score === null) { motivos.push({ tipo: "sem_base", texto: "Não há critérios verificados suficientes para dar uma nota." }); return { status: "revisao_humana", motivos, ...base }; }
  if (inutilEsgotado) return { status: "revisao_humana", motivos, ...base };
  if (criticoNV) { motivos.push({ tipo: "revisao", texto: "Um critério crítico não pôde ser verificado pela foto." }); return { status: "revisao_humana", motivos, ...base }; }
  if (nvPct > maxNv) { motivos.push({ tipo: "revisao", texto: "Muitos critérios não puderam ser verificados (" + Math.round(nvPct) + "% do peso)." }); return { status: "revisao_humana", motivos, ...base }; }
  return { status: score >= lim ? "aprovada" : "reprovada", motivos, ...base };
}

module.exports = { calcular, norm };
