const { expect } = require("chai");
const { ethers } = require("hardhat");

const TIER_CAPS = [1, 1, 5, 50, 100, 500, 1000, 4000, 10000];
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

describe("MTBGemsV2", function () {
  let contract, admin, minter, recipient, attacker;
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

  beforeEach(async function () {
    [admin, minter, recipient, attacker] = await ethers.getSigners();
    const F = await ethers.getContractFactory("MTBGemsV2");
    contract = await F.deploy(admin.address, minter.address, TIER_CAPS, TIER_URIS);
    await contract.waitForDeployment();
  });

  it("roles set correctly", async function () {
    expect(await contract.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    expect(await contract.hasRole(MINTER_ROLE, minter.address)).to.equal(true);
    expect(await contract.hasRole(PAUSER_ROLE, admin.address)).to.equal(true);
    expect(await contract.hasRole(MINTER_ROLE, attacker.address)).to.equal(false);
  });

  it("tier caps + URIs set immutably", async function () {
    for (let i = 1; i <= 9; i++) {
      expect(await contract.tierCap(i)).to.equal(TIER_CAPS[i - 1]);
      expect(await contract.tierURI(i)).to.equal(TIER_URIS[i - 1]);
      expect(await contract.tierRemaining(i)).to.equal(TIER_CAPS[i - 1]);
    }
  });

  it("minter can mint a tier-9 gem", async function () {
    const tx = await contract.connect(minter).mintGem(recipient.address, 9, "MTB-TEST-001");
    await expect(tx).to.emit(contract, "GemMinted").withArgs(1, recipient.address, 9, "MTB-TEST-001");
    expect(await contract.ownerOf(1)).to.equal(recipient.address);
    expect(await contract.tokenURI(1)).to.equal(TIER_URIS[8]);
    expect(await contract.tokenTier(1)).to.equal(9);
    expect(await contract.tierMinted(9)).to.equal(1);
    expect(await contract.tierRemaining(9)).to.equal(TIER_CAPS[8] - 1);
  });

  it("non-minter cannot mint (CRIT-S1 fix)", async function () {
    await expect(
      contract.connect(attacker).mintGem(recipient.address, 9, "MTB-EVIL-001")
    ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
  });

  it("admin alone cannot mint (separation of duties)", async function () {
    await expect(
      contract.connect(admin).mintGem(recipient.address, 9, "MTB-EVIL-002")
    ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
  });

  it("supply cap is enforced per tier (CRIT-S2 fix)", async function () {
    // Tier 1 cap = 1
    await contract.connect(minter).mintGem(recipient.address, 1, "MTB-T1-001");
    await expect(
      contract.connect(minter).mintGem(recipient.address, 1, "MTB-T1-002")
    ).to.be.revertedWith("Tier cap reached");
  });

  it("duplicate gemCode reverts", async function () {
    await contract.connect(minter).mintGem(recipient.address, 9, "MTB-DUP");
    await expect(
      contract.connect(minter).mintGem(recipient.address, 9, "MTB-DUP")
    ).to.be.revertedWith("Gem already minted");
  });

  it("mintGem does NOT accept tokenURI param (MED-S1 fix)", async function () {
    // El URI viene del contrato, no del caller. Verificamos que el ABI no acepta 4to arg.
    const fragment = contract.interface.getFunction("mintGem");
    expect(fragment.inputs.length).to.equal(3); // address to, uint8 tier, string gemCode
    expect(fragment.inputs.find(i => i.name === "tokenURI_")).to.equal(undefined);
  });

  it("admin can pause + minter cannot mint while paused", async function () {
    await contract.connect(admin).pause();
    await expect(
      contract.connect(minter).mintGem(recipient.address, 9, "MTB-PAUSED")
    ).to.be.revertedWithCustomError(contract, "EnforcedPause");
    await contract.connect(admin).unpause();
    await contract.connect(minter).mintGem(recipient.address, 9, "MTB-AFTER");
    expect(await contract.tierMinted(9)).to.equal(1);
  });

  it("non-pauser cannot pause", async function () {
    await expect(contract.connect(attacker).pause())
      .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
    await expect(contract.connect(minter).pause())
      .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
  });

  it("renouncing DEFAULT_ADMIN_ROLE reverts (anti-bricking, HIGH-S1 fix)", async function () {
    await expect(
      contract.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address)
    ).to.be.revertedWith("Cannot renounce admin");
  });

  it("admin can revoke minter (key rotation flow)", async function () {
    await contract.connect(admin).revokeRole(MINTER_ROLE, minter.address);
    expect(await contract.hasRole(MINTER_ROLE, minter.address)).to.equal(false);
    await expect(
      contract.connect(minter).mintGem(recipient.address, 9, "MTB-AFTER-REVOKE")
    ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
  });

  it("admin can grant minter to new EOA (key rotation flow)", async function () {
    const newMinter = attacker; // reusing signer for the test
    await contract.connect(admin).grantRole(MINTER_ROLE, newMinter.address);
    await contract.connect(newMinter).mintGem(recipient.address, 9, "MTB-NEW-MINTER");
    expect(await contract.balanceOf(recipient.address)).to.equal(1);
  });

  it("totalMinted reflects across tiers", async function () {
    await contract.connect(minter).mintGem(recipient.address, 9, "g1");
    await contract.connect(minter).mintGem(recipient.address, 9, "g2");
    await contract.connect(minter).mintGem(recipient.address, 8, "g3");
    expect(await contract.totalMinted()).to.equal(3);
  });

  it("rejects mint to zero address", async function () {
    await expect(
      contract.connect(minter).mintGem(ethers.ZeroAddress, 9, "zero")
    ).to.be.revertedWith("Mint to zero");
  });

  it("rejects invalid tier (0 or 10)", async function () {
    await expect(
      contract.connect(minter).mintGem(recipient.address, 0, "t0")
    ).to.be.revertedWith("Invalid tier");
    await expect(
      contract.connect(minter).mintGem(recipient.address, 10, "t10")
    ).to.be.revertedWith("Invalid tier");
  });

  it("rejects empty gemCode", async function () {
    await expect(
      contract.connect(minter).mintGem(recipient.address, 9, "")
    ).to.be.revertedWith("Empty gemCode");
  });
});
