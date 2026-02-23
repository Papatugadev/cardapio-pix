import express from "express";
import cors from "cors";
import "dotenv/config";
import crypto from "crypto";
import { MercadoPagoConfig, Payment } from "mercadopago";
import admin from "firebase-admin";


const app = express();
app.use(cors());
app.use(express.json());

// ===== Mercado Pago =====
const accessToken = process.env.MP_ACCESS_TOKEN;
if (!accessToken) {
  console.error("Faltou MP_ACCESS_TOKEN no Render.");
  process.exit(1);
}
const mp = new MercadoPagoConfig({ accessToken });
const paymentApi = new Payment(mp);

// ===== Webhook Secret (segurança) =====
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
 * body: { total, description, payerName, payerPhone, orderId, rid }
 * retorna: { payment_id, status, qr_code, qr_code_base64, date_of_expiration }
 */
app.post("/pix", async (req, res) => {
  try {
    const total = Number(req.body?.total);
    const description = String(req.body?.description || "Pedido Restaurante");

    const orderId = String(req.body?.orderId || "").trim(); // obrigatório
    const rid = String(req.body?.rid || "").trim(); // 🔥 obrigatório no multi-restaurante

    const payerName = String(req.body?.payerName || "").trim();
    const payerPhone = String(req.body?.payerPhone || "").replace(/\D/g, "");

    // email único
    const payerEmail = `cliente${Date.now()}@pedido.com`;

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "total inválido" });
    }
    if (!orderId) {
      return res.status(400).json({ error: "orderId é obrigatório" });
    }
    if (!rid) {
      return res.status(400).json({ error: "rid é obrigatório (multi-restaurante)" });
    }

    const idempotencyKey = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    const result = await paymentApi.create({
      body: {
        transaction_amount: Number(total.toFixed(2)),
        description,
        payment_method_id: "pix",

        // ✅ mantém compat com seu webhook antigo
        external_reference: orderId,

        // ✅ AQUI vai o rid (fonte da verdade pro webhook)
        metadata: {
          rid,
          orderId,
        },

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

    if (status !== "pending") {
      return res.status(400).json({
        error: "Pagamento não ficou pendente (não dá pra pagar esse QR).",
        status,
        status_detail: statusDetail,
        payment_id: result?.id ?? null,
      });
    }

    // ✅ paymentId certo
    const paymentId = String(result?.id || "");

    const mpData = {
      payment_id: paymentId,
      status,
      status_detail: statusDetail || null,
      rid,
      orderId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // ✅ Atualiza no caminho CERTO (multi-restaurante)
    const batch = db.batch();

    const privRef = db.collection("restaurants").doc(rid).collection("orders").doc(orderId);
    const pubRef = db.collection("restaurants").doc(rid).collection("orders_public").doc(orderId);

    batch.set(
      privRef,
      { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    batch.set(
      pubRef,
      { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // ✅ (Opcional) compat com seu modelo antigo (raiz)
    const legacyPriv = db.collection("orders").doc(orderId);
    const legacyPub = db.collection("orders_public").doc(orderId);

    batch.set(
      legacyPriv,
      { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    batch.set(
      legacyPub,
      { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    await batch.commit();

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

/**
 * Webhook Mercado Pago
 * URL: https://SEU-RENDER.onrender.com/webhook/mercadopago?secret=SEU_WEBHOOK_SECRET
 */
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const secret = String(req.query?.secret || "");
      if (secret !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    const paymentId = String(req.body?.data?.id || req.body?.id || "").trim();
    if (!paymentId) return res.status(200).json({ ok: true, ignored: "no payment id" });

    // fonte da verdade
    const p = await paymentApi.get({ id: paymentId });

    const status = String(p?.status || "");
    const statusDetail = String(p?.status_detail || "");

    // ✅ pega rid do metadata (principal)
    const rid = String(p?.metadata?.rid || "").trim();

    // ✅ orderId pode vir do metadata ou external_reference
    const orderId = String(p?.metadata?.orderId || p?.external_reference || "").trim();

    if (!rid || !orderId) {
      return res.status(200).json({
        ok: true,
        ignored: "missing rid/orderId",
        rid,
        orderId,
      });
    }

    const mpData = {
      payment_id: String(p?.id || paymentId),
      status,
      status_detail: statusDetail || null,
      rid,
      orderId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const batch = db.batch();

    const privRef = db.collection("restaurants").doc(rid).collection("orders").doc(orderId);
    const pubRef = db.collection("restaurants").doc(rid).collection("orders_public").doc(orderId);

    const baseUpdate = {
      mp: mpData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status === "approved") {
      batch.set(
        privRef,
        {
          ...baseUpdate,
          status: "em_preparo",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      batch.set(
        pubRef,
        {
          ...baseUpdate,
          status: "em_preparo",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      batch.set(privRef, baseUpdate, { merge: true });
      batch.set(pubRef, baseUpdate, { merge: true });
    }

    // ✅ (Opcional) compat com coleção raiz
    const legacyPriv = db.collection("orders").doc(orderId);
    const legacyPub = db.collection("orders_public").doc(orderId);

    if (status === "approved") {
      batch.set(
        legacyPriv,
        { ...baseUpdate, status: "em_preparo", paidAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      batch.set(
        legacyPub,
        { ...baseUpdate, status: "em_preparo", paidAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } else {
      batch.set(legacyPriv, baseUpdate, { merge: true });
      batch.set(legacyPub, baseUpdate, { merge: true });
    }

    await batch.commit();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err?.message || err);
    return res.status(200).json({ ok: true });
  }
});

// Debug opcional
app.get("/payment/:id", async (req, res) => {
  try {
    const result = await paymentApi.get({ id: req.params.id });
    return res.json({
      id: result?.id ?? null,
      status: result?.status ?? null,
      status_detail: result?.status_detail ?? null,
      external_reference: result?.external_reference ?? null,
      metadata: result?.metadata ?? null,
    });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.cause || e?.response?.data || e?.message || e;
    return res.status(status).json({ error: "Falha ao consultar pagamento", status, details });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API rodando na porta", PORT));