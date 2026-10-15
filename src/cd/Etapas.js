// Definição única das 15 etapas do processo de entrada de mercadoria no CD, da NF na doca
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
  { n: 2, chave: "fardos", nome: "Abertura dos fardos", perfil: "doca", sla_exec_min: 45, sla_fila_min: 60,
    campos: [
      { k: "fardos_abertos", label: "Fardos abertos", tipo: "int", obrigatorio: true },
      { k: "avarias", label: "Avarias / observações", tipo: "texto" },
    ],
    trava: "fardos_vs_volumes",
    ajuda: "Informe quantos fardos foram abertos. Precisa bater com os volumes recebidos." },
  { n: 3, chave: "separacao", nome: "Separação de modelo e cor", perfil: "doca", sla_exec_min: 60, sla_fila_min: 60,
    itens: ["modelo", "cor", "qtd_nf"],
    ajuda: "Cadastre uma linha para cada combinação de modelo e cor que saiu dos fardos." },
  { n: 4, chave: "contagem", nome: "Contagem", perfil: "doca", sla_exec_min: 90, sla_fila_min: 60,
    itens: ["qtd_contada"], trava: "contagem_vs_nf",
    ajuda: "Informe a quantidade contada de cada modelo e cor. O total é comparado com a NF." },
  { n: 5, chave: "ficha", nome: "Preenchimento da ficha", perfil: "doca", sla_exec_min: 30, sla_fila_min: 30,
    campos: [{ k: "ficha_numero", label: "Nº da ficha", tipo: "texto", obrigatorio: true }],
    itens: ["qtd_ficha"], trava: "ficha_vs_contagem",
    ajuda: "Digite aqui o que foi anotado na ficha de papel. Esta é a base da conferência final (etapa 12)." },
  { n: 6, chave: "amostra", nome: "Separação de 1 peça para o Estilo", perfil: "doca", sla_exec_min: 20, sla_fila_min: 30,
    itens: ["amostra_separada"],
    ajuda: "Marque cada modelo e cor que já teve 1 peça separada e entregue ao Estilo." },
  { n: 7, chave: "referencia", nome: "Definir a referência Zinzane", perfil: "estilo", sla_exec_min: 60, sla_fila_min: 120,
    itens: ["cor_definida", "ref_zinzane"],
    ajuda: "Defina a cor e a referência Zinzane de cada linha." },
  { n: 8, chave: "etiquetas", nome: "Rodar as etiquetas", perfil: "cadastro", sla_exec_min: 30, sla_fila_min: 60,
    campos: [{ k: "etiquetas_impressas", label: "Etiquetas impressas", tipo: "int", obrigatorio: true }],
    trava: "etiquetas_vs_ficha",
    ajuda: "Informe quantas etiquetas foram impressas. Precisa bater com o total da ficha." },
  { n: 9, chave: "pedido", nome: "Gerar o pedido", perfil: "cadastro", sla_exec_min: 20, sla_fila_min: 60,
    campos: [{ k: "numero_pedido", label: "Nº do pedido", tipo: "texto", obrigatorio: true }] },
  { n: 10, chave: "entrada", nome: "Entrada da nota", perfil: "cadastro", sla_exec_min: 30, sla_fila_min: 60,
    campos: [{ k: "numero_entrada", label: "Nº da entrada", tipo: "texto", obrigatorio: true }] },
  { n: 11, chave: "checkout", nome: "Checkout", perfil: "cadastro", sla_exec_min: 60, sla_fila_min: 60,
    itens: ["qtd_checkout"],
    ajuda: "Informe a quantidade de cada modelo e cor que passou no checkout." },
  { n: 12, chave: "confronto", nome: "Confronto: checkout × ficha", perfil: "cadastro", sla_exec_min: 20, sla_fila_min: 30,
    itens: ["justificativa_confronto"], trava: "checkout_vs_ficha",
    ajuda: "O sistema compara automaticamente. Havendo diferença, justifique cada linha; só o gestor encerra com divergência." },
  { n: 13, chave: "distribuicao", nome: "Distribuição", perfil: "expedicao", sla_exec_min: 30, sla_fila_min: 60,
    campos: [
      { k: "total_distribuido", label: "Peças distribuídas", tipo: "int", obrigatorio: true },
      { k: "destinos", label: "Destinos (lojas / CD)", tipo: "texto", obrigatorio: true },
    ],
    trava: "distribuicao_vs_checkout" },
  { n: 14, chave: "picking", nome: "Picking e Pack", perfil: "expedicao", sla_exec_min: 90, sla_fila_min: 60,
    campos: [
      { k: "pecas_embaladas", label: "Peças embaladas", tipo: "int", obrigatorio: true },
      { k: "volumes_saida", label: "Volumes de saída", tipo: "int", obrigatorio: true },
    ],
    trava: "pack_vs_distribuicao" },
  { n: 15, chave: "faturamento", nome: "Faturamento", perfil: "expedicao", sla_exec_min: 30, sla_fila_min: 60,
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
  modelo: "texto", cor: "texto", qtd_nf: "int", qtd_contada: "int", qtd_ficha: "int", qtd_checkout: "int",
  amostra_separada: "bool", cor_definida: "texto", ref_zinzane: "texto", justificativa_confronto: "texto",
};

const etapaPorNumero = (n) => ETAPAS.find((e) => e.n === Number(n));

module.exports = { PERFIS, ETAPAS, TRAVAS, ITEM_CAMPOS, etapaPorNumero };
