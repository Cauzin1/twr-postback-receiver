import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db";
import { config } from "../config";

/**
 * Schema do postback que ESTE serviço aceita (nosso "contrato canônico").
 *
 * Decisão: cada plataforma de checkout (Hotmart, Kiwify, Stripe...) manda um
 * formato diferente. Normalizar todas estava fora do escopo de 3-4h, então
 * defini UM formato canônico, valido ele de forma estrita e guardo o payload
 * cru em `raw_payload` para auditoria. Em produção, o passo seguinte seria um
 * "adapter" por plataforma que traduz para este formato.
 */
const salePostbackSchema = {
  type: "object",
  required: ["event", "transaction_id", "amount_cents"],
  additionalProperties: true,
  properties: {
    // Opcional: se a plataforma manda um id único do evento, usamos ele como
    // chave de idempotência. Se não vier, derivamos um (ver abaixo).
    event_id: { type: "string", minLength: 1, maxLength: 200 },
    event: {
      type: "string",
      enum: [
        "purchase.approved",
        "purchase.pending",
        "purchase.refunded",
        "purchase.chargeback",
        "purchase.canceled",
      ],
    },
    transaction_id: { type: "string", minLength: 1, maxLength: 200 },
    amount_cents: { type: "integer", minimum: 0 },
    currency: { type: "string", minLength: 3, maxLength: 3 },
    occurred_at: { type: "string", format: "date-time" },
    product: {
      type: "object",
      properties: {
        id: { type: "string", maxLength: 200 },
        name: { type: "string", maxLength: 500 },
      },
    },
    customer: {
      type: "object",
      properties: {
        email: { type: "string", maxLength: 320 },
        name: { type: "string", maxLength: 500 },
      },
    },
  },
} as const;

interface SalePostback {
  event_id?: string;
  event: string;
  transaction_id: string;
  amount_cents: number;
  currency?: string;
  occurred_at?: string;
  product?: { id?: string; name?: string };
  customer?: { email?: string; name?: string };
}

/**
 * Verifica o segredo compartilhado enviado no header `x-webhook-secret`.
 * Usa comparação em tempo constante para não vazar informação por timing.
 * Se WEBHOOK_SECRET não estiver configurado, a verificação é pulada.
 */
function isAuthorized(req: FastifyRequest): boolean {
  if (!config.webhookSecret) return true; // auth desligada
  const provided = req.headers["x-webhook-secret"];
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO sales (
    event_id, event_type, transaction_id, product_id, product_name,
    customer_email, customer_name, amount_cents, currency, occurred_at,
    received_at, raw_payload
  ) VALUES (
    @event_id, @event_type, @transaction_id, @product_id, @product_name,
    @customer_email, @customer_name, @amount_cents, @currency, @occurred_at,
    @received_at, @raw_payload
  )
`);

export async function webhookRoutes(app: FastifyInstance) {
  app.post(
    "/webhooks/sales",
    { schema: { body: salePostbackSchema } },
    async (req, reply) => {
      if (!isAuthorized(req)) {
        return reply.code(401).send({ error: "invalid_webhook_secret" });
      }

      const body = req.body as SalePostback;

      // Chave de idempotência: usa event_id da plataforma, ou deriva um hash
      // determinístico de (transaction_id + event). Assim, o mesmo postback
      // reenviado cai sempre na mesma chave.
      const eventId =
        body.event_id ??
        createHash("sha256")
          .update(`${body.transaction_id}:${body.event}`)
          .digest("hex");

      const info = insertStmt.run({
        event_id: eventId,
        event_type: body.event,
        transaction_id: body.transaction_id,
        product_id: body.product?.id ?? null,
        product_name: body.product?.name ?? null,
        customer_email: body.customer?.email ?? null,
        customer_name: body.customer?.name ?? null,
        amount_cents: body.amount_cents,
        currency: body.currency ?? "BRL",
        occurred_at: body.occurred_at ?? null,
        received_at: new Date().toISOString(),
        raw_payload: JSON.stringify(body),
      });

      // info.changes === 0 => UNIQUE bateu => era duplicata (retry).
      // Respondemos 200 mesmo assim: a plataforma já entregou, não deve
      // reenviar. Respondemos 201 quando foi realmente criado.
      const duplicate = info.changes === 0;
      return reply.code(duplicate ? 200 : 201).send({
        status: duplicate ? "duplicate_ignored" : "accepted",
        event_id: eventId,
      });
    },
  );
}
