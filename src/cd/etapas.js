// Definição única das 14 etapas do processo de entrada de mercadoria no CD, da NF na doca
// até o faturamento. O frontend lê isto em /api/cd/config e monta os formulários sozinho —
// para mudar um campo, um responsável ou uma trava, basta mexer aqui.
//
// perfil  : quem pode iniciar/concluir a etapa (o "gestor" e o admin podem em todas).
// campos  : dados do cabeçalho da etapa (guardados em cd_nota_etapas.dados).
// itens   : colunas de cd_nota_itens que a etapa preenche (só editáveis enquanto ela está em andamento).
// trava   : conferência automática que roda ao concluir (ver cd.js → validarConclusao).
// sla_*   : metas padrão em MINUTOS ÚTEIS (exec = tempo da etapa; fila = espera até começar). São
//           um ponto de partida: o admin ajusta pela tela (tabela cd_etapa_config).

const PERFIS = {
  doca: "Doca e separação",
  estilo: "Estilo / produto",
  cadastro: "Etiquetas, pedido e entrada",
  expedicao: "Expedição e faturamento",
  gestor: "Gestor",
};

const ETAPAS = [
  { n: 1, chave: "recebimento", nome: "Recebimento da NF na doca", perfil: "doca", sla_exec_min: 20, sla_fila_min: 30,
    ajuda: "Registre a NF assim que o caminhão chegar. A nota nasce aqui." },
  // Abertura dos fardos e separação acontecem juntas: abre-se um fardo, separa-se o que saiu dele,
  // abre-se o próximo. O contador de fardos sobe a cada fardo aberto e é conferido com os volumes no fim.
  { n: 2, chave: "separacao", nome: "Abertura dos fardos e separação", perfil: "doca", sla_exec_min: 105, sla_fila_min: 60,
    campos: [
      { k: "fardos_abertos", label: "Fardos abertos", tipo: "int", obrigatorio: true },
      { k: "trocar_composicao", label: "Trocar etiqueta de composição", tipo: "bool" },
      { k: "trocar_marca", label: "Trocar etiqueta de marca", tipo: "bool" },
      { k: "trocar_codbarras", label: "Trocar código de barras", tipo: "bool" },
      { k: "avarias", label: "Avarias / observações", tipo: "texto" },
    ],
    itens: ["modelo", "ref_fornecedor", "cor_codigo", "tamanho", "ref_zinzane"],
    trava: "fardos_vs_volumes",
    ajuda: "Abra um fardo por vez: toque em \"+1 fardo aberto\" e cadastre o que saiu dele: cada produto da NF é desmembrado em cores e tamanhos (só marque os que vieram, sem quantidade; as peças são contadas na próxima etapa). Os produtos já vêm da NF. Repita até abrir todos. No fim, os fardos abertos precisam bater com os volumes recebidos." },
  { n: 3, chave: "contagem", nome: "Contagem", perfil: "doca", sla_exec_min: 90, sla_fila_min: 60,
    campos: [
      { k: "recontagem_metodo", label: "Recontagem feita por", tipo: "select", opcoes: [["manual", "Recontagem manual"], ["checkout", "Checkout"]], so_divergencia: true },
      { k: "recontagem_total", label: "Total recontado (peças)", tipo: "int", so_divergencia: true },
      { k: "recontagem_por", label: "Quem recontou (nome)", tipo: "texto", so_divergencia: true },
    ],
    itens: ["qtd_contada", "contado_por", "qtd_defeito", "qtd_conserto"], trava: "contagem_vs_nf",
    ajuda: "Informe a quantidade contada de cada produto, cor e tamanho e o nome de quem contou. A contagem inclui as peças com defeito e as que vão para conserto: informe quantas são de cada uma nos campos de cada linha. Conjuntos contam 2 peças. Havendo diferença com a NF, o sistema pede a recontagem." },
  { n: 4, chave: "ficha", nome: "Preenchimento da ficha", perfil: "doca", sla_exec_min: 30, sla_fila_min: 30,
    campos: [{ k: "ficha_numero", label: "Nº da ficha", tipo: "texto", obrigatorio: true }],
    itens: ["qtd_ficha"], trava: "ficha_vs_contagem",
    ajuda: "Digite aqui o que foi anotado na ficha de papel. Esta é a base da conferência final (confronto do checkout)." },
  { n: 5, chave: "amostra", nome: "Separação de 1 peça para o Estilo", perfil: "doca", sla_exec_min: 20, sla_fila_min: 30,
    itens: ["amostra_separada"],
    ajuda: "Marque cada modelo, cor e tamanho que já teve 1 peça separada e entregue ao Estilo." },
  { n: 6, chave: "referencia", nome: "Definir a referência Zinzane", perfil: "estilo", sla_exec_min: 60, sla_fila_min: 120,
    itens: ["cor_definida", "ref_zinzane"],
    ajuda: "Defina a cor e a referência Zinzane de cada linha." },
  { n: 7, chave: "etiquetas", nome: "Rodar as etiquetas", perfil: "cadastro", sla_exec_min: 30, sla_fila_min: 60,
    campos: [
      { k: "gerou_etiqueta", label: "Gerou etiqueta?", tipo: "select", opcoes: [["sim", "Sim"], ["nao", "Não"]], obrigatorio: true },
      { k: "etiquetas_impressas", label: "Etiquetas impressas", tipo: "int", obrigatorio: true },
      { k: "trocas_confirmadas", label: "Confirmo as trocas de etiqueta pedidas na separação", tipo: "bool", so_trocas: true },
      { k: "etiquetas_obs", label: "Observações", tipo: "texto" },
    ],
    trava: "etiquetas_vs_ficha",
    ajuda: "Informe quantas etiquetas foram impressas. Precisa bater com o total da ficha. Se a separação pediu troca de etiqueta de composição, de marca ou de código de barras, confirme que foi feita." },
  { n: 8, chave: "pedido", nome: "Gerar o pedido", perfil: "cadastro", sla_exec_min: 20, sla_fila_min: 60,
    campos: [{ k: "numero_pedido", label: "Nº do pedido", tipo: "texto", obrigatorio: true }] },
  { n: 9, chave: "entrada", nome: "Entrada da nota", perfil: "cadastro", sla_exec_min: 30, sla_fila_min: 60,
    campos: [{ k: "numero_entrada", label: "Nº da entrada", tipo: "texto", obrigatorio: true }] },
  { n: 10, chave: "checkout", nome: "Checkout", perfil: "cadastro", sla_exec_min: 60, sla_fila_min: 60,
    itens: ["qtd_checkout"],
    ajuda: "Informe a quantidade de cada modelo, cor e tamanho que passou no checkout." },
  { n: 11, chave: "confronto", nome: "Confronto: checkout × ficha", perfil: "cadastro", sla_exec_min: 20, sla_fila_min: 30,
    itens: ["justificativa_confronto"], trava: "checkout_vs_ficha",
    ajuda: "O sistema compara automaticamente. Havendo diferença, justifique cada linha; só o gestor encerra com divergência." },
  { n: 12, chave: "distribuicao", nome: "Distribuição", perfil: "expedicao", sla_exec_min: 30, sla_fila_min: 60,
    campos: [
      { k: "total_distribuido", label: "Peças distribuídas", tipo: "int", obrigatorio: true },
      { k: "destinos", label: "Destinos (lojas / CD)", tipo: "texto", obrigatorio: true },
    ],
    trava: "distribuicao_vs_checkout" },
  { n: 13, chave: "picking", nome: "Picking e Pack", perfil: "expedicao", sla_exec_min: 90, sla_fila_min: 60,
    campos: [
      { k: "pecas_embaladas", label: "Peças embaladas", tipo: "int", obrigatorio: true },
      { k: "volumes_saida", label: "Volumes de saída", tipo: "int", obrigatorio: true },
    ],
    trava: "pack_vs_distribuicao" },
  { n: 14, chave: "faturamento", nome: "Faturamento", perfil: "expedicao", sla_exec_min: 30, sla_fila_min: 60,
    campos: [{ k: "numero_nf_saida", label: "Nº da NF de saída", tipo: "texto", obrigatorio: true }] },
];

const TRAVAS = {
  fardos_vs_volumes: "Fardos abertos × volumes recebidos",
  contagem_vs_nf: "Total contado × total da NF",
  ficha_vs_contagem: "Ficha × contagem",
  etiquetas_vs_ficha: "Etiquetas × ficha",
  checkout_vs_ficha: "Checkout × ficha",
  distribuicao_vs_checkout: "Distribuído × checkout",
  pack_vs_distribuicao: "Embalado × distribuído",
};

const ITEM_CAMPOS = {
  modelo: "texto", ref_fornecedor: "texto", cor: "texto", cor_codigo: "texto", tamanho: "texto", qtd_nf: "int", qtd_defeito: "int", qtd_conserto: "int", qtd_contada: "int", contado_por: "texto", qtd_ficha: "int", qtd_checkout: "int",
  amostra_separada: "bool", cor_definida: "texto", ref_zinzane: "texto", justificativa_confronto: "texto",
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

module.exports = { PERFIS, ETAPAS, TRAVAS, ITEM_CAMPOS, TAMANHOS, TAMANHOS_INFO, tamanhoCanonico, etapaPorNumero, numeroDe };
