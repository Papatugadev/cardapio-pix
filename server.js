import express from "express";
import cors from "cors";
import "dotenv/config";
import crypto from "crypto";
import { MercadoPagoConfig, Payment } from "mercadopago";

const app = express();
app.use(cors());
app.use(express.json());

const accessToken = process.env.MP_ACCESS_TOKEN;
if (!accessToken) {
  console.error("Faltou MP_ACCESS_TOKEN no Render (.env não deve ir pro GitHub).");
  process.exit(1);
}

const client = new MercadoPagoConfig({ accessToken });

app.get("/", (req, res) => {
  res.json({ ok: true, service: "cardapio-pagamentos" });
});

app.post("/pix", async (req, res) => {
  try {
    const total = Number(req.body?.total);
    const description = String(req.body?.description || "Pedido Restaurante");
    const payerEmail = String(req.body?.payerEmail || "test@test.com").trim();

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "total inválido" });
    }

    const payment = new Payment(client);

    const idempotencyKey = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    const result = await payment.create({
      body: {
        transaction_amount: Number(total.toFixed(2)),
        description,
        payment_method_id: "pix",
        payer: { email: payerEmail },
        date_of_expiration: expires,
      },
      requestOptions: { idempotencyKey },
    });

    const tx = result?.point_of_interaction?.transaction_data;

    res.json({
      payment_id: result?.id ?? null,
      status: result?.status ?? null,
      date_of_expiration: result?.date_of_expiration ?? null,
      qr_code: tx?.qr_code ?? "",
      qr_code_base64: tx?.qr_code_base64 ?? "",
    });
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    const details = err?.cause || err?.response?.data || err?.message || err;
    console.error("MP ERROR:", status, details);
    res.status(status).json({ error: "Erro ao gerar PIX", status, details });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API rodando na porta", PORT));