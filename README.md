# Receptor de Postbacks — Desafio TWR

Serviço em **TypeScript** que recebe notificações de venda (webhooks/postbacks) de
plataformas de checkout via `POST` e expõe um relatório agregado via `GET`.

- **URL pública:** _(preencher após o deploy — ex.: `https://twr-postback-receiver.onrender.com`)_
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

- `201 { "status": "accepted", "event_id": "..." }` — venda registrada.
- `200 { "status": "duplicate_ignored", "event_id": "..." }` — postback repetido (retry da plataforma); **ignorado com segurança**.
- `400 { "error": "validation_error", ... }` — payload fora do contrato.
- `401 { "error": "invalid_webhook_secret" }` — segredo ausente/errado (quando `WEBHOOK_SECRET` está configurado).

**Campos:** `event` e `transaction_id` e `amount_cents` são obrigatórios.
`event` ∈ `purchase.approved | purchase.pending | purchase.refunded | purchase.chargeback | purchase.canceled`.
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
    "gross_revenue_cents": 14490,   // soma das aprovadas
    "refunds_cents": 9990,          // reembolsos + chargebacks
    "net_revenue_cents": 4500,      // líquido
    "currency": "BRL",
    "by_event":   { "purchase.approved": { "count": 2, "amount_cents": 14490 }, "...": {} },
    "by_product": [ { "product_id": "p1", "product_name": "Curso de TypeScript", "count": 2, "revenue_cents": 9990 } ]
  },
  "pagination": { "limit": 50, "offset": 0, "returned": 3 },
  "events": [ /* eventos mais recentes primeiro */ ]
}
```

---

## Premissas e decisões

O enunciado pedia explicitamente para pensar no que acontece com o serviço
**recebendo notificações de plataformas reais**. As decisões abaixo giram em torno disso.

### O que eu fiz e por quê

- **Idempotência (o ponto mais importante).** Plataformas de checkout reenviam o
  mesmo postback várias vezes quando não recebem um `2xx` rápido (retry). Se eu
  apenas inserisse, contaria a mesma venda múltiplas vezes. Cada evento tem um
  `event_id` (enviado pela plataforma ou derivado de `sha256(transaction_id + event)`)
  com **constraint `UNIQUE`** no banco. Um reenvio cai na mesma chave, é ignorado
  (`INSERT OR IGNORE`) e respondemos `200 duplicate_ignored`. A deduplicação é
  garantida pelo banco, não por lógica de aplicação sujeita a corrida.

- **Status HTTP pensados para o emissor.** Webhooks usam o status para decidir se
  reenviam. Retornamos `2xx` sempre que a entrega foi bem-sucedida (inclusive em
  duplicata), `400` para payload inválido (reenviar não vai ajudar) e `401` para
  segredo inválido. Evitamos `500` em erro do cliente para não gerar storm de retry.

- **Validação estrita de entrada com JSON Schema.** O corpo é validado pelo próprio
  Fastify antes de qualquer lógica. Entrada não-confiável é o coração de um receptor
  de webhook — por isso escolhi Fastify (validação nativa) em vez de Express.

- **Autenticação por segredo compartilhado** (`x-webhook-secret`, comparado em tempo
  constante). Opcional via env var para facilitar a avaliação pela URL. Dá para
  ligar/desligar sem mexer no código.

- **Dinheiro em centavos (inteiro).** Evita erros de ponto flutuante em somatórios.

- **Persistência em SQLite com disco.** Sobrevive a restart/redeploy, sem custo de
  infraestrutura. Modo WAL para o `GET` de relatório não bloquear o `POST`.

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

---

## Deploy (Render)

O arquivo [`render.yaml`](./render.yaml) descreve o serviço: build com
`npm install && npm run build`, start com `npm start`, disco persistente montado em
`/var/data` e `DATABASE_PATH=/var/data/sales.db`. Defina `WEBHOOK_SECRET` no dashboard.
