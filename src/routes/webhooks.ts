import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db";
import { config } from "../config";

const salePostbackSchema = {
  type: "object",
  required: ["event", "transaction_id", "amount_cents"],
  additionalProperties: true,
  properties: {
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

function isAuthorized(req: FastifyRequest): boolean {
  if (!config.webhookSecret) return true;
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

      const duplicate = info.changes === 0;
      return reply.code(duplicate ? 200 : 201).send({
        status: duplicate ? "duplicate_ignored" : "accepted",
        event_id: eventId,
      });
    },
  );
}
