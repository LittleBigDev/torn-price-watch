# Torn Price Watch

Userscript for [Torn](https://www.torn.com): watch items and get an alert when one is listed under your max price, on the item market or in a player's bazaar.

## Install

With Violentmonkey, Tampermonkey or Torn PDA, open [torn-price-watch.user.js](https://raw.githubusercontent.com/LittleBigDev/torn-price-watch/main/torn-price-watch.user.js) and confirm. Updates then arrive automatically.

## Use

Click the price tag icon next to your status icons. In **Settings**, enter a **Public Only** API key and pick how often to check (30 s, 1, 2 or 5 min). In **Watch**, add items with their max price.

- The watch list shows the cheapest item market and bazaar price of each item, green when under your max; click a price to open that listing.
- Below it, pick an item to see its 5 cheapest listings under your max, refreshed at every check.
- A new listing under your max triggers a browser notification (when the userscript host supports it) and an alert bar on top of the page, on every Torn tab. It always points to the cheapest current listing and stays until that item has nothing under your max, or until you close it.
- **Pause** stops all automatic checks (no API calls) until you resume.
- Item market listings come from the Torn API, bazaar listings from [weav3r.dev](https://weav3r.dev) (community data, can lag a few minutes).
- Only one Torn tab checks at a time. The script never buys anything: you do.

## License

MIT
