# Examples

IronBee Express ships a few ready-made scenarios in [`examples/scenarios/`](../examples/scenarios).
Each one is a start URL, a goal and the values it needs. They appear in the UI's scenario list and in
`npm run dev -- scenarios list`.

| Example | Site | What it does | Text model | Account |
| --- | --- | --- | --- | --- |
| `google-flights-round-trip` | Google Flights | a round trip for two adults, with autocomplete, a two-date picker and the passenger count | not needed | none |
| `google-maps-transit` | Google Maps | directions between two places by public transport, with a departure time, then the first route's details | needed | none |
| `ebay-keyboard` | eBay | a search, two filters, sorting, then the first listing | not needed | none |
| `ikea-office-chair` | IKEA | a search, a color filter, sorting by price, then the first product's details | not needed | none |
| `bbc-weather-next-day` | BBC Weather | a city search, its forecast, then the next day's | not needed | none |
| `eshop-add-to-cart` | IronBee's e-shop demo | signs in, then picks the right product among many "Add to cart" buttons | not needed | demo login |
| `eshop-checkout-payment-bug` | IronBee's e-shop demo | a full checkout that is expected to FAIL: the page says the order was placed, but the backend did not process it | not needed | demo login |

`google-maps-transit` needs a text model because the engine alone cannot get the departure time
applied; the text model takes over for that part. See
[Text and secrets](text-and-secrets.md#when-the-engine-is-stuck).

## Running one

In the UI, **Load** the example, type the password in the `password` row if it has one, and press
**Run**. From the terminal:

```bash
npm run dev -- run --scenario google-flights-round-trip
npm run dev -- run --scenario eshop-add-to-cart --password password=demo123
```

The e-shop password, `demo123`, is a public demo login that the e-shop's own login page shows. It is
still handled as a secret, so type it again after every **Load**.

The first run of an example explores with the engine. When it passes, it is recorded, and later runs
replay the recording in a second or two. Running never changes the example file. See
[Scenarios](scenarios.md).

## Notes

- `google-flights-round-trip` searches fixed dates in April 2027. Edit the goal once they have
  passed.
- The e-shop examples need the demo site, `eshop.demo.ironbee.dev`, to be up. With IronBee
  connected, the review also reads the backend's logs, which is where the checkout's failure shows.
- Sites like Google Flights change between visits, so a replay may not match. The engine then
  finishes the run and the recording is updated.
