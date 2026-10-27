# Receptor de Postbacks — Desafio TWR

Esse é o serviço que montei para o desafio da TWR: um app em **TypeScript** que recebe
notificações de venda (webhooks/postbacks) de plataformas de checkout via `POST` e
devolve um relatório agregado via `GET`.

Desenvolvi pensando o tempo todo em como plataformas reais se comportam — elas
reenviam o mesmo evento, mandam coisas fora de ordem e nem sempre no formato que a
gente espera. Quase toda decisão daqui nasceu disso: preferi entregar poucas coisas,
mas bem pensadas e que eu consiga defender, em vez de encher de features pela metade.

- **URL pública:** **https://twr-postback-receiver.onrender.com**
  (plano free do Render — a primeira requisição após inatividade pode levar ~30–50 s enquanto a instância "acorda")
- **Stack:** Node.js + [Fastify](https://fastify.dev) + [SQLite](https://www.sqlite.org) (`better-sqlite3`)

---

## Como rodar localmente

```bash
npm install          # compila o módulo nativo do SQLite
npm run dev          # sobe em http://localhost:3000 com reload
# ou, para produção:
npm run build && npm start
```

Variáveis de ambiente (ver `.env.example`):

| Variável         | Padrão            | Descrição                                                              |
| ---------------- | ----------------- | ---------------------------------------------------------------------- |
| `PORT`           | `3000`            | Porta HTTP (o Render injeta automaticamente).                          |
| `DATABASE_PATH`  | `./data/sales.db` | Caminho do arquivo SQLite.                                             |
| `WEBHOOK_SECRET` | _(vazio)_         | Se definido, todo `POST` precisa do header `x-webhook-secret`. Vazio = desligado. |

---

## Endpoints

| Método | Rota              | Descrição                               |
| ------ | ----------------- | --------------------------------------- |
| `POST` | `/webhooks/sales` | Recebe um postback de venda.            |
| `GET`  | `/sales`          | Relatório agregado + lista de eventos.  |
| `GET`  | `/health`         | Healthcheck.                            |
| `GET`  | `/`               | Lista os endpoints.                     |

### Exemplo de `POST` (enviar uma venda)

```bash
curl -X POST http://localhost:3000/webhooks/sales \
  -H "content-type: application/json" \
  -H "x-webhook-secret: SEU_SEGREDO" \
  -d '{
    "event": "purchase.approved",
    "transaction_id": "tx_1001",
    "amount_cents": 9990,
    "currency": "BRL",
    "product":  { "id": "p1", "name": "Curso de TypeScript" },
    "customer": { "email": "ana@exemplo.com", "name": "Ana" },
    "occurred_at": "2026-10-24T12:00:00Z"
  }'
```

Respostas possíveis:

- `201 { "status": "accepted", "event_id": "...", "recognized": true }` — venda registrada.
- `200 { "status": "duplicate_ignored", "event_id": "...", "recognized": true }` — postback repetido (retry da plataforma); **ignorado com segurança**.
- `400 { "error": "validation_error", ... }` — payload fora do contrato (campo obrigatório ausente, tipo errado etc.).
- `401 { "error": "invalid_webhook_secret" }` — segredo ausente/errado (quando `WEBHOOK_SECRET` está configurado).

O campo `recognized` diz se o `event` é um tipo conhecido. Tipos desconhecidos são
**aceitos e armazenados** (`recognized: false`), não rejeitados — ver [Edge cases](#edge-cases-considerados).

**Campos:** `event`, `transaction_id` e `amount_cents` são obrigatórios.
Tipos de `event` reconhecidos (que alimentam o cálculo de receita):
`purchase.approved | purchase.pending | purchase.refunded | purchase.chargeback | purchase.canceled`.
Dinheiro sempre em **centavos (inteiro)**.

### Exemplo de `GET` (relatório)

```bash
curl "http://localhost:3000/sales?event=purchase.approved&limit=50"
```

Filtros opcionais: `event`, `product_id`, `from` / `to` (ISO 8601), `limit` (1–500), `offset`.

```jsonc
{
  "summary": {
    "total_events": 3,
    // Receita SEMPRE agrupada por moeda — nunca somo centavos de moedas diferentes.
    "by_currency": {
      "BRL": { "gross_revenue_cents": 14490, "refunds_cents": 9990, "net_revenue_cents": 4500 }
    },
    "by_event":   { "purchase.approved": { "count": 2 }, "purchase.refunded": { "count": 1 } },
    "by_product": [ { "product_id": "p1", "product_name": "Curso de TypeScript", "currency": "BRL", "count": 2, "revenue_cents": 14490 } ]
  },
  "pagination": { "limit": 50, "offset": 0, "returned": 3 },
  "events": [ /* eventos mais recentes primeiro */ ]
}
```

`gross` = aprovadas, `refunds` = reembolsos + chargebacks, `net` = `gross − refunds`,
**calculados por moeda**. Contagens (`by_event`) são agnósticas de moeda.

---

## Premissas e decisões

O enunciado pedia pra eu pensar no serviço **recebendo notificações de plataformas
reais**, e foi esse o fio condutor de tudo o que decidi.

### Por que escolhi essa stack

- **Fastify (em vez de Express).** Pra mim o ponto mais crítico de um receptor de
  webhook é a entrada: ela vem de fora e eu não posso confiar nela. O Fastify valida o
  corpo por JSON Schema *antes* do meu código rodar — eu só declaro o formato esperado
  e ele barra o que estiver errado. No Express eu teria que trazer uma lib à parte
  (`zod`/`joi`) pra ter a mesma garantia. Juntando isso à performance maior, ao suporte
  nativo a `async/await` e ao logger embutido (Pino), ele foi a escolha natural.
  Sei que a stack principal de vocês é Elysia + Bun — fiquei no Fastify porque é onde
  consigo entregar algo sólido e explicar linha a linha, mas a ideia central (validar
  na borda, deduplicar no banco) seria a mesma em qualquer um deles.

- **SQLite (`better-sqlite3`).** Me dá persistência de verdade com zero infra e, o que
  mais importa aqui, a constraint `UNIQUE` me entrega idempotência "de graça" — garantida
  pelo banco, não por código meu. Uso o modo WAL pro `GET` do relatório não travar o `POST`.

- **Render (em vez de serverless tipo Vercel).** Meu app é um processo que fica de pé,
  com uma conexão SQLite viva entre as requisições. O Render roda exatamente esse modelo
  "sempre ligado"; numa plataforma serverless a função sobe e morre a cada request, o que
  quebraria o SQLite em arquivo. De quebra, o deploy sai do próprio Git via `render.yaml`
  (infra como código, reproduzível) e dá pra evoluir pra disco persistente só trocando o
  plano, sem mexer no código.

### O que eu fiz e por quê

- **Idempotência (o ponto mais importante).** Plataformas de checkout reenviam o
  mesmo postback várias vezes quando não recebem um `2xx` rápido (retry). Se eu
  apenas inserisse, contaria a mesma venda múltiplas vezes. Cada evento tem um
  `event_id` (enviado pela plataforma ou derivado de `sha256(transaction_id + event)`)
  com **constraint `UNIQUE`** no banco. Um reenvio cai na mesma chave, é ignorado
  (`INSERT OR IGNORE`) e eu devolvo `200 duplicate_ignored`. A deduplicação é garantida
  pelo banco, não por lógica minha sujeita a corrida.

- **Status HTTP pensados para o emissor.** Webhooks usam o status pra decidir se
  reenviam. Então eu devolvo `2xx` sempre que a entrega deu certo (inclusive em
  duplicata), `400` pra payload inválido (reenviar não vai ajudar) e `401` pra segredo
  inválido. Evito `500` em erro do cliente pra não disparar um storm de retry.

- **Validação estrita de entrada com JSON Schema.** O corpo é validado pelo próprio
  Fastify antes de qualquer lógica minha rodar — como falei na escolha da stack, a
  entrada não-confiável é o coração de um receptor de webhook.

- **Autenticação por segredo compartilhado** (`x-webhook-secret`, comparado em tempo
  constante). Opcional via env var para facilitar a avaliação pela URL. Dá para
  ligar/desligar sem mexer no código.

- **Dinheiro em centavos (inteiro).** Evita erros de ponto flutuante em somatórios.

- **Persistência em SQLite.** Já expliquei o porquê na escolha da stack; vale só
  registrar que, num host com disco persistente, o arquivo sobrevive a restart/redeploy
  (ver o trade-off do plano free mais abaixo).

- **Payload cru guardado (`raw_payload`).** Para auditoria e reprocessamento futuro,
  mesmo que o modelo canônico evolua.

- **Formato canônico único.** Cada plataforma tem um JSON diferente; defini um
  contrato único e valido contra ele. O payload bruto fica salvo para o dia em que
  for preciso suportar formatos nativos.

- **Shutdown gracioso + healthcheck** (`/health`) para o deploy no Render.

### O que decidi NÃO fazer (e por quê)

- **Adapters por plataforma** (Hotmart, Kiwify, Stripe...). Exigiria conhecer o
  formato real de cada uma; fora do escopo de tempo. O payload cru salvo deixa esse
  caminho aberto. **Seria meu próximo passo.**
- **Assinatura HMAC** (como Stripe/Hotmart fazem de verdade). O segredo compartilhado
  cobre o requisito de autenticação de forma mais simples de testar. HMAC seria o
  upgrade natural de segurança.
- **Banco gerenciado (Postgres), fila/worker assíncrono.** Para o volume de um
  desafio, SQLite + processamento síncrono é suficiente e mais simples de defender.
  Em escala real, eu colocaria uma fila para desacoplar recepção de processamento.
- **Autenticação no `GET /sales`.** O relatório está aberto para facilitar a
  avaliação. Em produção ficaria atrás de auth.
- **Testes automatizados.** Validei o fluxo manualmente (ver seção de exemplos).
  Com mais tempo, adicionaria testes de idempotência e de validação com `vitest`.
- **Disco persistente no deploy.** O serviço está no **plano free do Render**, que
  não oferece disco persistente, então o SQLite roda em filesystem **efêmero**: os
  dados são reiniciados a cada redeploy e quando a instância free "dorme" por
  inatividade. Foi uma escolha consciente — para o propósito de avaliação, manter o
  serviço no ar a custo zero vale mais que a durabilidade dos dados. A lógica de
  idempotência, validação e status HTTP (o foco do desafio) funciona identicamente;
  só não garante durabilidade entre deploys. Em produção eu subiria num plano com
  disco (basta reinserir o bloco `disk` + `DATABASE_PATH` no `render.yaml`) ou
  trocaria por um banco gerenciado.

---

## Edge cases considerados

O enunciado pede para pensar no serviço recebendo postbacks de **plataformas reais**,
que são imprevisíveis. Abaixo os casos de borda que mapeei e como cada um é tratado —
alguns no código, outros como decisão consciente.

| Edge case | Comportamento |
| --- | --- |
| **Retry / postback duplicado** | Dedup por `UNIQUE(event_id)` + `INSERT OR IGNORE`. O 2º envio responde `200 duplicate_ignored` e **não** conta a venda de novo. |
| **Moedas diferentes no mesmo relatório** | Receita **sempre agrupada por moeda** (`by_currency`). Nunca somo centavos de BRL com USD — o total seria sem sentido. |
| **Tipo de evento desconhecido** | Em vez de `400` (que faria a plataforma reenviar pra sempre), **aceito e armazeno** com `recognized: false`. Tipos desconhecidos entram nas contagens, mas não afetam o cálculo de receita. _Seja liberal no que aceita._ |
| **Eventos fora de ordem** | Cada evento é uma linha independente (chave `transaction_id + event`); o relatório agrega por soma, então a ordem de chegada (ex.: refund antes do approved) não corrompe os totais. |
| **Payload inválido** | `400 validation_error` (campo obrigatório ausente, tipo errado). Reenviar não ajuda, então não peço retry. |
| **Corpo gigante** | `bodyLimit` de 1 MB → `413`, evitando abuso de memória. |
| **Campos extras no payload** | Aceitos (`additionalProperties: true`) e preservados em `raw_payload` — cada plataforma manda campos próprios. |
| **Concorrência / corrida** | A dedup é garantida pelo banco (constraint), não por lógica de aplicação: dois postbacks idênticos simultâneos não geram duplicata. |

### Edge cases conhecidos que decidi NÃO resolver (e por quê)

- **Duplicata com dados divergentes.** Se a plataforma reenvia o mesmo `event_id` com
  um `amount_cents` diferente, mantenho o primeiro registro (`INSERT OR IGNORE`) e
  **logo um aviso**. Decidir "qual é o valor verdadeiro" exigiria regra de negócio que
  o enunciado não define — prefiro não adivinhar silenciosamente.
- **Replay malicioso.** O segredo compartilhado é estático: quem interceptar um request
  pode reenviá-lo. A idempotência protege os dados (não duplica), mas a mitigação real
  seria **assinatura HMAC + tolerância de timestamp** (como Stripe/Hotmart fazem).
- **Falha de banco / erro inesperado.** Vira `500`, o que faz a plataforma **reenviar** —
  comportamento correto para não perder a venda.

---

## Deploy (Render)

O arquivo [`render.yaml`](./render.yaml) descreve o serviço: build com
`npm install && npm run build`, start com `npm start` e healthcheck em `/health`.
Roda no **plano free** (sem disco persistente — ver trade-off nas premissas acima).
Defina `WEBHOOK_SECRET` no dashboard do Render.
