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

    const payerName = String(req.body?.payerName || "").trim();
    const payerPhone = String(req.body?.payerPhone || "").replace(/\D/g, "");

    // cria um email único (pra não parecer robô)
    const payerEmail = `cliente${Date.now()}@pedido.com`;

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
        payer: {
          email: payerEmail,
          first_name: payerName ? payerName.split(" ")[0] : undefined,
          last_name: payerName ? payerName.split(" ").slice(1).join(" ") : undefined,
          phone: payerPhone
            ? { area_code: payerPhone.substring(0, 2), number: payerPhone.substring(2) }
            : undefined,
        },
        date_of_expiration: expires,
      },
      requestOptions: { idempotencyKey },
    });

    const status = result?.status;
    const statusDetail = result?.status_detail;

    // se não ficou "pending", não entregue um QR "morto"
    if (status !== "pending") {
      return res.status(400).json({
        error: "Pagamento não ficou pendente (não dá pra pagar esse QR).",
        status,
        status_detail: statusDetail,
        payment_id: result?.id ?? null,
      });
    }

    const tx = result?.point_of_interaction?.transaction_data;

    return res.json({
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
    return res.status(status).json({ error: "Erro ao gerar PIX", status, details });
  }
});

app.get("/payment/:id", async (req, res) => {
  try {
    const payment = new Payment(client);
    const result = await payment.get({ id: req.params.id });

    return res.json({
      id: result?.id ?? null,
      status: result?.status ?? null,
      status_detail: result?.status_detail ?? null,
    });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.cause || e?.response?.data || e?.message || e;
    console.error("MP GET ERROR:", status, details);
    return res.status(status).json({ error: "Falha ao consultar pagamento", status, details });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API rodando na porta", PORT));