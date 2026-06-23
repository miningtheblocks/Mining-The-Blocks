// Constructor args para hardhat verify (MTBGemsV2 — deploy 2026-06-23).
// Uso:
//   POLYGONSCAN_API_KEY=... npx hardhat verify --network polygon \
//     --constructor-args scripts/verify-args.js \
//     0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195

module.exports = [
  "0x83a3F5Bd15302F17B7f2e430900F1d2A40F86aCD",                // admin (Safe)
  "0x0a285CA8BaE2FbA3808bd260f936bCa22F06941e",                // minter (nftv2)
  [1, 1, 5, 50, 100, 500, 1000, 4000, 10000],                  // caps[9]
  [
    "ipfs://bafkreiemxipdlvqezbtb4xtr57u5bttt6lf4nwtyjytjc3po5icyuuhopm",
    "ipfs://bafkreidci6pki2umr2tzg6ss6w55ys7uxipwpna24fg4v67pu6rj7ogdja",
    "ipfs://bafkreiap2xu6hcaed6zxtxv2yealxay3v5cde5xuk55rscbief3x3i63n4",
    "ipfs://bafkreige2d3j2flwmz2sq432iwji7i72yx42c7kbxiue75pkhjk54nwjsu",
    "ipfs://bafkreiblecr5ggrb33xw2qwe7p3dkvzctxmb7airb7s6nhlog2h6l3ieaa",
    "ipfs://bafkreidsd7rypvd6tz22eyqaanugjlydexbr26w3jn6eblwa4je7ymowem",
    "ipfs://bafkreietbkcigg37pxropkd4web4xtgbfzkz6mz3thgc4j7wnizi7is7gu",
    "ipfs://bafkreiesew44ay2l5gj6lic74ylmor6mnai532dxla6sfxy6bt6x6muclq",
    "ipfs://bafkreibx455uher6cdea6sm3fagj4qdu6u4rfu3w52leptffoorrmzdd5y",
  ],
];
