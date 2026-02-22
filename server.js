import express from "express";
import cors from "cors";
import "dotenv/config";
import crypto from "crypto";
import { MercadoPagoConfig, Payment } from "mercadopago";
import admin from "firebase-admin";

const app = express();

// ===== CORS (libera geral) =====
// Se quiser travar depois, eu te passo como liberar só seu domínio da Vercel.
app.use(cors());
app.use(express.json());

// ===== Mercado Pago =====
const accessToken = process.env.MP_ACCESS_TOKEN;
if (!accessToken) {
  console.error("Faltou MP_ACCESS_TOKEN no Render (NÃO coloque no GitHub).");
  process.exit(1);
}
const mpClient = new MercadoPagoConfig({ accessToken });
const paymentApi = new Payment(mpClient);

// ===== Webhook Secret =====
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
if (!WEBHOOK_SECRET) {
  console.warn("AVISO: WEBHOOK_SECRET não definido (recomendado definir no Render).");
}

// ===== Firebase Admin =====
const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!saRaw) {
  console.error("Faltou FIREBASE_SERVICE_ACCOUNT no Render (JSON do service account).");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(saRaw);
} catch (e) {
  console.error("FIREBASE_SERVICE_ACCOUNT não é um JSON válido.");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ===== Healthcheck =====
app.get("/", (req, res) => {
  res.json({ ok: true, service: "cardapio-pagamentos" });
});

/**
 * POST /pix
 * body: { total, description, payerName, payerPhone, orderId }
 * retorna: { payment_id, status, qr_code, qr_code_base64, date_of_expiration }
 */
app.post("/pix", async (req, res) => {
  try {
    const total = Number(req.body?.total);
    const description = String(req.body?.description || "Pedido Restaurante");

    const orderId = String(req.body?.orderId || "").trim();
    const payerName = String(req.body?.payerName || "").trim();
    const payerPhone = String(req.body?.payerPhone || "").replace(/\D/g, "");

    // email único pra evitar bloqueio por “robô”
    const payerEmail = `cliente${Date.now()}@pedido.com`;

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "total inválido" });
    }
    if (!orderId) {
      return res.status(400).json({ error: "orderId é obrigatório" });
    }

    const idempotencyKey = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    const result = await paymentApi.create({
      body: {
        transaction_amount: Number(total.toFixed(2)),
        description,
        payment_method_id: "pix",
        external_reference: orderId, // linka pagamento ao pedido
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

    // Se não ficou pending, NÃO devolve QR “morto”
    if (status !== "pending") {
      return res.status(400).json({
        error: "Pagamento não ficou pendente (não dá pra pagar esse QR).",
        status,
        status_detail: statusDetail,
        payment_id: result?.id ?? null,
      });
    }

    const paymentId = String(result?.id || "");

    // salva no Firestore (orders)
    await db.collection("orders").doc(orderId).set(
      {
        mp: {
          payment_id: paymentId,
          status,
          status_detail: statusDetail || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // salva no Firestore (orders_public)
    await db.collection("orders_public").doc(orderId).set(
      {
        mp: {
          payment_id: paymentId,
          status,
          status_detail: statusDetail || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const tx = result?.point_of_interaction?.transaction_data;

    return res.json({
      payment_id: paymentId,
      status: status ?? null,
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

/**
 * Webhook Mercado Pago
 * URL no MP:
 * https://SEU-RENDER.onrender.com/webhook/mercadopago?secret=SEU_WEBHOOK_SECRET
 */
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    // segurança simples por querystring
    if (WEBHOOK_SECRET) {
      const secret = String(req.query?.secret || "");
      if (secret !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    // MP costuma mandar: { type: "payment", data: { id: "123" } }
    const paymentId = String(req.body?.data?.id || req.body?.id || "");
    if (!paymentId) {
      return res.status(200).json({ ok: true, ignored: "no payment id" });
    }

    // Consulta pagamento real (fonte da verdade)
    const p = await paymentApi.get({ id: paymentId });

    const status = String(p?.status || "");
    const statusDetail = String(p?.status_detail || "");
    const orderId = String(p?.external_reference || "").trim();

    if (!orderId) {
      return res.status(200).json({ ok: true, ignored: "no external_reference" });
    }

    const mpData = {
      payment_id: String(p?.id || paymentId),
      status,
      status_detail: statusDetail || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const batch = db.batch();

    const orderRef = db.collection("orders").doc(orderId);
    const pubRef = db.collection("orders_public").doc(orderId);

    const baseUpdate = {
      mp: mpData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status === "approved") {
      batch.set(
        orderRef,
        { ...baseUpdate, status: "em_preparo", paidAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      batch.set(
        pubRef,
        { ...baseUpdate, status: "em_preparo", paidAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } else {
      batch.set(orderRef, baseUpdate, { merge: true });
      batch.set(pubRef, baseUpdate, { merge: true });
    }

    await batch.commit();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err?.message || err);
    // Mercado Pago pode retentar; retornamos 200 para não ficar em loop de erro
    return res.status(200).json({ ok: true });
  }
});

// Debug: consultar pagamento
app.get("/payment/:id", async (req, res) => {
  try {
    const result = await paymentApi.get({ id: req.params.id });
    return res.json({
      id: result?.id ?? null,
      status: result?.status ?? null,
      status_detail: result?.status_detail ?? null,
      external_reference: result?.external_reference ?? null,
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