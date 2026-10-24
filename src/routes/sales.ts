import type { FastifyInstance } from "fastify";
import { db } from "../db";

/**
 * Relatório de vendas por GET.
 *
 * Entrega dois blocos:
 *  - `summary`: números agregados (contagens, receita, por produto).
 *  - `events`:  a lista de eventos recebidos, com filtros e paginação.
 *
 * Receita líquida = aprovadas - (reembolsos + chargebacks). Dinheiro é tratado
 * sempre em centavos (inteiro) para evitar erro de ponto flutuante.
 */

const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    event: { type: "string" },
    product_id: { type: "string" },
    from: { type: "string", format: "date-time" },
    to: { type: "string", format: "date-time" },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

interface SalesQuery {
  event?: string;
  product_id?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export async function salesRoutes(app: FastifyInstance) {
  app.get(
    "/sales",
    { schema: { querystring: querySchema } },
    async (req) => {
      const q = req.query as SalesQuery;

      // Monta o WHERE dinamicamente a partir dos filtros presentes.
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (q.event) {
        where.push("event_type = @event");
        params.event = q.event;
      }
      if (q.product_id) {
        where.push("product_id = @product_id");
        params.product_id = q.product_id;
      }
      if (q.from) {
        where.push("received_at >= @from");
        params.from = q.from;
      }
      if (q.to) {
        where.push("received_at <= @to");
        params.to = q.to;
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      // ----- Agregações -----
      const byEvent = db
        .prepare(
          `SELECT event_type, COUNT(*) AS count, SUM(amount_cents) AS amount_cents
           FROM sales ${whereSql} GROUP BY event_type`,
        )
        .all(params) as { event_type: string; count: number; amount_cents: number }[];

      const totals = { approved: 0, refunded: 0, chargeback: 0 };
      let totalEvents = 0;
      const byEventMap: Record<string, { count: number; amount_cents: number }> = {};
      for (const row of byEvent) {
        totalEvents += row.count;
        byEventMap[row.event_type] = {
          count: row.count,
          amount_cents: row.amount_cents ?? 0,
        };
        if (row.event_type === "purchase.approved") totals.approved = row.amount_cents ?? 0;
        if (row.event_type === "purchase.refunded") totals.refunded = row.amount_cents ?? 0;
        if (row.event_type === "purchase.chargeback") totals.chargeback = row.amount_cents ?? 0;
      }

      const byProduct = db
        .prepare(
          `SELECT product_id, product_name,
                  COUNT(*) AS count,
                  SUM(CASE WHEN event_type = 'purchase.approved' THEN amount_cents ELSE 0 END) AS revenue_cents
           FROM sales ${whereSql}
           GROUP BY product_id, product_name
           ORDER BY revenue_cents DESC`,
        )
        .all(params) as {
        product_id: string | null;
        product_name: string | null;
        count: number;
        revenue_cents: number;
      }[];

      // ----- Lista paginada -----
      const listParams = { ...params, limit: q.limit, offset: q.offset };
      const events = db
        .prepare(
          `SELECT id, event_id, event_type, transaction_id, product_id, product_name,
                  customer_email, customer_name, amount_cents, currency,
                  occurred_at, received_at
           FROM sales ${whereSql}
           ORDER BY id DESC
           LIMIT @limit OFFSET @offset`,
        )
        .all(listParams);

      return {
        summary: {
          total_events: totalEvents,
          gross_revenue_cents: totals.approved,
          refunds_cents: totals.refunded + totals.chargeback,
          net_revenue_cents: totals.approved - totals.refunded - totals.chargeback,
          currency: "BRL",
          by_event: byEventMap,
          by_product: byProduct,
        },
        pagination: { limit: q.limit, offset: q.offset, returned: events.length },
        events,
      };
    },
  );
}
