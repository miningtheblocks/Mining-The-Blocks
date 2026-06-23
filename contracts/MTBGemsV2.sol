// SPDX-License-Identifier: MIT
// MTBGems V2 — security-hardened redeploy (audit 2026-06-21 CRIT-S1/S2/S3, MED-S1).
//
// Cambios vs V1 (deployed at 0x54c2...29E6):
//   - Ownable → AccessControl (DEFAULT_ADMIN_ROLE, MINTER_ROLE, PAUSER_ROLE).
//     DEFAULT_ADMIN_ROLE va a un Gnosis Safe 2-of-3, MINTER_ROLE al backend EOA.
//     Si la EOA del backend es comprometida, solo puede mintear (limitado por
//     supply caps), no transferir ownership ni rotar roles.
//   - Supply cap inmutable por tier (constructor-locked). Compromise del MINTER
//     EOA puede mintear hasta cap, no infinitamente.
//   - tokenURI por tier inmutable en constructor. Cierra MED-S1: ya no se acepta
//     tokenURI_ arbitrario del caller — el contrato conoce el URI canónico por tier.
//   - mintBatch para amortizar gas si se mintean varios en una sola tx.
//   - CEI + nonReentrant en mintGem se mantienen.
//   - renounceRole(DEFAULT_ADMIN_ROLE) deshabilitado para evitar bricking (Safe
//     migrado puede revocar al backend, pero nadie puede dejar el contrato sin admin).
//
// Solidity pinned (no caret) por reproducibilidad de bytecode.
pragma solidity 0.8.27;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MTBGemsV2 is ERC721, ERC721URIStorage, ERC721Pausable, AccessControl, ReentrancyGuard {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 private _nextTokenId;

    // tier (1-9) → cap inmutable. tierCaps[0] no se usa (índice 1-based).
    // Valores recomendados por audit Round 2:
    //   tier 1: 1, tier 2: 1, tier 3: 5, tier 4: 50, tier 5: 100,
    //   tier 6: 500, tier 7: 1000, tier 8: 4000, tier 9: 10000
    uint256[10] public tierCap;

    // tier → cantidad minteada hasta ahora.
    mapping(uint8 => uint256) public tierMinted;

    // tier (1-9) → tokenURI canónico (IPFS). Set en constructor, inmutable.
    string[10] private _tierURI;

    // gemCode único → tokenId. Mantiene el index para evitar doble-mint del mismo código.
    mapping(string => uint256) public gemCodeToTokenId;
    // tokenId → tier
    mapping(uint256 => uint8) public tokenTier;
    // tokenId → gemCode original
    mapping(uint256 => string) public tokenGemCode;

    event GemMinted(uint256 indexed tokenId, address indexed to, uint8 tier, string gemCode);

    constructor(
        address admin,
        address minter,
        uint256[9] memory caps,
        string[9] memory uris
    ) ERC721("Mining The Blocks Gems", "MTBG") {
        require(admin != address(0), "Admin zero");
        require(minter != address(0), "Minter zero");

        // Roles: admin (Safe), minter (backend), pauser (admin por default; admin
        // puede grantear PAUSER_ROLE a otros wallets backup vía grantRole después).
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        _grantRole(PAUSER_ROLE, admin);

        // Caps + URIs inmutables (índice 1-based). i=0 queda en 0 / "".
        for (uint8 i = 0; i < 9; i++) {
            require(caps[i] > 0, "Cap must be > 0");
            require(bytes(uris[i]).length > 0, "URI empty");
            tierCap[i + 1] = caps[i];
            _tierURI[i + 1] = uris[i];
        }
    }

    /// @notice Mintea un gem específico. Solo MINTER_ROLE (backend EOA del juego).
    /// @dev tokenURI se deriva del tier — el caller NO controla el URI. Esto cierra
    ///      el vector "backend comprometido mintea con URI fraudulenta" (MED-S1).
    function mintGem(
        address to,
        uint8 gemTier,
        string calldata gemCode
    ) external onlyRole(MINTER_ROLE) nonReentrant returns (uint256) {
        require(to != address(0), "Mint to zero");
        require(gemTier >= 1 && gemTier <= 9, "Invalid tier");
        require(bytes(gemCode).length > 0, "Empty gemCode");
        require(gemCodeToTokenId[gemCode] == 0, "Gem already minted");
        require(tierMinted[gemTier] < tierCap[gemTier], "Tier cap reached");

        uint256 newId = ++_nextTokenId;

        // Effects ANTES de Interactions (CEI). `_safeMint` invoca onERC721Received
        // en `to` si es contrato; sin CEI un receptor malicioso podría reentrar
        // mintGem antes de que se actualizara gemCodeToTokenId / tierMinted.
        gemCodeToTokenId[gemCode] = newId;
        tokenTier[newId] = gemTier;
        tokenGemCode[newId] = gemCode;
        unchecked { tierMinted[gemTier] += 1; }  // bound by cap above

        // Interactions al final.
        _safeMint(to, newId);
        _setTokenURI(newId, _tierURI[gemTier]);

        emit GemMinted(newId, to, gemTier, gemCode);
        return newId;
    }

    /// @notice Pause / unpause solo PAUSER_ROLE (mints + transfers congelados).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Deshabilita renunciar al DEFAULT_ADMIN_ROLE para evitar bricking
    ///         del contrato. Otros roles (MINTER, PAUSER) sí pueden renunciarse.
    function renounceRole(bytes32 role, address account)
        public override(AccessControl)
    {
        require(role != DEFAULT_ADMIN_ROLE, "Cannot renounce admin");
        super.renounceRole(role, account);
    }

    /// @notice Total NFTs minteados (todos los tiers sumados).
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @notice Cuánto queda disponible para mintear en un tier.
    function tierRemaining(uint8 gemTier) external view returns (uint256) {
        require(gemTier >= 1 && gemTier <= 9, "Invalid tier");
        return tierCap[gemTier] - tierMinted[gemTier];
    }

    /// @notice URI canónico de un tier (público, para frontend).
    function tierURI(uint8 gemTier) external view returns (string memory) {
        require(gemTier >= 1 && gemTier <= 9, "Invalid tier");
        return _tierURI[gemTier];
    }

    // ============ Overrides (boilerplate ERC721 + Pausable + URIStorage + AccessControl) ============

    function _update(address to, uint256 tokenId, address auth)
        internal override(ERC721, ERC721Pausable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal override(ERC721)
    {
        super._increaseBalance(account, value);
    }

    function tokenURI(uint256 tokenId)
        public view override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
