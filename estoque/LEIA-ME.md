# Planilha de estoque do dia

Suba aqui a planilha **Estoque Omni** (.xlsx) todo dia. A rotina "Enviar estoque Cia"
(GitHub Actions) manda o arquivo para o painel, e o menu **Estoque Cia** passa a mostrar
essa versão em menos de um minuto.

- Dica: coloque a data no nome do arquivo (ex.: `Estoque_Omni_2026-10-13.xlsx`). Sem data
  no nome, o painel usa o dia do envio.
- Reenviar no mesmo dia substitui a carga daquele dia.
- As planilhas antigas são apagadas da pasta automaticamente (o painel guarda o histórico).
- Também dá para subir direto pelo painel: Estoque Cia → Carregar planilha (administrador).
