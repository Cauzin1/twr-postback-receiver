import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { webhookRoutes } from "./routes/webhooks";
import { salesRoutes } from "./routes/sales";

/**
 * Monta a instância do Fastify com as rotas e um tratamento de erro padrão.
 * Separado do server.ts para facilitar testes (build sem subir a porta).
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
    // Evita vazar detalhe interno em payload gigante; corpo acima disso -> 413.
    bodyLimit: 1_048_576, // 1 MB
  });

  // Healthcheck simples para o Render e para monitoração.
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  // Raiz: aponta para a documentação rápida.
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

  // Erro de validação de schema vira 400 legível; o resto é logado.
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
