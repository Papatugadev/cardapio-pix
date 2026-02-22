import express from "express";
import cors from "cors";
import "dotenv/config";
import { MercadoPagoConfig, Payment } from "mercadopago";

const app = express();

/**
 * CORS:
 * - Em dev você pode liberar geral.
 * - Em produção, depois a gente limita pro seu domínio do cardápio.
 */
app.use(cors());
app.use(express.json());

const accessToken = process.env.MP_ACCESS_TOKEN;
if (!accessToken) {
  console.error("Faltou MP_ACCESS_TOKEN no .env ou no Render.");
  process.exit(1);
}

const client = new MercadoPagoConfig({ accessToken });

/**
 * Healthcheck (pra ver se tá online)
 */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "cardapio-pagamentos" });
});

/**
 * POST /pix
 * body: { total: number, description?: string, payerEmail?: string }
 * retorna: { id, qr_code, qr_code_base64 }
 */
app.post("/pix", async (req, res) => {
  try {
    const total = Number(req.body?.total);
    const description = String(req.body?.description || "Pedido Restaurante");

    if (!total || total <= 0) {
      return res.status(400).json({ error: "total inválido" });
    }

    const payment = new Payment(client);

    const result = await payment.create({
      body: {
        transaction_amount: total,
        description,
        payment_method_id: "pix",
     payer: { email: "test@test.com" },
      },
    });

    const tx = result?.point_of_interaction?.transaction_data;

    return res.json({
      qr_code: tx?.qr_code || "",
      qr_code_base64: tx?.qr_code_base64 || "",
      payment_id: result?.id || null,
    });
  } catch (err) {
    console.log("ERRO MERCADO PAGO:", err);
    return res.status(500).json({ error: "Erro ao gerar PIX" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API rodando na porta", PORT));
const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

const result = await payment.create({
  body: {
    transaction_amount: Number(total.toFixed(2)),
    description,
    payment_method_id: "pix",
    payer: { email: payerEmail }, 
    date_of_expiration: expires, // <-- importante
  },
  requestOptions: { idempotencyKey }
});
return res.json({
  payment_id: result?.id ?? null,
  status: result?.status ?? null,
  date_of_expiration: result?.date_of_expiration ?? null,
  qr_code: tx?.qr_code ?? "",
  qr_code_base64: tx?.qr_code_base64 ?? "",
});
