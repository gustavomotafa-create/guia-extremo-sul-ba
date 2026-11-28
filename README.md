# Girassol Vagas

Plataforma regional para conectar candidatos, anunciantes e oportunidades no Extremo Sul da Bahia.

## O que o site entrega

- Visual premium em amarelo girassol, creme e marrom.
- Fundo global com pattern SVG de girassois, leve e discreto.
- Busca rapida por cargo, categoria e cidade.
- Busca avancada por salario, contrato, modalidade e nivel.
- Cards de vagas com detalhes completos e candidatura por WhatsApp.
- Favoritos com login e pagina "Minhas Vagas Salvas".
- Cadastro/login de candidatos e anunciantes via Firebase Authentication.
- Minha conta para acompanhar, editar, pausar, excluir e pagar publicacoes.
- Admin protegido para cadastrar vagas manualmente, aprovar, rejeitar, editar e excluir.
- Origem interna da vaga: `origin/source = admin` ou `origin/source = company`.
- Fallback automatico para o icone de girassol quando a vaga nao tem logo.
- Publicacao com aprovacao manual: vagas novas nao aparecem publicamente ate aprovacao.
- Limite por anunciante: 2 publicacoes gratuitas; cada pagamento de R$ 5,00 libera mais 2 publicacoes extras.
- Base de pagamento automatico via Mercado Pago, com webhook de confirmacao.

## Estrutura Firebase

Colecoes previstas no Cloud Firestore:

- `users`: perfis de candidatos, anunciantes e admin.
- `companies`: anunciantes cadastrados.
- `jobs`: vagas com status `pendente`, `aguardando_pagamento`, `aprovada`, `rejeitada` ou `pausada`.
- `savedJobs`: vagas salvas por candidatos.
- `payments`: historico de pagamentos.
- `companyDailyUsage`: controle de publicacoes gratuitas e creditos pagos por anunciante.
- `plans`: planos ou configuracoes comerciais futuras.

Firebase Storage esta preparado para uma fase futura, mas nao e publicado no deploy atual para evitar exigencia do plano Blaze apenas por Storage. Enquanto isso, os cards usam o icone padrao de girassol ou uma URL publica opcional de logo.

## Configuracao do front

O arquivo versionado `js/firebase-config.js` contem a configuracao Web publica usada em producao e no GitHub Pages.

Para desenvolvimento local, copie:

```bash
cp js/firebase-config.local.example.js js/firebase-config.local.js
```

Depois preencha `js/firebase-config.local.js` se quiser sobrescrever a configuracao em `localhost`, `127.0.0.1`, `::1` ou `file://`. Esse arquivo esta no `.gitignore`, nao deve ser commitado e nao e carregado em producao.

Tambem existe `.env.example` com os nomes esperados para ambientes de deploy.

### Sobre Firebase Web API Key

A Firebase Web API Key nao e uma senha privada como um token de servidor. Ela pode existir no front-end, mas deve ser protegida por:

- Regras fortes do Firestore.
- Dominios autorizados no Firebase Authentication.
- Restricoes de API key no Google Cloud quando possivel.
- Nenhum token privado no repositorio.

Tokens privados, como `MERCADO_PAGO_ACCESS_TOKEN`, devem ficar apenas em secrets do Firebase/GitHub ou em `.env` local ignorado pelo Git.

O admin principal esta configurado em:

```js
window.GIRASSOL_ADMIN_EMAILS = ["sunflowercollectivegf@gmail.com"];
```

Para acesso forte ao admin, use uma conta Google com esse e-mail verificado ou defina custom claim `admin: true` no Firebase Authentication.

## Configuracao das Functions

Instale e publique com Firebase CLI:

```bash
cd functions
npm install
cd ..
firebase deploy --only firestore,functions,hosting
```

O deploy atual nao publica Storage. Se estiver usando GitHub Pages para hosting, publique apenas Firestore/Functions no Firebase:

```bash
firebase deploy --only firestore,functions
```

Configure o Mercado Pago como secret:

```bash
firebase functions:secrets:set MERCADO_PAGO_ACCESS_TOKEN
```

Parametros usados pelas Functions:

- `MERCADO_PAGO_ACCESS_TOKEN`: token privado do Mercado Pago.
- `PUBLIC_SITE_URL`: URL publica do site, por exemplo `https://gustavomotafa-create.github.io/guia-extremo-sul-ba`.
- `PUBLIC_FUNCTIONS_URL`: opcional, URL base das Functions. Se vazio, o codigo monta pela regiao `southamerica-east1`.

Os parametros `PUBLIC_SITE_URL` e `PUBLIC_FUNCTIONS_URL` podem ser preenchidos quando o Firebase CLI pedir no deploy, ou via arquivo `.env` dentro de `functions/`.

### Validacao local com Firebase Emulator Suite

`firebase.json` aponta para `firestore.rules` e para a pasta `functions`, mas nao define portas de emuladores. O comando abaixo usa as portas padrao locais (Auth `9099`, Firestore `8080`, Functions `5001`) e um project ID `demo-*`, sem acessar o projeto configurado em `.firebaserc`. E necessario ter Firebase CLI, Java e dependencias de `functions` instalados. A integracao verifica regras de escrita do cliente, publicacao moderada, verificacao de empresa, edicao e triagem de leads usando somente os emuladores:

```powershell
firebase emulators:exec --project demo-girassol-vagas --only auth,firestore,functions "node --test functions/emulator.integration.test.js"
```

O teste tambem e incluido na suite `node --test functions/*.test.js`; fora do Emulator Suite ele fica marcado como ignorado. O script recusa endpoints que nao sejam locais e exige o project ID isolado `demo-girassol-vagas`.

## Publicacao no GitHub Pages

O site esta pronto para GitHub Pages usando:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/ (root)`

URL esperada:

`https://gustavomotafa-create.github.io/guia-extremo-sul-ba/`

No GitHub Pages, o site usa somente `js/firebase-config.js`. O arquivo `js/firebase-config.local.js` e ignorado em producao para evitar erro 404 e manter a configuracao local separada.

## Busca automatica de vagas (dry-run)

O workflow `.github/workflows/daily-job-search.yml` executa diariamente as 06:13 no horario da Bahia (09:13 UTC) e tambem pode ser iniciado manualmente. Ele valida os 417 municipios da Bahia consultando a API oficial do IBGE e grava um relatorio como artifact da execucao por 90 dias. O fluxo e dry-run: nao publica vagas nem grava no Firestore.

A fonte integrada por padrao e a API publica do Jobicy, filtrada por vagas remotas elegiveis no Brasil. Ela nao fornece filtro por municipio e nao substitui uma fonte local para os 417 municipios. A API publica e gratuita, mas exige atribuicao visivel ao Jobicy e a manutencao do link original da vaga. O coletor usa o link de listagem do Jobicy e nao solicita links diretos de candidatura que podem ter cobranca. A API tem janela de sete dias, atraso de tres horas, paginacao sequencial, consulta de status e limite de uma requisicao por segundo; a execucao respeita esse intervalo e e agendada fora do minuto zero.

Para fontes adicionais com permissao de uso e atribuicao previamente verificadas, configure `JOB_SEARCH_SOURCES_JSON` como um array JSON. Cada fonte precisa declarar `id`, `name`, `url`, `type: "json"`, `enabled: true`, `authorized: true` e `attributionUrl`; fontes sem autorizacao explicita ou desabilitadas sao ignoradas e registradas em `report.warnings`. A configuracao e uma declaracao do mantenedor, nao uma verificacao automatica de licenca: confirme os termos da fonte antes de habilita-la. Exemplo:

```json
[
  {
    "id": "identificador-estavel",
    "name": "Nome da fonte",
    "url": "https://exemplo.gov.br/api/vagas",
    "type": "json",
    "enabled": true,
    "authorized": true,
    "attributionUrl": "https://exemplo.gov.br/termos-de-uso",
    "termsUrl": "https://exemplo.gov.br/termos",
    "fieldMapping": {
      "title": "vaga.cargo",
      "company": "empresa.nome",
      "location": "vaga.localizacao",
      "modality": "vaga.modalidade",
      "url": "vaga.link",
      "publishedAt": "vaga.publicadaEm",
      "validThrough": "vaga.validaAte"
    }
  }
]
```

O feed deve ser uma API JSON publica, sem autenticacao, e retornar um array ou `{ "jobs": [...] }`. `fieldMapping` aceita caminhos pontuados para os campos indicados; sem mapeamento, o coletor reconhece nomes canonicos comuns (`title`, `city`/`location`, `url`, `company`/`companyName`, entre outros). Apenas URLs HTTPS publicas sao permitidas: hosts locais, `.local`, faixas IPv4/IPv6 privadas e credenciais embutidas sao rejeitados antes da requisicao. Redirecionamentos nao sao seguidos; a consulta tem timeout de 8 segundos e o corpo JSON e limitado a 2 MiB. Remote OK, Remotive e SINE continuam bloqueados, inclusive quando identificados por host, nome ou metadados do registro. Cada vaga passa pela mesma normalizacao IBGE, validade, deduplicacao e preparacao de lead. Sem validade explicita, o TTL padrao e 30 dias; a janela stale e 7 dias. O relatorio inclui avisos de configuracao e grupos geograficos com contagens, lista resumida e indicador de truncamento. Feeds HTML, fontes pagas/autenticadas e fontes sem permissao de redistribuicao confirmada nao devem ser configurados. Consulte [`docs/job-source-audit.md`](docs/job-source-audit.md) para fontes avaliadas e limitacoes.

O adaptador Jobicy mapeia cargo, empresa, elegibilidade geografica, descricao, tipo, nivel, categoria, salario, data e URL de origem. Como a localizacao e elegibilidade remota por pais, esses resultados ficam marcados como `locationScope: "remote"`, sem cidade ou municipio inventado. O coletor classifica localidades exatas com o codigo IBGE; Posto da Mata e Itabatã sao associados, respectivamente, a Nova Viçosa e Mucuri, sem criarem municipios novos. As demais classificacoes incluem `municipality`, `regional_extremo_sul`, `statewide_ba` e `unverified`. A disponibilidade da fonte e separada da validade calculada: vencimentos explicitos sao respeitados e, sem validade, aplica-se o TTL configurado ou padrao de 30 dias. `collectedAt` e `fetchedAt` registram a coleta, e o relatorio conta vagas ativas, expiradas e desatualizadas. O endpoint oficial de status marca a vaga como disponivel, indisponivel ou desconhecida; vagas fora da janela de sete dias nao sao automaticamente consideradas encerradas. A deduplicacao combina fonte, identificador/URL canonica e titulo/empresa normalizados, preservando referencias de origem em duplicatas entre fontes. A paginacao e limitada a 10 paginas (1.000 vagas); se houver mais resultados, o relatorio assinala a coleta parcial. Nenhum resultado e enviado para `jobs`.

Para persistir leads em `automatedJobLeads` para triagem manual, execute localmente `node functions/job-bot.js --persist` com `FIREBASE_SERVICE_ACCOUNT_JSON` configurado e autorizado. Mantenha o JSON apenas em segredo/local seguro, nunca no repositorio. O workflow permanece em dry-run por padrao; no agendamento, a persistencia so e ativada com a variavel `JOB_SEARCH_PERSIST_ENABLED=true`, e na execucao manual com o input `persist=true`. Ambos exigem o secret `FIREBASE_SERVICE_ACCOUNT_JSON`. A fonte padrao Jobicy pode ser persistida sem fontes JSON adicionais. A persistencia grava leads para triagem, nao publica documentos em `jobs`. Ela usa a chave canonica de deduplicacao como ID, processa no maximo 200 leads unicos por execucao e preserva `createdAt`. Leads ainda pendentes podem receber dados atualizados; leads triados/revisados recebem somente metadados de rastreamento e validade. Em cada execucao sao lidos no maximo 200 candidatos vencidos em lotes de 100; pendencias expiradas sao marcadas sem exclusao e o relatorio indica quando o limite de reconciliacao foi atingido. O caminho usa transacoes do Admin SDK e nao altera a moderacao de `jobs`. A colecao e privada para leitura por admins no cliente.

Testes focados: `node --test functions/job-bot.test.js`.

## Observacao

O codigo nao usa vagas demonstrativas. A home mostra apenas vagas aprovadas vindas do Firestore.
