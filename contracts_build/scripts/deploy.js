/**
 * Deploy MTBGemsV2 to Polygon mainnet.
 *
 * Required env vars:
 *   DEPLOYER_KEY   - private key (with 0x prefix) of the wallet doing the deploy.
 *                    Same wallet will receive MINTER_ROLE. Must have ~2 MATIC.
 *   SAFE_ADDRESS   - address of the Gnosis Safe 2-of-3 that will hold DEFAULT_ADMIN_ROLE
 *                    and PAUSER_ROLE.
 *   POLYGON_RPC    - (optional) RPC URL. Default = publicnode.
 *
 * Usage:
 *   POLYGON_RPC=https://polygon-bor-rpc.publicnode.com \
 *   DEPLOYER_KEY=0x... \
 *   SAFE_ADDRESS=0x... \
 *   npx hardhat run scripts/deploy.js --network polygon
 */

const hre = require("hardhat");

// Supply caps por tier (1-9). Inmutables. Coinciden con la scarcity declarada
// en whitepaper + audit Round 2 § Smart Contract Migration Plan.
const TIER_CAPS = [1, 1, 5, 50, 100, 500, 1000, 4000, 10000];

// tokenURIs canónicos por tier (1-9). IPFS CIDs validados 2026-06-14.
// Coinciden con `functions/constants.js` GEM_TOKEN_URIS.
const TIER_URIS = [
  "ipfs://bafkreiemxipdlvqezbtb4xtr57u5bttt6lf4nwtyjytjc3po5icyuuhopm",
  "ipfs://bafkreidci6pki2umr2tzg6ss6w55ys7uxipwpna24fg4v67pu6rj7ogdja",
  "ipfs://bafkreiap2xu6hcaed6zxtxv2yealxay3v5cde5xuk55rscbief3x3i63n4",
  "ipfs://bafkreige2d3j2flwmz2sq432iwji7i72yx42c7kbxiue75pkhjk54nwjsu",
  "ipfs://bafkreiblecr5ggrb33xw2qwe7p3dkvzctxmb7airb7s6nhlog2h6l3ieaa",
  "ipfs://bafkreidsd7rypvd6tz22eyqaanugjlydexbr26w3jn6eblwa4je7ymowem",
  "ipfs://bafkreietbkcigg37pxropkd4web4xtgbfzkz6mz3thgc4j7wnizi7is7gu",
  "ipfs://bafkreiesew44ay2l5gj6lic74ylmor6mnai532dxla6sfxy6bt6x6muclq",
  "ipfs://bafkreibx455uher6cdea6sm3fagj4qdu6u4rfu3w52leptffoorrmzdd5y",
];

async function main() {
  const safeAddress = process.env.SAFE_ADDRESS;
  if (!safeAddress || !/^0x[a-fA-F0-9]{40}$/.test(safeAddress)) {
    throw new Error("SAFE_ADDRESS env var missing or invalid (must be 0x + 40 hex)");
  }
  if (!process.env.DEPLOYER_KEY) {
    throw new Error("DEPLOYER_KEY env var missing");
  }

  // Wallet del deployer (= MINTER_ROLE = backend EOA)
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddr);

  console.log("================================================================");
  console.log("MTBGemsV2 Deploy — Polygon Mainnet");
  console.log("================================================================");
  console.log("Deployer (will get MINTER_ROLE):", deployerAddr);
  console.log("Deployer balance (MATIC):", hre.ethers.formatEther(balance));
  console.log("Safe (will get ADMIN+PAUSER):  ", safeAddress);
  console.log("Tier caps:", TIER_CAPS.join(", "));
  console.log("Tier URIs:", TIER_URIS.length, "set");
  console.log("================================================================");

  if (balance < hre.ethers.parseEther("0.5")) {
    console.warn("⚠️  Balance < 0.5 MATIC, deploy may fail. Recommend 2 MATIC minimum.");
  }

  console.log("\nDeploying...");
  const MTBGemsV2 = await hre.ethers.getContractFactory("MTBGemsV2");

  // Gas estimation (sanity check antes de enviar)
  const deployTx = await MTBGemsV2.getDeployTransaction(
    safeAddress,        // admin
    deployerAddr,       // minter
    TIER_CAPS,          // caps[9]
    TIER_URIS           // uris[9]
  );
  const estimatedGas = await hre.ethers.provider.estimateGas({ ...deployTx, from: deployerAddr });
  const feeData = await hre.ethers.provider.getFeeData();
  const estimatedCost = estimatedGas * (feeData.maxFeePerGas || feeData.gasPrice);
  console.log("Estimated gas:", estimatedGas.toString());
  console.log("Estimated cost:", hre.ethers.formatEther(estimatedCost), "MATIC");

  console.log("\nSending deploy transaction...");
  const contract = await MTBGemsV2.deploy(
    safeAddress,
    deployerAddr,
    TIER_CAPS,
    TIER_URIS
  );

  console.log("Deploy tx hash:", contract.deploymentTransaction().hash);
  console.log("Waiting for confirmation...");
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log("\n================================================================");
  console.log("✅ DEPLOY SUCCESSFUL");
  console.log("================================================================");
  console.log("Contract address:", contractAddress);
  console.log("Explorer:        https://polygonscan.com/address/" + contractAddress);
  console.log("Deploy tx:       https://polygonscan.com/tx/" + contract.deploymentTransaction().hash);
  console.log("================================================================");

  console.log("\n📝 Next steps:");
  console.log("  1. Update functions/constants.js:");
  console.log(`     MTBGEMS_CONTRACT = '${contractAddress}'`);
  console.log("  2. Verify on Polygonscan:");
  console.log(`     npx hardhat verify --network polygon ${contractAddress} \\`);
  console.log(`       ${safeAddress} ${deployerAddr} \\`);
  console.log(`       '[${TIER_CAPS.join(",")}]' '[${TIER_URIS.map(u => `"${u}"`).join(",")}]'`);
  console.log("  3. Test a mint from deployer wallet (MINTER_ROLE):");
  console.log(`     contract.mintGem(<recipient>, 9, "MTB-TEST-001")`);
  console.log("  4. Optionally rotate keystore for backend, since deployer key = MINTER.");
  console.log("================================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
