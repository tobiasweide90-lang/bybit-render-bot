import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json());

// Sicherheits-Secret für TV
const SECRET = "S1ckline2012";

app.post("/", async (req, res) => {
  try {
    const data = req.body;

    if (data.secret !== SECRET) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    const { event, symbol, price, sl, tp, lvg } = data;
    if (!event || !symbol || !price)
      return res.status(400).json({ ok: false, error: "Missing fields" });

    const side = event.includes("LONG")
      ? "Buy"
      : event.includes("SHORT")
      ? "Sell"
      : null;

    if (!side) return res.status(400).json({ ok: false, error: "Invalid event" });

    const qty = 0.001; // Beispielmenge
    const BASE_URL = process.env.BYBIT_API_URL?.trim().replace(/\s+/g, "") || "https://api.bytick.com";

    const API_KEY = process.env.BYBIT_API_KEY;
    const API_SECRET = process.env.BYBIT_API_SECRET;
    if (!API_KEY || !API_SECRET)
      throw new Error("API credentials missing");

    // Fallback für TP/SL falls TV keine schickt
    let takeProfit = tp || (side === "Buy" ? price * 1.003 : price * 0.997);
    let stopLoss = sl || (side === "Buy" ? price * 0.997 : price * 1.003);
    takeProfit = parseFloat(takeProfit).toFixed(2);
    stopLoss = parseFloat(stopLoss).toFixed(2);

    // --- Signierung ---
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const body = new URLSearchParams({
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: qty.toString(),
      timeInForce: "GTC",
      takeProfit,
      stopLoss,
      positionIdx: "0"
    }).toString();

    const preSign = timestamp + API_KEY + recvWindow + body;
    const sign = crypto.createHmac("sha256", API_SECRET).update(preSign).digest("hex");

    const resp = await axios.post(`${BASE_URL}/v5/order/create`, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": sign,
        // Bypass headers
        "Origin": "https://www.bybit.com",
        "Referer": "https://www.bybit.com/",
        "User-Agent": "Mozilla/5.0 (Render Bot)"
      }
    });

    res.json({
      ok: true,
      message: `Opened ${side} ${symbol} @${price}`,
      bybitResponse: resp.data
    });
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: err.response?.data || err.message
    });
  }
});

// Render nutzt Port von Env-Var PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
