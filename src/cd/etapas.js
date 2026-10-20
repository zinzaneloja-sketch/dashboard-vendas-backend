// Definição única das 12 etapas do processo de entrada de mercadoria no CD, da NF na doca
// até o faturamento. O frontend lê isto em /api/cd/config e monta os formulários sozinho —
// para mudar um campo, um responsável ou uma trava, basta mexer aqui.
//
// perfil  : quem pode iniciar/concluir a etapa (o "gestor" e o admin podem em todas).
// campos  : dados do cabeçalho da etapa (guardados em cd_nota_etapas.dados).
// itens   : colunas de cd_nota_itens que a etapa preenche (só editáveis enquanto ela está em andamento).
// trava   : conferência automática que roda ao concluir (ver cd.js → validarConclusao).
// sla_*   : metas padrão em MINUTOS ÚTEIS (exec = tempo da etapa; fila = espera até começar). São
//           um ponto de partida: o admin ajusta pela tela (tabela cd_etapa_config).

// Cada etapa é uma MESA: um login (ou mais) por etapa, que só enxerga a fila e o histórico da própria mesa.
// "gestor" é o CONSOLIDADO: enxerga tudo (painel geral, gargalos, fornecedores, PDF da nota), reabre, cancela
// e aprova divergência. Só o admin libera esse perfil para outros logins.
const PERFIS = {
  recebimento: "Mesa 1 · Recebimento da NF",
  separacao: "Mesa 2 · Fardos e separação",
  contagem: "Mesa 3 · Contagem",
  referencia: "Mesa 4 · Referência Zinzane",
  etiquetas: "Mesa 5 · Etiquetas",
  pedido: "Mesa 6 · Pedido",
  entrada: "Mesa 7 · Entrada da nota",
  checkout: "Mesa 8 · Checkout",
  confronto: "Mesa 9 · Confronto",
  distribuicao: "Mesa 10 · Distribuição",
  picking: "Mesa 11 · Picking e pack",
  faturamento: "Mesa 12 · Faturamento e trânsito (aba própria)",
  gestor: "Consolidado (gestor)",
};
// Perfis antigos (agrupados) viram as mesas equivalentes: ninguém perde acesso na migração.
const PERFIS_LEGADO = {
  doca: ["recebimento", "separacao", "contagem"],
  estilo: ["referencia"],
  cadastro: ["etiquetas", "pedido", "entrada", "checkout", "confronto"],
  expedicao: ["distribuicao", "picking", "faturamento"],
};

const ETAPAS = [
  { n: 1, chave: "recebimento", nome: "Recebimento da NF na doca", perfil: "recebimento", sla_exec_min: 20, sla_fila_min: 30,
    ajuda: "Registre a NF assim que o caminhão chegar. A nota nasce aqui." },
  // Abertura dos fardos e separação acontecem juntas: abre-se um fardo, separa-se o que saiu dele,
  // abre-se o próximo. O contador de fardos sobe a cada fardo aberto e é conferido com os volumes no fim.
  { n: 2, chave: "separacao", nome: "Abertura dos fardos e separação", perfil: "separacao", sla_exec_min: 105, sla_fila_min: 60,
    campos: [
      { k: "fardos_abertos", label: "Fardos abertos", tipo: "int", obrigatorio: true },
      { k: "trocar_composicao", label: "Trocar etiqueta de composição", tipo: "bool" },
      { k: "trocar_marca", label: "Trocar etiqueta de marca", tipo: "bool" },
      { k: "trocar_codbarras", label: "Trocar código de barras", tipo: "bool" },
      { k: "avarias", label: "Avarias / observações", tipo: "texto" },
    ],
    itens: ["modelo", "ref_fornecedor", "cor_codigo", "tamanho", "ref_zinzane", "amostra_separada"],
    trava: "fardos_vs_volumes",
    ajuda: "Abra um fardo por vez: toque em \"+1 fardo aberto\" e cadastre o que saiu dele: cada produto da NF é desmembrado em cores e tamanhos (só marque os que vieram, sem quantidade; as peças são contadas na próxima etapa), e marque em cada linha a peça que já foi separada e entregue ao Estilo. Os produtos já vêm da NF. Repita até abrir todos. No fim, os fardos abertos precisam bater com os volumes recebidos." },
  { n: 3, chave: "contagem", nome: "Contagem", perfil: "contagem", paralela: true, sla_exec_min: 90, sla_fila_min: 60,
    itens: ["qtd_contada", "contado_por", "qtd_defeito", "qtd_conserto"], trava: "contagem_vs_nf",
    ajuda: "Informe a quantidade contada de cada produto, cor e tamanho e o nome de quem contou. A contagem inclui as peças com defeito e as que vão para conserto: informe quantas são de cada uma nos campos de cada linha. Conjuntos contam 2 peças. Havendo diferença com a NF, o sistema avisa e pede a RECONTAGEM: cada recontagem fica registrada com o nome de quem recontou e o número da tentativa." },

  { n: 4, chave: "referencia", nome: "Definir a referência Zinzane", perfil: "referencia", paralela: true, sla_exec_min: 60, sla_fila_min: 120,
    itens: ["cor_def_codigo", "ref_zinzane"],
    ajuda: "Informe a referência Zinzane de cada produto e cor (os tamanhos vêm juntos). A cor já vem da separação; só troque se o Estilo definir outra, escolhendo no catálogo." },
  { n: 5, chave: "etiquetas", nome: "Rodar as etiquetas", perfil: "etiquetas", paralela: true, sla_exec_min: 30, sla_fila_min: 60,
    campos: [
      { k: "trocas_confirmadas", label: "Confirmo as trocas de etiqueta pedidas na separação", tipo: "bool", so_trocas: true },
      { k: "etiquetas_obs", label: "Observações", tipo: "texto" },
    ],
    lotes: true,
    trava: "etiquetas_vs_contagem",
    ajuda: "As etiquetas começam enquanto a contagem ainda está rodando: registre cada LOTE impresso (quantas peças, quem etiquetou). Só dá para etiquetar o que já foi contado e já tem referência Zinzane. A etapa só conclui depois que a contagem e a referência estiverem concluídas e o total etiquetado for igual ao total contado. Se a separação pediu troca de etiqueta de composição, de marca ou de código de barras, confirme que foi feita." },
  { n: 6, chave: "pedido", nome: "Gerar o pedido", perfil: "pedido", sla_exec_min: 20, sla_fila_min: 60,
    campos: [{ k: "numero_pedido", label: "Nº do pedido", tipo: "texto", obrigatorio: true }] },
  { n: 7, chave: "entrada", nome: "Entrada da nota", perfil: "entrada", sla_exec_min: 30, sla_fila_min: 60,
    campos: [{ k: "numero_entrada", label: "Nº da entrada", tipo: "texto", obrigatorio: true }] },
  { n: 8, chave: "checkout", nome: "Checkout", perfil: "checkout", sla_exec_min: 60, sla_fila_min: 60,
    itens: ["qtd_checkout"],
    ajuda: "Informe a quantidade de cada modelo, cor e tamanho que passou no checkout." },
  { n: 9, chave: "confronto", nome: "Confronto: checkout × contagem", perfil: "confronto", sla_exec_min: 20, sla_fila_min: 30,
    itens: ["justificativa_confronto"], trava: "checkout_vs_contagem",
    ajuda: "O sistema compara automaticamente. Havendo diferença, justifique cada linha; só o gestor encerra com divergência." },
  { n: 10, chave: "distribuicao", nome: "Distribuição", perfil: "distribuicao", sla_exec_min: 30, sla_fila_min: 60,
    campos: [
      { k: "total_distribuido", label: "Peças distribuídas", tipo: "int", obrigatorio: true },
      { k: "destinos", label: "Destinos (lojas / CD)", tipo: "texto", obrigatorio: true },
    ],
    trava: "distribuicao_vs_checkout" },
  { n: 11, chave: "picking", nome: "Picking e Pack", perfil: "picking", sla_exec_min: 90, sla_fila_min: 60,
    campos: [
      { k: "pecas_embaladas", label: "Peças embaladas", tipo: "int", obrigatorio: true },
      { k: "volumes_saida", label: "Volumes de saída", tipo: "int", obrigatorio: true },
    ],
    trava: "pack_vs_distribuicao" },
];

const TRAVAS = {
  fardos_vs_volumes: "Fardos abertos × volumes recebidos",
  contagem_vs_nf: "Total contado × total da NF",
  etiquetas_vs_contagem: "Etiquetas × total contado",
  checkout_vs_contagem: "Checkout × contagem",
  distribuicao_vs_checkout: "Distribuído × checkout",
  pack_vs_distribuicao: "Embalado × distribuído",
};

const ITEM_CAMPOS = {
  modelo: "texto", ref_fornecedor: "texto", cor: "texto", cor_codigo: "texto", tamanho: "texto", qtd_nf: "int", qtd_defeito: "int", qtd_conserto: "int", qtd_contada: "int", contado_por: "texto", qtd_ficha: "int", qtd_checkout: "int",
  amostra_separada: "bool", cor_definida: "texto", cor_def_codigo: "texto", ref_zinzane: "texto", justificativa_confronto: "texto",
};

// Grade de tamanhos da ficha de papel: cada coluna tem o tamanho de letra e o numerico equivalente.
// Único e PP são colunas separadas. Linhas antigas que ficaram como "Único/PP" continuam abrindo (o valor é tolerado).
const TAMANHOS_INFO = [
  { t: "Único", num: "Único" }, { t: "PP", num: "34" }, { t: "P", num: "36" }, { t: "M", num: "38" }, { t: "G", num: "40" }, { t: "GG", num: "42" },
  { t: "XG", num: "44" }, { t: "XGG", num: "46" }, { t: "48", num: "48" }, { t: "50", num: "50" }, { t: "52", num: "52" },
];
const TAMANHOS = TAMANHOS_INFO.map((x) => x.t);
const semAcento = (v) => String(v || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
// Aceita também apelidos (único, pp, 34, xxg...) e devolve o nome padrão da coluna.
const ALIAS_TAM = { u: "Único", "34": "PP", "36": "P", "38": "M", "40": "G", "42": "GG", "44": "XG", xxg: "XGG", "46": "XGG" };
const tamanhoCanonico = (t) => {
  const k = semAcento(t);
  return TAMANHOS.find((x) => semAcento(x) === k) || ALIAS_TAM[k] || null;
};

const etapaPorNumero = (n) => ETAPAS.find((e) => e.n === Number(n));
// Número da etapa a partir da chave (o código nunca deve fixar "etapa 12": os números mudam se o processo mudar).
const numeroDe = (chave) => (ETAPAS.find((e) => e.chave === chave) || {}).n;

const FRENTE = ETAPAS.filter((e) => e.paralela).map((e) => e.n); // etapas que rodam em paralelo (contagem, referência, etiquetas)

module.exports = { PERFIS, PERFIS_LEGADO, FRENTE, ETAPAS, TRAVAS, ITEM_CAMPOS, TAMANHOS, TAMANHOS_INFO, tamanhoCanonico, etapaPorNumero, numeroDe };
