// ============================================================================================
// CONSULTAS NA RETAGUARDA (SQL Server) — o ÚNICO arquivo que precisa ser ajustado ao banco real.
// O portal só LÊ: use um usuário do SQL Server com permissão somente de leitura (db_datareader).
//
// Cada consulta deve devolver EXATAMENTE as colunas abaixo (com esses apelidos). Troque os nomes
// de tabelas/colunas pelos do seu banco. Dica: rode GET /api/go-vendas/esquema (como administrador)
// para listar as tabelas e colunas que existem e descobrir os nomes certos.
// ============================================================================================

// Uma linha por loja ativa.
//   cod            texto  — código da loja/filial na retaguarda (chave que liga as vendas à loja)
//   nome           texto  — nome da loja
//   go             texto  — nome da GO (pode vir vazio: o portal usa a regional cadastrada nos Chamados)
//   gerente        texto  — nome da gerente
//   cluster        texto
//   uf             texto  — sigla (SP, RJ...)
//   regiao         texto  — região (Sudeste, Sul...)
//   area_m2        número — área de venda em m²
//   hc_necessario  inteiro
//   hc_real        inteiro
//   custo_ocupacao número — custo de ocupação MENSAL da loja (R$)
const LOJAS = `
SELECT
  CAST(f.CODIGO_FILIAL AS varchar(20))   AS cod,
  f.NOME_FILIAL                          AS nome,
  f.NOME_GO                              AS go,
  f.NOME_GERENTE                         AS gerente,
  f.CLUSTER                              AS cluster,
  f.UF                                   AS uf,
  f.REGIAO                               AS regiao,
  f.AREA_VENDA                           AS area_m2,
  f.HC_NECESSARIO                        AS hc_necessario,
  f.HC_REAL                              AS hc_real,
  f.CUSTO_OCUPACAO                       AS custo_ocupacao
FROM FILIAIS f
WHERE f.ATIVA = 1
`;

// Uma linha por loja e por dia, no período pedido (@desde e @ate, datas).
//   cod      texto   — mesmo código da consulta de lojas
//   data     data    — dia da venda
//   venda    número  — venda LÍQUIDA do dia (R$), já descontadas devoluções/cancelamentos
//   tickets  inteiro — quantidade de atendimentos/cupons (para ticket médio)
//   pecas    inteiro — quantidade de peças vendidas líquidas (para peças por atendimento)
const VENDAS_DIA = `
SELECT
  CAST(v.CODIGO_FILIAL AS varchar(20))   AS cod,
  CAST(v.DATA_VENDA AS date)             AS data,
  SUM(v.VALOR_LIQUIDO)                   AS venda,
  COUNT(DISTINCT v.NUMERO_CUPOM)         AS tickets,
  SUM(v.QTDE_PECAS)                      AS pecas
FROM VENDAS v
WHERE v.DATA_VENDA >= @desde AND v.DATA_VENDA < DATEADD(day, 1, @ate)
GROUP BY v.CODIGO_FILIAL, CAST(v.DATA_VENDA AS date)
`;

module.exports = { LOJAS, VENDAS_DIA };
