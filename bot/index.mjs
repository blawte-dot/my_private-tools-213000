const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;

if (!key) {
  throw new Error("BINANCE KEY NOT FOUND");
}

const response = await fetch(
  "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Square-OpenAPI-Key": key,
    },
    body: JSON.stringify({
      bodyTextOnly: "🤖 Binance Square Bot test — hello from my bot!",
    }),
  }
);

const result = await response.text();

console.log("STATUS:", response.status);
console.log("RESULT:", result);
