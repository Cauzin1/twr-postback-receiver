import type { FastifyInstance } from "fastify";
import { db } from "../db";

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

interface CurrencyTotals {
  gross_revenue_cents: number;
  refunds_cents: number;
  net_revenue_cents: number;
}

export async function salesRoutes(app: FastifyInstance) {
  app.get(
    "/sales",
    { schema: { querystring: querySchema } },
    async (req) => {
      const q = req.query as SalesQuery;

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

      const byEventRows = db
        .prepare(
          `SELECT event_type, COUNT(*) AS count
           FROM sales ${whereSql} GROUP BY event_type`,
        )
        .all(params) as { event_type: string; count: number }[];

      let totalEvents = 0;
      const byEvent: Record<string, { count: number }> = {};
      for (const row of byEventRows) {
        totalEvents += row.count;
        byEvent[row.event_type] = { count: row.count };
      }

      const moneyRows = db
        .prepare(
          `SELECT currency, event_type, SUM(amount_cents) AS amount_cents
           FROM sales ${whereSql} GROUP BY currency, event_type`,
        )
        .all(params) as { currency: string; event_type: string; amount_cents: number }[];

      const byCurrency: Record<string, CurrencyTotals> = {};
      for (const row of moneyRows) {
        const totals = (byCurrency[row.currency] ??= {
          gross_revenue_cents: 0,
          refunds_cents: 0,
          net_revenue_cents: 0,
        });
        const amount = row.amount_cents ?? 0;
        if (row.event_type === "purchase.approved") {
          totals.gross_revenue_cents += amount;
        } else if (
          row.event_type === "purchase.refunded" ||
          row.event_type === "purchase.chargeback"
        ) {
          totals.refunds_cents += amount;
        }
      }
      for (const totals of Object.values(byCurrency)) {
        totals.net_revenue_cents = totals.gross_revenue_cents - totals.refunds_cents;
      }

      const byProduct = db
        .prepare(
          `SELECT product_id, product_name, currency,
                  COUNT(*) AS count,
                  SUM(CASE WHEN event_type = 'purchase.approved' THEN amount_cents ELSE 0 END) AS revenue_cents
           FROM sales ${whereSql}
           GROUP BY product_id, product_name, currency
           ORDER BY revenue_cents DESC`,
        )
        .all(params) as {
        product_id: string | null;
        product_name: string | null;
        currency: string;
        count: number;
        revenue_cents: number;
      }[];

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
          by_currency: byCurrency,
          by_event: byEvent,
          by_product: byProduct,
        },
        pagination: { limit: q.limit, offset: q.offset, returned: events.length },
        events,
      };
    },
  );
}
