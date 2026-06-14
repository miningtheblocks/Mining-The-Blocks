// SPDX-License-Identifier: MIT
// CRIT-26: aplicamos Checks-Effects-Interactions y nonReentrant en mintGem.
// El contrato deployado en mainnet sigue siendo el viejo — este fix entra al
// próximo redespliegue. Hasta entonces el riesgo real es bajo (`onlyOwner`
// limita la superficie al backend), pero la corrección queda lista.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MTBGems is ERC721, ERC721URIStorage, ERC721Pausable, Ownable, ReentrancyGuard {
    uint256 private _nextTokenId;

    mapping(string => uint256) public gemCodeToTokenId;
    mapping(uint256 => uint8)  public tokenTier;
    mapping(uint256 => string) public tokenGemCode;

    event GemMinted(uint256 indexed tokenId, address indexed to, uint8 tier, string gemCode);

    constructor(address initialOwner)
        ERC721("Mining The Blocks Gems", "MTBG")
        Ownable(initialOwner)
    {}

    function mintGem(
        address to,
        uint8 gemTier,
        string calldata gemCode,
        string calldata tokenURI_
    ) external onlyOwner nonReentrant returns (uint256) {
        require(to != address(0), "Mint to zero");
        require(gemTier >= 1 && gemTier <= 9, "Invalid tier");
        require(bytes(gemCode).length > 0, "Empty gemCode");
        require(gemCodeToTokenId[gemCode] == 0, "Gem already minted");

        uint256 newId = ++_nextTokenId;

        // CRIT-26: Effects ANTES de Interactions. `_safeMint` invoca
        // `onERC721Received` en `to` si es contrato; sin CEI un receptor
        // malicioso podía reentrar mintGem antes de que se grabara
        // gemCodeToTokenId y duplicar el mismo gemCode.
        gemCodeToTokenId[gemCode] = newId;
        tokenTier[newId] = gemTier;
        tokenGemCode[newId] = gemCode;

        // Interactions al final.
        _safeMint(to, newId);
        _setTokenURI(newId, tokenURI_);

        emit GemMinted(newId, to, gemTier, gemCode);
        return newId;
    }

    // CRIT-25 defensa: deshabilitar renounceOwnership para evitar bricking.
    // El owner real debe migrarse a Gnosis Safe + AccessControl en el próximo
    // redespliegue (riesgo bajo hoy porque el backend custodia la clave).
    function renounceOwnership() public view override onlyOwner {
        revert("renounceOwnership disabled");
    }

    // ALTO-80: Pause/unpause para frenar mints en caso de exploit detectado
    // sin abandonar el contrato. Solo owner.
    function pause() external onlyOwner {
        _pause();
    }
    function unpause() external onlyOwner {
        _unpause();
    }

    // Hook obligatorio cuando se mezclan ERC721 + ERC721Pausable + ERC721URIStorage.
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

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    function tokenURI(uint256 tokenId)
        public view override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
