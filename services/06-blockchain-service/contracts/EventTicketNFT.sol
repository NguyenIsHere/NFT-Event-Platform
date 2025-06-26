// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract EventTicketNFT is ERC721URIStorage, Ownable {
    /* ───── Event-level data ───── */
    struct EventInfo {
        bool exists;
        string name;
    }
    mapping(uint256 => EventInfo) public eventInfo;

    /* ───── TicketType-level data ───── */
    struct TicketTypeInfo {
        uint256 eventId;
        uint256 price;
        uint256 remaining;
        string name;
        bool exists;
    }
    mapping(uint256 => TicketTypeInfo) public ticketTypeInfo; // ticketTypeId => info

    /* ───── Ticket-level data ───── */
    struct TicketData {
        uint256 eventId;
        uint256 ticketTypeId;
        uint256 sessionId;
        uint256 price;
    }
    mapping(uint256 => TicketData) public tickets;

    uint256 public nextTokenId = 1;
    uint256 public nextTicketTypeId = 1;

    /* ───── Events ───── */
    event EventCreated(uint256 indexed eventId, string name);
    event TicketTypeCreated(
        uint256 indexed ticketTypeId,
        uint256 indexed eventId,
        string name,
        uint256 price,
        uint256 totalSupply
    );
    event TicketMinted(
        uint256 indexed tokenId,
        uint256 indexed eventId,
        uint256 indexed ticketTypeId,
        uint256 sessionId,
        address owner,
        uint256 price
    );

    constructor() ERC721("EventTicketNFT", "ETNFT") Ownable(msg.sender) {}

    /* ───── Owner: create event ───── */
    function createEvent(uint256 eventId, string calldata eventName) external onlyOwner {
        require(!eventInfo[eventId].exists, "Event exists");
        eventInfo[eventId] = EventInfo({
            exists: true,
            name: eventName
        });
        emit EventCreated(eventId, eventName);
    }

    /* ───── Owner: create ticket type ───── */
    function createTicketType(
        uint256 eventId,
        string calldata typeName,
        uint256 priceWei,
        uint256 totalSupply
    ) external onlyOwner returns (uint256 ticketTypeId) {
        require(eventInfo[eventId].exists, "Event not exists");
        
        ticketTypeId = nextTicketTypeId++;
        ticketTypeInfo[ticketTypeId] = TicketTypeInfo({
            eventId: eventId,
            price: priceWei,
            remaining: totalSupply,
            name: typeName,
            exists: true
        });
        
        emit TicketTypeCreated(ticketTypeId, eventId, typeName, priceWei, totalSupply);
        return ticketTypeId;
    }

    /* ───── Public: buy tickets ───── */
    function buyTickets(
        string[] calldata uris,
        uint256[] calldata ticketTypeIds, // ✅ Changed from eventIds to ticketTypeIds
        uint256[] calldata sessionIds
    ) external payable {
        uint256 n = uris.length;
        require(n == ticketTypeIds.length && n == sessionIds.length, "Array mismatch");
        require(n > 0, "Empty");

        uint256 cost;
        for (uint256 i = 0; i < n; ++i) {
            TicketTypeInfo storage tt = ticketTypeInfo[ticketTypeIds[i]];
            require(tt.exists, "TicketType not exists");
            require(tt.remaining > 0, "Sold out");
            cost += tt.price;
        }
        require(msg.value == cost, "Bad ETH");

        for (uint256 i = 0; i < n; ++i) {
            TicketTypeInfo storage tt = ticketTypeInfo[ticketTypeIds[i]];
            tt.remaining--;

            uint256 tokenId = nextTokenId++;
            _safeMint(msg.sender, tokenId);
            _setTokenURI(tokenId, uris[i]);

            tickets[tokenId] = TicketData({
                eventId: tt.eventId,
                ticketTypeId: ticketTypeIds[i],
                sessionId: sessionIds[i],
                price: tt.price
            });
            
            emit TicketMinted(tokenId, tt.eventId, ticketTypeIds[i], sessionIds[i], msg.sender, tt.price);
        }

        payable(owner()).transfer(msg.value);
    }

    /* ───── Owner: batch-mint tickets ───── */
    function batchMint(
        address to,
        string[] calldata uris,
        uint256[] calldata ticketTypeIds,
        uint256[] calldata sessionIds
    ) external onlyOwner {
        uint256 n = uris.length;
        require(n == ticketTypeIds.length && n == sessionIds.length, "Array mismatch");

        for (uint256 i = 0; i < n; ++i) {
            TicketTypeInfo storage tt = ticketTypeInfo[ticketTypeIds[i]];
            require(tt.exists, "TicketType not exists");

            uint256 tokenId = nextTokenId++;
            _safeMint(to, tokenId);
            _setTokenURI(tokenId, uris[i]);

            tickets[tokenId] = TicketData({
                eventId: tt.eventId,
                ticketTypeId: ticketTypeIds[i],
                sessionId: sessionIds[i],
                price: tt.price
            });
            
            emit TicketMinted(tokenId, tt.eventId, ticketTypeIds[i], sessionIds[i], to, tt.price);
        }
    }

    /* ───── Views ───── */
    function getTicketTypesByEvent(uint256 eventId) external view returns (uint256[] memory) {
        uint256[] memory result = new uint256[](nextTicketTypeId - 1);
        uint256 count = 0;
        
        for (uint256 i = 1; i < nextTicketTypeId; i++) {
            if (ticketTypeInfo[i].eventId == eventId && ticketTypeInfo[i].exists) {
                result[count] = i;
                count++;
            }
        }
        
        // Resize array
        uint256[] memory finalResult = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            finalResult[i] = result[i];
        }
        
        return finalResult;
    }
}