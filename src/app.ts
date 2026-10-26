import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { webhookRoutes } from "./routes/webhooks";
import { salesRoutes } from "./routes/sales";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576,
  });

  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  app.get("/", async () => ({
    service: "twr-postback-receiver",
    endpoints: {
      "POST /webhooks/sales": "recebe um postback de venda",
      "GET /sales": "relatório de vendas (filtros: event, product_id, from, to, limit, offset)",
      "GET /health": "healthcheck",
    },
  }));

  app.register(webhookRoutes);
  app.register(salesRoutes);

  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error.validation) {
      return reply.code(400).send({
        error: "validation_error",
        message: error.message,
      });
    }
    req.log.error(error);
    return reply.code(error.statusCode ?? 500).send({
      error: "internal_error",
      message: error.statusCode ? error.message : "unexpected error",
    });
  });

  return app;
}
