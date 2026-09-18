-- FASE 2 (correção pós-lançamento) — fecha a corrida do reparo de cartões de
-- pipeline em `fix-import-pipeline-deals.patch`: `ensurePipelineDeal()` fazia
-- um select-então-insert sem nenhum backstop no banco, então duas requisições
-- concorrentes reparando o MESMO lote concluído (ex.: duplo clique
-- reenviando o mesmo CSV) podiam ambas achar "sem cartão ainda" e criar dois.
--
-- Este índice único parcial só se aplica a cartões de PIPELINE (sem produto
-- vinculado, `product_id is null`) — nunca restringe deals ligados a um
-- produto especifico, que legitimamente podem existir vários por lead (um
-- por produto). Verificado em produção antes desta migration: zero
-- duplicatas existentes por `lead_id` com `product_id is null` (senão esta
-- migration teria sido bloqueada até uma limpeza).
create unique index deals_lead_id_pipeline_unique
  on public.deals (lead_id)
  where product_id is null;
