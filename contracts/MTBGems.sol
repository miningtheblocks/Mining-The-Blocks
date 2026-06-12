// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MTBGems is ERC721, ERC721URIStorage, Ownable {
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
    ) external onlyOwner returns (uint256) {
        require(gemTier >= 1 && gemTier <= 9, "Invalid tier");
        require(bytes(gemCode).length > 0, "Empty gemCode");
        require(gemCodeToTokenId[gemCode] == 0, "Gem already minted");

        uint256 newId = ++_nextTokenId;

        _safeMint(to, newId);
        _setTokenURI(newId, tokenURI_);

        gemCodeToTokenId[gemCode] = newId;
        tokenTier[newId] = gemTier;
        tokenGemCode[newId] = gemCode;

        emit GemMinted(newId, to, gemTier, gemCode);
        return newId;
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
