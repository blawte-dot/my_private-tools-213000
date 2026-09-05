# binance-square-bot

Automated Binance Square publishing bot. Runs on a `*/5 * * * *` GitHub
Actions schedule; `bot/index.mjs` self-gates so a real post only happens
roughly every 25 minutes, tracked from the last **successful** publish in
`data/history.json` (not from the cron tick itself), so a delayed or missed
GitHub Actions run just shifts the next post instead of skipping it.

## Content mix

Every 5 successful posts: 4 are 4H technical analysis (real Binance Spot
klines/EMA/SMA/RSI/support-resistance), 1 is "other" content, rotating
through 6 types — crypto news (GDELT, war/military topics filtered out),
top movers, education, market update, bull-vs-bear scenario, and a
liquidity watchlist. Every ticker mention uses a `$CASHTAG`. Coin
selection avoids repeating the same asset within a calendar day where
possible.

## Health

`data/health.json` tracks `lastSuccessfulPost`, `lastFailedAttempt`,
`lastFailureReason`, and `consecutiveFailures` — useful for spotting a
stuck bot from the repo alone, without digging through Actions logs.
`data/history.json` keeps the last 500 successful posts.