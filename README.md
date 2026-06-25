# Girassol Vagas

Plataforma regional para conectar candidatos, empresas e oportunidades no Extremo Sul da Bahia.

## O que o site entrega

- Visual premium em amarelo girassol, creme e marrom.
- Busca rápida por cargo, categoria e cidade.
- Busca avançada por salário, contrato, modalidade e nível.
- Cards de vagas com detalhes completos e candidatura por WhatsApp.
- Favoritos com login e página "Minhas Vagas Salvas".
- Cadastro/login de candidatos e empresas via Firebase Authentication.
- Área da empresa para acompanhar, editar, pausar, excluir e pagar vagas.
- Admin protegido para aprovar, rejeitar, editar e excluir vagas.
- Publicação com aprovação manual: vagas novas não aparecem publicamente até aprovação.
- Limite por empresa: 3 vagas grátis por dia; cada pagamento de R$ 5,00 libera mais 3 publicações extras no mesmo dia.
- Base de pagamento automático via Mercado Pago, com webhook de confirmação.

## Estrutura Firebase

Coleções previstas:

- `users`: perfis de candidatos, empresas e admin.
- `companies`: empresas cadastradas.
- `jobs`: vagas com status `pendente`, `aguardando_pagamento`, `aprovada`, `rejeitada` ou `pausada`.
- `savedJobs`: vagas salvas por candidatos.
- `payments`: histórico de pagamentos.
- `companyDailyUsage`: controle diário de vagas grátis e créditos pagos por empresa.
- `plans`: planos ou configurações comerciais futuras.

## Configuração do front

Copie as chaves do Firebase Web App em `js/firebase-config.js`:

```js
window.GIRASSOL_FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

O admin principal está configurado em:

```js
window.GIRASSOL_ADMIN_EMAILS = ["sunflowercollectivegf@gmail.com"];
```

Para acesso forte ao admin, use uma conta Google com esse e-mail verificado ou defina custom claim `admin: true` no Firebase Authentication.

## Configuração das Functions

Instale e publique com Firebase CLI:

```bash
cd functions
npm install
firebase deploy --only firestore,functions,hosting
```

Configure o Mercado Pago:

```bash
firebase functions:secrets:set MERCADO_PAGO_ACCESS_TOKEN
```

Parâmetros usados pelas Functions:

- `MERCADO_PAGO_ACCESS_TOKEN`: token privado do Mercado Pago.
- `PUBLIC_SITE_URL`: URL pública do site, por exemplo `https://gustavomotafa-create.github.io/guia-extremo-sul-ba`.
- `PUBLIC_FUNCTIONS_URL`: opcional, URL base das Functions. Se vazio, o código monta pela região `southamerica-east1`.

Os parâmetros `PUBLIC_SITE_URL` e `PUBLIC_FUNCTIONS_URL` podem ser preenchidos quando o Firebase CLI pedir no deploy, ou via arquivo `.env` dentro de `functions/`.

## Publicação no GitHub Pages

O site está pronto para GitHub Pages usando:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/ (root)`

URL esperada:

`https://gustavomotafa-create.github.io/guia-extremo-sul-ba/`

## Observação

Sem as chaves reais do Firebase, o site continua abrindo com vagas demonstrativas, mas login, favoritos, admin, área da empresa e pagamentos ficam aguardando configuração.
