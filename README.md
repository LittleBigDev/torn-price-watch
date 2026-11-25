# Torn Price Watch

Userscript for [Torn](https://www.torn.com): watch items and get an alert when one is listed under your max price, on the item market or in a player's bazaar.

## Install

With Violentmonkey, Tampermonkey or Torn PDA, open [torn-price-watch.user.js](https://raw.githubusercontent.com/LittleBigDev/torn-price-watch/main/torn-price-watch.user.js) and confirm. Updates then arrive automatically.

## Use

Click the price tag icon next to your status icons, enter a **Public Only** API key, then add items with their max price.

- Item market listings come from the Torn API, bazaar listings from [weav3r.dev](https://weav3r.dev) (community data, can lag a few minutes).
- An alert shows as a browser notification (when the userscript host supports it) and a banner on the page; click it to open the listing.
- Each listing alerts once. Only one Torn tab polls at a time.
- The script never buys anything: you do.

## License

MIT
