# Relatorio de descoberta de fontes de vagas

Data da verificacao: 2026-11-26

## Resumo

Uma fonte foi integrada: a API publica do Jobicy, sem chave, filtrada por vagas remotas cuja elegibilidade geografica seja Brasil. Ela fornece dados estruturados e um endpoint oficial para conferir o status atual das vagas. A API nao filtra por municipio; portanto, nao comprova cobertura local dos 417 municipios da Bahia. A busca municipal permanece sem uma fonte local autorizada confirmada.

O adaptador usa apenas os links de listagem do Jobicy, mostra a origem e mantem o link para a vaga original. A API comercial de links diretos de candidatura nao e usada, pois a propria documentacao informa cobranca de USD 0,01 por vaga elegivel.

O adaptador Remote OK foi preparado, mas permanece inativo. A API inclui uma exigencia de atribuicao e link dofollow, mas a permissao ampla para agregar/republicar os registros ainda nao foi comprovada. Um bloqueio estatico impede sua ativacao por variaveis de ambiente, fontes genericas ou chamadas internas; feeds genericos exigem registro por ID e URL exata numa allowlist revisada, redirecionamentos nao sao seguidos e registros com URL/origem Remote OK sao rejeitados. A allowlist atual esta vazia; nenhuma fonte local foi adicionada.

Duplicatas entre fontes preservam a fonte primaria nos campos de topo (`sourceId`, `sourceName`, `sourceUrl`) e guardam as referencias de origem em `sourceReferences`, um array opcional de objetos (`sourceId`, `sourceName`, `sourceUrl`, `termsUrl`). O payload persiste essa lista como array de objetos em `automatedJobLeads`, sem migracao de colecao. Consumidores futuros devem tolerar a ausencia da propriedade e suportar varias referencias, preservando a fonte primaria. A camada de persistencia idempotente foi preparada e coberta por mock; nenhuma gravacao real foi feita.

## Validade, deduplicacao e localizacao

- Cada registro normalizado inclui `collectedAt`, `fetchedAt`, `expiresAt`, `validThrough`, `ttlDays` e `validityStatus`. A validade explicitamente fornecida pela fonte prevalece; caso contrario, usa-se o TTL da fonte ou o padrao de 30 dias, contado da publicacao quando disponivel ou da coleta. `evaluateValidity` classifica registros como `active`, `expired` ou `stale`, com data de referencia injetavel e janela stale padrao de 7 dias. Registros expirados permanecem identificados como `expired` no processamento e nos contadores do relatorio.
- A chave de deduplicacao e baseada em fonte, identificador externo ou URL canonica, titulo e empresa normalizados. Parametros comuns de rastreamento e fragmentos sao removidos apenas da URL usada para identidade; `sourceUrl` preserva o link de origem. Duplicatas ignoradas sao contadas no relatorio.
- A localizacao usa os municipios validados pelo IBGE. Correspondencia exata gera `locationScope: "municipality"` e `ibgeCode`; Posto da Mata e Itabatã sao tratados como localidades de Nova Viçosa e Mucuri, respectivamente. Os municipios do Territorio de Identidade do Extremo Sul sao reconhecidos para filtro regional. Vaga sem municipio exato pode ser `regional_extremo_sul`, `statewide_ba`, `remote` ou `unverified`; nao se atribui municipio a vaga remota sem evidencia.
- `buildAutomatedJobLeadPayload` e uma funcao pura para preparar registros com `origin: "automated_source"`, `triageStatus: "pending"` e `reviewStatus: "pending_review"`. Sua execucao nao grava dados. Persistencia continua opt-in por `--persist` e nao e usada pelo workflow diario.

## Persistencia opt-in e reconciliacao

- `--persist` usa `deduplicationKey` (hash canonico) como ID de documento, com transacao para ler o estado atual antes de mesclar.
- Um lead novo recebe `createdAt`, `firstSeenAt`, `lastSeenAt` e `seenCount`. Uma nova coleta do mesmo lead nao cria outro documento nem altera `createdAt`.
- Leads que ainda estao em estado novo/pendente recebem os dados normalizados mais recentes, preservando os estados pendentes ja existentes. Leads aprovados, rejeitados ou de outro estado nao pendente preservam status e dados curados; apenas validade, disponibilidade e metadados de rastreamento podem ser atualizados.
- A execucao aceita no maximo 200 leads unicos; exceder o limite falha antes de qualquer upsert. A reconciliacao consulta no maximo dois lotes de 100 documentos com `expiresAt <= now`, revalida o estado dentro de transacao e marca leads pendentes como expirados sem apagar documentos. O relatorio marca `truncated` quando o limite pode ter deixado candidatos adicionais para a proxima execucao.
- A persistencia exige `--persist` e `FIREBASE_SERVICE_ACCOUNT_JSON`. Os testes usam um repositorio em memoria; nao chamam o Firebase, nao publicam em `jobs` e nao alteram o workflow diario.

## Fontes avaliadas

| Fonte | Acesso automatizado e condicoes | Dados e localizacao | Decisao |
| --- | --- | --- | --- |
| [Jobicy Jobs API](https://jobicy.com/jobs-rss-feed) | API publica sem chave. A documentacao permite job boards, agregadores, produtos comerciais e armazenamento; exige atribuicao visivel e link para a listagem do Jobicy. No maximo uma requisicao por segundo por IP; seguir `Retry-After`. Links ATS diretos pertencem a API comercial paga e nao sao solicitados. | JSON com ID, cargo, empresa, elegibilidade geografica remota, tipo, nivel, descricao/resumo, publicacao, salario quando informado e URL. Filtro `geo=brazil`, paginacao por cursor e status `active`/`closed`/`unknown`. Sem filtro municipal. O feed cobre os ultimos sete dias e publica registros com atraso documentado de tres horas. | **Integrada e testada.** Vagas sao marcadas `remote`, sem municipio ou cidade ficticios. |
| [Remote OK API](https://remoteok.com/api) | Endpoint JSON publico. O campo `legal` da resposta exige mencionar Remote OK e link follow (sem `nofollow`) para a vaga no Remote OK; o logotipo requer autorizacao escrita. Esse texto nao comprova, por si so, permissao ampla para agregacao/republicacao, e nao foi confirmado limite de requisicoes. | Campos observados incluem ID, cargo, empresa, localizacao, data, descricao e URL da vaga. Fonte exclusivamente remota; o adaptador aceitaria somente Brazil/Brasil ou `Worldwide`, `Global` e `Anywhere in the world`, sem atribuir municipio. | **Adaptador preparado, inativo.** `authorized=false` e `termsReviewed=false`; o feed tambem e bloqueado na configuracao de fontes genericas. Nao ativar ate comprovar os direitos de uso e agregacao. |
| [Remotive Remote Jobs API](https://remotive.com/remote-jobs/api) | A pagina publica documentacao e termos da API. Os termos encontrados proíbem enviar suas vagas a sites de terceiros, citando outros portais de emprego; o Girassol Vagas e um portal de terceiros. | Vagas remotas; a pagina consultada nao demonstra cobertura municipal da Bahia. | **Excluida por restricao de uso.** A API nao foi chamada. |
| [Arbeitnow Job Board API](https://www.arbeitnow.com/api/job-board-api) | Endpoint publico JSON consultado sem autenticacao. Nao foi confirmada, nas paginas acessadas, autorizacao suficiente para redistribuir os registros num portal comercial. | A resposta observada continha vagas e localizacoes na Alemanha; nao foi verificado filtro ou conjunto de vagas da Bahia. | **Nao integrada.** Requer confirmacao de permissao e relevancia geografica antes de uso. |
| [SINE / MTE — geracao de emprego](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/emprego-e-renda/bloco-de-fomento-a-geracao-de-emprego-do-sine) | A pagina oficial consultada descreve o programa e sua base legal; nao documenta um endpoint publico de vagas. Isso nao prova que nao exista outro servico ou autorizacao. | Nao foi possivel validar um feed/API oficial com vagas e filtro por municipio. | **Adiado.** Nenhuma pagina do SINE/SineBahia foi raspada. |
| [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html) | Documentacao oficial oferece leitura JSON por `board_token`; autenticacao e exigida para envio de candidaturas, nao para leitura. A documentacao descreve o quadro de vagas de uma empresa, nao uma autorizacao geral para agregar todos os quadros. | Inclui cargo, localizacao, URL e, com `content=true`, descricao e departamento. O token identifica um quadro empresarial especifico; nao e uma busca global por municipio. | **Adiada.** Sem empresas/quadros que tenham autorizado a integracao e sem permissao de redistribuicao confirmada. |

## Testes e limites

- Execucao live em dry-run em 2026-11-26: IBGE validou 417 municipios; Jobicy retornou 175 registros em duas paginas; os 175 foram normalizados e a consulta de status classificou os 175 como `active`. Nenhum registro foi gravado (`firestoreWrites=0`) ou publicado.
- O endpoint publico do Jobicy foi consultado durante a pesquisa com `geo=brazil`; respondeu com JSON e indicou mais resultados por cursor.
- A taxonomia oficial do Jobicy confirmou o slug geografico `brazil`.
- A documentacao consultada define `GET /api/jobs/status?ids=...`, ate 100 IDs por chamada, e estados `active`, `closed` e `unknown`. A chamada de status custa USD 0 segundo a documentacao; uma execucao real do adaptador valida a resposta em tempo de execucao.
- A integracao consulta sequencialmente ate 10 paginas de 100 registros e faz chamadas de status em lotes de 100. Se a fonte indicar mais paginas, o relatorio marca resultado parcial em vez de afirmar coleta completa.
- A API Jobicy e uma fonte nacional/remota. Nenhuma fonte integrada confirma vagas locais para cada municipio da Bahia; uma vaga remota elegivel no Brasil nao sera associada artificialmente a um municipio.
- A disponibilidade para Jobicy usa a resposta oficial de status. Para fontes genericas, somente um campo explicito `available` ou uma data de validade e considerado; ausencia no feed nao prova encerramento.
- O workflow permanece em dry-run: publica relatorios, mas nao grava leads no Firestore e nao cria documentos em `jobs`.
- O adaptador Remote OK bloqueia a coleta por padrao e nao pode ser adicionado via `JOB_SEARCH_SOURCES_JSON`. Seus testes usam respostas injetadas, sem consultar o endpoint; deduplicatas entre fontes preservam os links de origem de ambas.
- A allowlist de feeds genericos e revisada no codigo e esta vazia; os exemplos de teste usam uma allowlist injetada apenas para fixtures. Feeds genericos nao seguem redirecionamentos e nao podem devolver links ou marcadores de origem Remote OK.

## Referencias oficiais

- [Jobicy — API, regras de uso, campos, paginacao, status e limites](https://jobicy.com/jobs-rss-feed)
- [Jobicy — OpenAPI](https://jobicy.com/api/openapi.json)
- [Jobicy — localidades publicadas](https://jobicy.com/api/jobs?get=locations)
- [Remote OK — API e termos de atribuicao embutidos na resposta](https://remoteok.com/api)
- [Remotive — API e termos de uso](https://remotive.com/remote-jobs/api)
- [Arbeitnow — endpoint de vagas](https://www.arbeitnow.com/api/job-board-api)
- [Greenhouse — Job Board API](https://docs.greenhouse.io/job-board.html)
- [MTE — pagina sobre o SINE](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/emprego-e-renda/bloco-de-fomento-a-geracao-de-emprego-do-sine)
