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

// ===== Helpers =====
function nowIsoPlusMinutes(min) {
  return new Date(Date.now() + min * 60 * 1000).toISOString();
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function makeIdempotencyKey({ rid, orderId, totalCentsBucket }) {
  // Idempotência real: mesma chave dentro do mesmo "bucket" de tempo
  // - evita criar vários pagamentos se o cliente clicar 2x ou se a rede falhar
  // - permite gerar um novo pagamento depois (mudando o bucket)
  const raw = `pix|${rid}|${orderId}|${totalCentsBucket}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function getTx(p) {
  return p?.point_of_interaction?.transaction_data || null;
}

function isFuture(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > Date.now();
}


function stableEmailFromPhone(phoneDigits, rid, orderId) {
  const p = safeStr(phoneDigits).replace(/\D/g, "");
  if (p && p.length >= 10) return `${p}@cliente.cardapio`;
  const h = crypto.createHash("sha1").update(`${rid}|${orderId}`).digest("hex").slice(0, 10);
  return `cliente_${h}@cliente.cardapio`;
}

// ===== Healthcheck =====
app.get("/", (req, res) => {
  res.json({ ok: true, service: "cardapio-pagamentos" });
});

/**
 * POST /pix
 * body: { total, description, payerName, payerPhone, payerCpf?, orderId, rid }
 * retorna: { payment_id, status, qr_code, qr_code_base64, date_of_expiration, reused }
 *
 * ✅ Melhorias:
 * - Reusa pagamento "pending" existente do pedido (sem duplicar PIX)
 * - Idempotency-Key determinística (retries/click duplo não cria outro pagamento)
 */
app.post("/pix", async (req, res) => {
  try {
    const total = Number(req.body?.total);
    const description = safeStr(req.body?.description || "Pedido Restaurante");

    const orderId = safeStr(req.body?.orderId); // obrigatório
    const rid = safeStr(req.body?.rid); // obrigatório no multi-restaurante

    const payerName = safeStr(req.body?.payerName);
    const payerPhone = safeStr(req.body?.payerPhone).replace(/\D/g, "");

    const payerCpf = safeStr(req.body?.payerCpf).replace(/\D/g, "");

    // email estável (reduz risco / rejected_high_risk)
    const payerEmail = stableEmailFromPhone(payerPhone, rid, orderId);
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "total inválido" });
    }
    if (!orderId) {
      return res.status(400).json({ error: "orderId é obrigatório" });
    }
    if (!rid) {
      return res.status(400).json({ error: "rid é obrigatório (multi-restaurante)" });
    }

    // refs (multi-restaurante)
    const privRef = db.collection("restaurants").doc(rid).collection("orders").doc(orderId);
    const pubRef = db.collection("restaurants").doc(rid).collection("orders_public").doc(orderId);

    // 1) Tenta reusar pagamento existente (se houver)
    const snap = await privRef.get();
    const existingPaymentId = snap.exists ? safeStr(snap.data()?.mp?.payment_id) : "";

    if (existingPaymentId) {
      try {
        const existing = await paymentApi.get({ id: existingPaymentId });
        const exStatus = safeStr(existing?.status);
        const exExp = safeStr(existing?.date_of_expiration);

        if (exStatus === "approved") {
          // Já pago → não cria outro PIX
          return res.status(409).json({
            error: "Pedido já está pago.",
            payment_id: safeStr(existing?.id || existingPaymentId),
            status: exStatus,
          });
        }

        if (exStatus === "pending" && isFuture(exExp)) {
          const tx = getTx(existing);
          // Atualiza mp no Firestore (merge) só para manter status fresco
          const mpData = {
            payment_id: safeStr(existing?.id || existingPaymentId),
            status: exStatus,
            status_detail: safeStr(existing?.status_detail || "") || null,
            rid,
            orderId,
            date_of_expiration: exExp || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          const batch = db.batch();
          batch.set(privRef, { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          batch.set(pubRef, { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

          // compat coleção raiz (opcional, mantém seu legado)
          const legacyPriv = db.collection("orders").doc(orderId);
          const legacyPub = db.collection("orders_public").doc(orderId);
          batch.set(legacyPriv, { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          batch.set(legacyPub, { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

          await batch.commit();

          return res.json({
            payment_id: mpData.payment_id,
            status: exStatus,
            date_of_expiration: exExp || null,
            qr_code: tx?.qr_code ?? "",
            qr_code_base64: tx?.qr_code_base64 ?? "",
            reused: true,
          });
        }
      } catch (e) {
        // se falhar consulta do MP, continua e cria um novo
        console.warn("WARN: falha ao reusar payment existente:", e?.message || e);
      }
    }

    // 2) Criar novo pagamento (PIX) — com idempotência determinística
    const expires = nowIsoPlusMinutes(30); // 30 min

    // bucket de 30 minutos (mesma janela = mesma chave)
    const totalCents = Math.round(Number(total.toFixed(2)) * 100);
    const bucket = Math.floor(Date.now() / (30 * 60 * 1000)); // muda a cada 30min
    const idempotencyKey = makeIdempotencyKey({ rid, orderId, totalCentsBucket: `${totalCents}|${bucket}` });

    const result = await paymentApi.create({
      body: {
        transaction_amount: Number(total.toFixed(2)),
        description,
        payment_method_id: "pix",

        // ✅ mantém compat com seu modelo antigo
        external_reference: orderId,

        // ✅ fonte da verdade (multi-restaurant)
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

    const status = safeStr(result?.status);
    const statusDetail = safeStr(result?.status_detail || "") || null;

    if (status !== "pending") {
      return res.status(400).json({
        error: "Pagamento não ficou pendente (não dá pra pagar esse QR).",
        status,
        status_detail: statusDetail,
        payment_id: result?.id ?? null,
      });
    }

    const paymentId = safeStr(result?.id);
    const tx = getTx(result);

    const mpData = {
      payment_id: paymentId,
      status,
      status_detail: statusDetail,
      rid,
      orderId,
      date_of_expiration: safeStr(result?.date_of_expiration) || expires,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // 3) Salva no Firestore no caminho certo
    const batch = db.batch();

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

    batch.set(legacyPriv, { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    batch.set(legacyPub, { mp: mpData, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    await batch.commit();

    return res.json({
      payment_id: paymentId || null,
      status,
      date_of_expiration: mpData.date_of_expiration || null,
      qr_code: tx?.qr_code ?? "",
      qr_code_base64: tx?.qr_code_base64 ?? "",
      reused: false,
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
      const secret = safeStr(req.query?.secret);
      if (secret !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    // MP pode mandar em formatos diferentes dependendo do "tipo" de notificação
    const paymentId = safeStr(req.body?.data?.id || req.body?.id || req.query?.["data.id"] || "");
    if (!paymentId) return res.status(200).json({ ok: true, ignored: "no payment id" });

    // fonte da verdade
    const p = await paymentApi.get({ id: paymentId });

    const status = safeStr(p?.status);
    const statusDetail = safeStr(p?.status_detail || "") || null;

    // ✅ pega rid do metadata (principal)
    const rid = safeStr(p?.metadata?.rid);

    // ✅ orderId pode vir do metadata ou external_reference
    const orderId = safeStr(p?.metadata?.orderId || p?.external_reference);

    if (!rid || !orderId) {
      return res.status(200).json({
        ok: true,
        ignored: "missing rid/orderId",
        rid,
        orderId,
      });
    }

    const mpData = {
      payment_id: safeStr(p?.id || paymentId),
      status,
      status_detail: statusDetail,
      rid,
      orderId,
      date_of_expiration: safeStr(p?.date_of_expiration) || null,
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
    // webhook nunca deve "cair"
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
      date_of_expiration: result?.date_of_expiration ?? null,
    });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.cause || e?.response?.data || e?.message || e;
    return res.status(status).json({ error: "Falha ao consultar pagamento", status, details });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API rodando na porta", PORT));