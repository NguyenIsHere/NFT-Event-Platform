// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract EventTicketNFT is ERC721URIStorage, Ownable, ReentrancyGuard {
    /* ───── Event-level data ───── */
    struct EventInfo {
        bool exists;
        string name;
        address organizer; // ✅ Store organizer address
        uint256 totalRevenue; // ✅ Track total revenue for this event
        bool settled; // ✅ Track if event revenue has been settled
    }
    mapping(uint256 => EventInfo) public eventInfo;

    struct TicketTypeInfo {
        uint256 eventId;
        uint256 price;
        uint256 remaining;
        string name;
        bool exists;
    }
    mapping(uint256 => TicketTypeInfo) public ticketTypeInfo;

    struct TicketData {
        uint256 eventId;
        uint256 ticketTypeId;
        uint256 sessionId;
        uint256 price;
    }
    mapping(uint256 => TicketData) public tickets;

    /* ───── FLEXIBLE: Revenue Management ───── */
    uint256 public platformFeePercent = 10; // ✅ FLEXIBLE: Default 10% but can be changed
    uint256 public constant MAX_PLATFORM_FEE = 30; // ✅ Maximum 30% to prevent abuse
    uint256 public totalPlatformFees = 0; // Total platform fees collected
    
    // Track revenue per event
    mapping(uint256 => uint256) public eventRevenue;
    mapping(uint256 => uint256) public eventPlatformFees;
    mapping(uint256 => bool) public eventSettled;

    uint256 public nextTokenId = 1;
    uint256 public nextTicketTypeId = 1;

    /* ───── Events ───── */
    event EventCreated(uint256 indexed eventId, string name, address indexed organizer);
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
    event RevenueSettled(
        uint256 indexed eventId,
        address indexed organizer,
        uint256 organizerAmount,
        uint256 platformFee
    );
    event PlatformFeesWithdrawn(address indexed admin, uint256 amount);
    event PlatformFeeChanged(uint256 oldFee, uint256 newFee); // ✅ NEW: Fee change event

    constructor() ERC721("EventTicketNFT", "ETNFT") Ownable(msg.sender) {}

    /* ───── FLEXIBLE: Set platform fee ───── */
    function setPlatformFeePercent(uint256 newFeePercent) external onlyOwner {
        require(newFeePercent <= MAX_PLATFORM_FEE, "Fee exceeds maximum allowed");
        
        uint256 oldFee = platformFeePercent;
        platformFeePercent = newFeePercent;
        
        emit PlatformFeeChanged(oldFee, newFeePercent);
    }

    /* ───── Create event with organizer ───── */
    function createEvent(
        uint256 eventId, 
        string calldata eventName,
        address organizer
    ) external onlyOwner {
        require(!eventInfo[eventId].exists, "Event exists");
        require(organizer != address(0), "Invalid organizer address");
        
        eventInfo[eventId] = EventInfo({
            exists: true,
            name: eventName,
            organizer: organizer,
            totalRevenue: 0,
            settled: false
        });
        
        emit EventCreated(eventId, eventName, organizer);
    }

    /* ───── Existing: Create ticket type ───── */
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

    /* ───── Existing: Owner mint ───── */
    function mintTicket(
        address to,
        string calldata uri,
        uint256 ticketTypeId,
        uint256 sessionId
    ) external onlyOwner returns (uint256) {
        TicketTypeInfo storage tt = ticketTypeInfo[ticketTypeId];
        require(tt.exists, "TicketType not exists");

        uint256 tokenId = nextTokenId++;
        
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);

        tickets[tokenId] = TicketData({
            eventId: tt.eventId,
            ticketTypeId: ticketTypeId,
            sessionId: sessionId,
            price: tt.price
        });
        
        emit TicketMinted(tokenId, tt.eventId, ticketTypeId, sessionId, to, tt.price);
        return tokenId;
    }

    /* ───── Buy tickets with dynamic revenue tracking ───── */
    function buyTickets(
        string[] calldata uris,
        uint256[] calldata ticketTypeIds,
        uint256[] calldata sessionIds
    ) external payable nonReentrant {
        uint256 n = uris.length;
        require(n == ticketTypeIds.length && n == sessionIds.length, "Array mismatch");
        require(n > 0, "Empty");

        uint256 totalCost;
        uint256 eventId;
        
        // Calculate total cost and validate
        for (uint256 i = 0; i < n; ++i) {
            TicketTypeInfo storage tt = ticketTypeInfo[ticketTypeIds[i]];
            require(tt.exists, "TicketType not exists");
            require(tt.remaining > 0, "Sold out");
            totalCost += tt.price;
            
            if (i == 0) {
                eventId = tt.eventId;
            } else {
                require(tt.eventId == eventId, "All tickets must be from same event");
            }
        }
        
        require(msg.value == totalCost, "Incorrect payment amount");
        require(eventInfo[eventId].exists, "Event not exists");

        // ✅ DYNAMIC: Calculate platform fee using current rate
        uint256 platformFee = (totalCost * platformFeePercent) / 100;
        uint256 organizerRevenue = totalCost - platformFee;

        // ✅ Update revenue tracking
        eventRevenue[eventId] += organizerRevenue;
        eventPlatformFees[eventId] += platformFee;
        totalPlatformFees += platformFee;
        eventInfo[eventId].totalRevenue += organizerRevenue;

        // Mint tickets
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

        // Money stays in contract, will be settled later
    }

    /* ───── Settle event revenue ───── */
    function settleEventRevenue(uint256 eventId) external onlyOwner nonReentrant {
        require(eventInfo[eventId].exists, "Event not exists");
        require(!eventInfo[eventId].settled, "Event already settled");
        require(eventRevenue[eventId] > 0, "No revenue to settle");

        address organizer = eventInfo[eventId].organizer;
        uint256 organizerAmount = eventRevenue[eventId];

        // Mark as settled before transfer to prevent reentrancy
        eventInfo[eventId].settled = true;

        // Transfer to organizer
        (bool success, ) = organizer.call{value: organizerAmount}("");
        require(success, "Transfer to organizer failed");

        emit RevenueSettled(eventId, organizer, organizerAmount, eventPlatformFees[eventId]);
    }

    /* ───── Withdraw platform fees ───── */
    function withdrawPlatformFees(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= totalPlatformFees, "Insufficient platform fees");
        require(amount > 0, "Amount must be greater than 0");

        totalPlatformFees -= amount;

        (bool success, ) = owner().call{value: amount}("");
        require(success, "Platform fee withdrawal failed");

        emit PlatformFeesWithdrawn(owner(), amount);
    }

    /* ───── Emergency withdraw ───── */
    function emergencyWithdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No funds to withdraw");

        (bool success, ) = owner().call{value: balance}("");
        require(success, "Emergency withdrawal failed");
    }

    /* ───── View functions ───── */
    function getEventRevenue(uint256 eventId) external view returns (
        uint256 organizerRevenue,
        uint256 platformFees,
        bool settled,
        address organizer
    ) {
        EventInfo storage eventData = eventInfo[eventId];
        return (
            eventRevenue[eventId],
            eventPlatformFees[eventId],
            eventData.settled,
            eventData.organizer
        );
    }

    function getPlatformFeePercent() external view returns (uint256) {
        return platformFeePercent;
    }

    function getTotalPlatformFees() external view returns (uint256) {
        return totalPlatformFees;
    }

    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /* ───── Existing functions unchanged ───── */
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "ERC721: URI query for nonexistent token");
        return super.tokenURI(tokenId);
    }

    function getTicketTypesByEvent(uint256 eventId) external view returns (uint256[] memory) {
        uint256[] memory result = new uint256[](nextTicketTypeId - 1);
        uint256 count = 0;
        
        for (uint256 i = 1; i < nextTicketTypeId; i++) {
            if (ticketTypeInfo[i].eventId == eventId && ticketTypeInfo[i].exists) {
                result[count] = i;
                count++;
            }
        }
        
        uint256[] memory finalResult = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            finalResult[i] = result[i];
        }
        
        return finalResult;
    }
}