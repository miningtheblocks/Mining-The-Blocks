/**
 * Test mint del MTBGemsV2 — valida que el MINTER_ROLE funciona end-to-end.
 *
 * Mints:
 *   tier 9, code "MTB-TEST-001", recipient = pagosMTB (0x61f7E9...AD4f)
 *
 * Required env vars:
 *   DEPLOYER_KEY    - private key de nftv2 (la wallet con MINTER_ROLE).
 *
 * Usage:
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/test-mint.js --network polygon
 */

const hre = require("hardhat");

const CONTRACT_ADDR = "0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195";
const RECIPIENT = "0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f"; // pagosMTB
const TIER = 9;
const GEM_CODE = "MTB-TEST-001";

const ABI = [
  "function mintGem(address to, uint8 gemTier, string calldata gemCode) external returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function tokenTier(uint256) view returns (uint8)",
  "function tokenGemCode(uint256) view returns (string)",
  "function tierMinted(uint8) view returns (uint256)",
  "function tierRemaining(uint8) view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "event GemMinted(uint256 indexed tokenId, address indexed to, uint8 tier, string gemCode)",
];

async function main() {
  if (!process.env.DEPLOYER_KEY) {
    throw new Error("DEPLOYER_KEY env var missing (private key de nftv2)");
  }

  const [signer] = await hre.ethers.getSigners();
  const signerAddr = await signer.getAddress();
  const balance = await hre.ethers.provider.getBalance(signerAddr);

  console.log("================================================================");
  console.log("MTBGemsV2 — Test Mint");
  console.log("================================================================");
  console.log("Contract:        ", CONTRACT_ADDR);
  console.log("Signer (MINTER): ", signerAddr);
  console.log("Signer MATIC:    ", hre.ethers.formatEther(balance));
  console.log("Recipient:       ", RECIPIENT, "(pagosMTB)");
  console.log("Tier:            ", TIER);
  console.log("Gem code:        ", GEM_CODE);
  console.log("================================================================");

  const contract = new hre.ethers.Contract(CONTRACT_ADDR, ABI, signer);

  // Pre-mint state
  console.log("\n--- Estado ANTES del mint ---");
  console.log("totalMinted:           ", (await contract.totalMinted()).toString());
  console.log("tierMinted(9):         ", (await contract.tierMinted(9)).toString());
  console.log("tierRemaining(9):      ", (await contract.tierRemaining(9)).toString());
  console.log("balanceOf(pagosMTB):   ", (await contract.balanceOf(RECIPIENT)).toString());

  console.log("\n--- Enviando mintGem tx ---");
  const tx = await contract.mintGem(RECIPIENT, TIER, GEM_CODE);
  console.log("tx hash:", tx.hash);
  console.log("Esperando 3 confirmaciones...");
  const receipt = await tx.wait(3);
  console.log("Mined en bloque:", receipt.blockNumber, "| gas usado:", receipt.gasUsed.toString());

  // Parse GemMinted event
  const iface = new hre.ethers.Interface(ABI);
  let mintedTokenId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "GemMinted") {
        mintedTokenId = parsed.args.tokenId.toString();
        console.log("\n--- GemMinted event ---");
        console.log("  tokenId:", parsed.args.tokenId.toString());
        console.log("  to:     ", parsed.args.to);
        console.log("  tier:   ", parsed.args.tier);
        console.log("  gemCode:", parsed.args.gemCode);
      }
    } catch (e) { /* not our event */ }
  }
  if (mintedTokenId === null) {
    throw new Error("No se encontró el evento GemMinted en el receipt — algo salió mal");
  }

  // Post-mint state
  console.log("\n--- Estado DESPUÉS del mint ---");
  console.log("totalMinted:           ", (await contract.totalMinted()).toString());
  console.log("tierMinted(9):         ", (await contract.tierMinted(9)).toString());
  console.log("tierRemaining(9):      ", (await contract.tierRemaining(9)).toString());
  console.log("balanceOf(pagosMTB):   ", (await contract.balanceOf(RECIPIENT)).toString());
  console.log("ownerOf(" + mintedTokenId + "):       ", await contract.ownerOf(mintedTokenId));
  console.log("tokenURI(" + mintedTokenId + "):      ", await contract.tokenURI(mintedTokenId));
  console.log("tokenTier(" + mintedTokenId + "):     ", await contract.tokenTier(mintedTokenId));
  console.log("tokenGemCode(" + mintedTokenId + "):  ", await contract.tokenGemCode(mintedTokenId));

  console.log("\n================================================================");
  console.log("✅ TEST MINT SUCCESSFUL");
  console.log("================================================================");
  console.log("Polygonscan tx:    https://polygonscan.com/tx/" + tx.hash);
  console.log("OpenSea (Polygon): https://opensea.io/assets/matic/" + CONTRACT_ADDR.toLowerCase() + "/" + mintedTokenId);
  console.log("================================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
