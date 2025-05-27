// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract EventTicketNFT is ERC721URIStorage, Ownable {
    /* ───── Event-level data ───── */
    struct EventInfo {
        uint256 price;
        uint256 remaining;
    }
    /// eventId → info
    mapping(uint256 => EventInfo) public eventInfo;

    /* ───── Ticket-level data ───── */
    struct TicketData {
        uint256 eventId;
        uint256 sessionId;
        uint256 price;
    }
    /// tokenId → data
    mapping(uint256 => TicketData) public tickets;

    uint256 public nextTokenId = 1;

    /* ───── Log events ───── */
    event EventCreated(uint256 indexed eventId, uint256 price, uint256 totalSupply);
    event TicketMinted(
        uint256 indexed tokenId,
        uint256 indexed eventId,
        uint256 indexed sessionId,
        address owner,
        uint256 price
    );

    /* ───── Constructor ───── */
    constructor() ERC721("EventTicketNFT", "ETNFT") Ownable(msg.sender) {
        // owner = deployer
    }

    /* ───── Owner: create event ───── */
    function createEvent(uint256 eventId, uint256 priceWei, uint256 totalSupply) external onlyOwner {
        require(eventInfo[eventId].remaining == 0, "Event exists");
        eventInfo[eventId] = EventInfo({ price: priceWei, remaining: totalSupply });
        emit EventCreated(eventId, priceWei, totalSupply);
    }

    /* ───── Owner: batch-mint tickets ───── */
    function batchMint(
        address to,
        string[] calldata uris,
        uint256[] calldata eventIds,
        uint256[] calldata sessionIds,
        uint256[] calldata prices
    ) external onlyOwner {
        uint256 n = uris.length;
        require(n == eventIds.length && n == sessionIds.length && n == prices.length, "Array mismatch");

        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = nextTokenId++;
            _safeMint(to, tokenId);
            _setTokenURI(tokenId, uris[i]);

            tickets[tokenId] = TicketData({
                eventId:   eventIds[i],
                sessionId: sessionIds[i],
                price:     prices[i]
            });
            emit TicketMinted(tokenId, eventIds[i], sessionIds[i], to, prices[i]);
        }
    }

    /* ───── Public: buy tickets ───── */
    function buyTickets(
        string[] calldata uris,
        uint256[] calldata eventIds,
        uint256[] calldata sessionIds
    ) external payable {
        uint256 n = uris.length;
        require(n == eventIds.length && n == sessionIds.length, "Array mismatch");
        require(n > 0, "Empty");

        uint256 cost;
        for (uint256 i = 0; i < n; ++i) {
            EventInfo storage e = eventInfo[eventIds[i]];
            require(e.remaining > 0, "Sold out");
            cost += e.price;
        }
        require(msg.value == cost, "Bad ETH");

        for (uint256 i = 0; i < n; ++i) {
            EventInfo storage e = eventInfo[eventIds[i]];
            e.remaining--;

            uint256 tokenId = nextTokenId++;
            _safeMint(msg.sender, tokenId);
            _setTokenURI(tokenId, uris[i]);

            tickets[tokenId] = TicketData({
                eventId:   eventIds[i],
                sessionId: sessionIds[i],
                price:     e.price
            });
            emit TicketMinted(tokenId, eventIds[i], sessionIds[i], msg.sender, e.price);
        }

        payable(owner()).transfer(msg.value);
    }

    /* ───── Public: transfer helper ───── */
    function transferTicket(address to, uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        _transfer(msg.sender, to, tokenId);
    }
}
