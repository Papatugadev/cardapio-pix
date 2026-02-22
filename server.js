import express from "express";
import mercadopago from "mercadopago";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

mercadopago.configure({
  access_token: "SEU_ACCESS_TOKEN_AQUI"
});

// criar pagamento
app.post("/criar-pagamento", async (req, res) => {
  try {

    const { items, total, orderId } = req.body;

    const preference = {
      items: items.map(item => ({
        title: item.name,
        quantity: item.qty,
        currency_id: "BRL",
        unit_price: item.unitPrice
      })),

      payment_methods: {
        installments: 12
      },

      back_urls: {
        success: "https://seusite.com/sucesso.html",
        failure: "https://seusite.com/erro.html"
      },

      notification_url: "https://seuservidor.com/webhook",

      metadata: {
        orderId
      }
    };

    const response = await mercadopago.preferences.create(preference);

    res.json({
      init_point: response.body.init_point
    });

  } catch (e) {
    console.log(e);
    res.status(500).send("erro");
  }
});

// webhook confirmação
app.post("/webhook", (req, res) => {
  console.log("Pagamento confirmado:", req.body);
  res.sendStatus(200);
});

app.listen(3000, () => console.log("Servidor rodando"));