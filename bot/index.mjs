const response = await fetch(
  "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
);

if (!response.ok) {
  throw new Error(`Binance API error: ${response.status}`);
}

const data = await response.json();

console.log("BTC PRICE:", data.price);
