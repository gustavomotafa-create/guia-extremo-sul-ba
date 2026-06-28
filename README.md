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

## Publicacao no GitHub Pages

O site esta pronto para GitHub Pages usando:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/ (root)`

URL esperada:

`https://gustavomotafa-create.github.io/guia-extremo-sul-ba/`

No GitHub Pages, o site usa somente `js/firebase-config.js`. O arquivo `js/firebase-config.local.js` e ignorado em producao para evitar erro 404 e manter a configuracao local separada.

## Observacao

O codigo nao usa vagas demonstrativas. A home mostra apenas vagas aprovadas vindas do Firestore.
