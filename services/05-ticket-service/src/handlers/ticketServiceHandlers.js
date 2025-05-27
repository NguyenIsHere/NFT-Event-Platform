// 05-ticket-service/src/handlers/ticketServiceHandlers.js (KHUNG SƯỜN CHI TIẾT HƠN)
const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket')
const grpc = require('@grpc/grpc-js')
const ipfsServiceClient = require('../clients/ipfsServiceClient')
const blockchainServiceClient = require('../clients/blockchainServiceClient')
const eventServiceClient = require('../clients/eventServiceClient') // Import eventServiceClient
const mongoose = require('mongoose')

function ticketToProto (ticketDoc) {
  /* ... (như đã cung cấp ở Canvas ticket_service_files_v1) ... */
  if (!ticketDoc) return null
  const ticketData = ticketDoc.toJSON ? ticketDoc.toJSON() : { ...ticketDoc } // Handle plain objects if already transformed

  // Ensure all fields expected by proto are present, with defaults for missing optional fields
  return {
    id: ticketData.id || ticketDoc._id?.toString(),
    event_id: ticketData.eventId || '',
    ticket_type_id: ticketData.ticketTypeId || '',
    token_id: ticketData.tokenId || '', // Đã là string từ model
    owner_address: ticketData.ownerAddress || '',
    session_id: ticketData.sessionId || '',
    status: ticketData.status || '',
    token_uri_cid: ticketData.tokenUriCid || '',
    transaction_hash: ticketData.transactionHash || '',
    created_at: ticketDoc.createdAt
      ? Math.floor(new Date(ticketDoc.createdAt).getTime() / 1000)
      : 0
  }
}

async function PreparePurchaseTicket (call, callback) {
  const { ticket_type_id, session_id, buyer_address } = call.request
  console.log(
    `TicketService: PreparePurchaseTicket for ticket_type_id: ${ticket_type_id}, session: ${session_id}, buyer: ${buyer_address}`
  )
  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }
    const ticketType = await TicketType.findById(ticket_type_id).lean() // Use .lean() for plain JS object
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }
    if (ticketType.availableQuantity <= 0) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'This ticket type is sold out.'
      })
    }

    // Lấy thông tin Event để có thể dùng trong metadata
    const eventDetailsResponse = await new Promise((resolve, reject) => {
      eventServiceClient.GetEvent(
        { event_id: ticketType.eventId },
        { deadline: new Date(Date.now() + 5000) },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })
    if (!eventDetailsResponse || !eventDetailsResponse.event) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Associated event not found.'
      })
    }
    const eventDetails = eventDetailsResponse.event

    const nftMetadata = {
      name: `Ticket: ${ticketType.name} - Event: ${eventDetails.name}`,
      description: `Ticket for event ${eventDetails.name}. Type: ${
        ticketType.name
      }. Session: ${session_id || 'Default'}.`,
      image: eventDetails.banner_url_cid
        ? `ipfs://${eventDetails.banner_url_cid}`
        : 'ipfs://YOUR_DEFAULT_TICKET_IMAGE_CID_HERE', // Nên có ảnh vé chung hoặc ảnh sự kiện
      external_url: `https://yourapp.com/events/${ticketType.eventId}/tickets/TBD`, // URL đến trang chi tiết vé (nếu có)
      attributes: [
        { trait_type: 'Event Name', value: eventDetails.name },
        { trait_type: 'Ticket Type', value: ticketType.name },
        {
          trait_type: 'Event Blockchain ID',
          value: ticketType.blockchainEventId.toString()
        },
        { trait_type: 'Session', value: session_id || 'Default' },
        { trait_type: 'Price (WEI)', value: ticketType.priceWei }
      ]
    }
    const jsonContent = JSON.stringify(nftMetadata)

    console.log(
      `TicketService: Uploading NFT metadata to IPFS for ticket type ${ticket_type_id}`
    )
    const ipfsResponse = await new Promise((resolve, reject) => {
      ipfsServiceClient.PinJSONToIPFS(
        {
          json_content: jsonContent,
          options: {
            pin_name: `ticket_meta_event_${
              ticketType.eventId
            }_tt_${ticket_type_id}_${Date.now()}`
          }
        },
        { deadline: new Date(Date.now() + 10000) }, // Timeout 10s
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })
    const tokenUriCid = ipfsResponse.ipfs_hash
    console.log(
      `TicketService: NFT metadata pinned to IPFS. CID: ${tokenUriCid}`
    )

    console.log(
      `TicketService: Getting payment details from BlockchainService for event_id: ${ticketType.blockchainEventId}`
    )
    const paymentDetails = await new Promise((resolve, reject) => {
      blockchainServiceClient.GetTicketPaymentDetails(
        {
          blockchain_event_id: ticketType.blockchainEventId.toString(),
          price_wei_from_ticket_type: ticketType.priceWei
        },
        { deadline: new Date(Date.now() + 5000) },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })

    callback(null, {
      payment_contract_address: paymentDetails.payment_contract_address,
      price_wei: paymentDetails.price_to_pay_wei,
      blockchain_event_id: ticketType.blockchainEventId.toString(),
      session_id_for_contract: session_id || '0', // Contract dùng uint256, 0 nếu không có session
      token_uri_cid: tokenUriCid
    })
  } catch (error) {
    console.error(
      'TicketService: PreparePurchaseTicket RPC error:',
      error.details || error.message || error
    )
    let grpcErrorCode = grpc.status.INTERNAL
    if (error.code && Object.values(grpc.status).includes(error.code)) {
      // Nếu lỗi đã là gRPC error từ service khác
      grpcErrorCode = error.code
    }
    callback({
      code: grpcErrorCode,
      message:
        error.details || error.message || 'Failed to prepare ticket purchase.'
    })
  }
}

async function ConfirmPurchaseAndMintTicket (call, callback) {
  const { transaction_hash, ticket_type_id, session_id, owner_address } =
    call.request
  // **LƯU Ý QUAN TRỌNG VỀ LUỒNG NÀY:**
  // Nếu người dùng tự gọi hàm `buyTickets()` trên contract, thì NFT đã được mint.
  // Service này chỉ cần:
  // 1. Xác minh `transaction_hash` (gọi `blockchain-service`).
  // 2. Nếu thành công, lấy `tokenId` từ event `TicketMinted` (cũng nên do `blockchain-service` cung cấp qua `VerifyTransaction` hoặc RPC riêng).
  // 3. Lưu vé vào DB, giảm `availableQuantity`.
  //
  // Nếu backend đứng ra mint HỘ người dùng (ví dụ sau khi nhận thanh toán off-chain),
  // thì service này sẽ gọi `blockchain-service.MintTicket()` với `token_uri_cid` (từ bước Prepare hoặc tạo lại)
  // và các thông tin cần thiết.
  //
  // Proto `ConfirmPurchaseAndMintTicketRequest` hiện tại không có `token_uri_cid` và `blockchain_event_id`.
  // Tôi sẽ giả định luồng là người dùng đã tự mint bằng cách gọi `buyTickets` của contract,
  // và chúng ta cần xác minh rồi lưu lại.

  console.log(
    `TicketService: ConfirmPurchaseAndMintTicket for tx_hash: ${transaction_hash}, owner: ${owner_address}, ticket_type: ${ticket_type_id}`
  )
  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }
    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found for confirmation.'
      })
    }
    // Không giảm availableQuantity ở đây vội, chỉ giảm khi đã chắc chắn tx thành công và lấy được tokenId

    console.log(
      `TicketService: Verifying transaction ${transaction_hash} via BlockchainService.`
    )
    const verifyResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.VerifyTransaction(
        { transaction_hash },
        { deadline: new Date(Date.now() + 15000) },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })

    if (
      !verifyResponse ||
      !verifyResponse.is_confirmed ||
      !verifyResponse.success_on_chain
    ) {
      console.error(
        'TicketService: Transaction verification failed or transaction not successful on chain:',
        verifyResponse
      )
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Transaction ${transaction_hash} not confirmed or failed on chain. Status: ${verifyResponse?.success_on_chain}, Confirmed: ${verifyResponse?.is_confirmed}`
      })
    }
    console.log(
      `TicketService: Transaction ${transaction_hash} verified successfully. From: ${verifyResponse.from_address}, To: ${verifyResponse.to_address}, Value: ${verifyResponse.value_wei}`
    )

    // TODO: Lấy tokenId từ event `TicketMinted` của contract thông qua transaction_hash.
    // Đây là phần quan trọng và cần có cơ chế đáng tin cậy.
    // BlockchainService nên có một RPC như `GetTokenIdFromTransaction(transaction_hash)`
    // Hoặc `VerifyTransactionResponse` nên bao gồm các event logs đã được parse.
    // Tạm thời, chúng ta sẽ tạo vé với tokenId giả định hoặc để trống, đánh dấu là PENDING_MINT.
    // Sau đó cần một worker để cập nhật tokenId này.
    // Trong ví dụ của contract bạn, `buyTickets` sẽ emit `TicketMinted(tokenId, eventId, sessionId, owner, price)`
    // Bạn cần một cách để blockchain-service đọc event này từ receipt và trả về tokenId.
    // HoT LÀ NẾU blockchainService.MintTicket được dùng, thì nó sẽ trả về tokenId.
    // Hiện tại proto `VerifyTransactionResponse` chưa có tokenId.

    // Giả sử chúng ta cần tokenUriCid (đã tạo ở bước Prepare) để lưu vào Ticket.
    // Client có thể cần gửi lại hoặc service tự cache/query.
    // Để đơn giản, ta sẽ tạo vé với status PENDING và chờ update tokenId & tokenUriCid.

    // Kiểm tra xem vé với transaction_hash này đã được xử lý chưa (để tránh xử lý lại)
    const existingTicketByTx = await Ticket.findOne({
      transactionHash: transaction_hash
    })
    if (existingTicketByTx) {
      console.warn(
        `TicketService: Transaction hash ${transaction_hash} already processed for ticket ${existingTicketByTx.id}`
      )
      return callback(null, { ticket: ticketToProto(existingTicketByTx) })
    }

    const newTicket = new Ticket({
      eventId: ticketType.eventId,
      ticketTypeId: ticket_type_id,
      // tokenId: "PENDING_FROM_EVENT_LISTENER", // Sẽ được cập nhật bởi một tiến trình khác
      ownerAddress: owner_address.toLowerCase(),
      sessionId: session_id,
      status: TICKET_STATUS_ENUM[3], // PENDING_MINT
      // tokenUriCid: "UNKNOWN_YET_NEEDS_TO_BE_FETCHED_OR_PASSED_AGAIN", // Quan trọng: Cần CID này
      transactionHash: transaction_hash
    })
    const savedTicket = await newTicket.save()

    // Giảm số lượng vé chỉ khi thực sự tạo vé thành công (dù tokenId có thể pending)
    // Cân nhắc đặt logic này sau khi đã chắc chắn có tokenId để tránh bán lố
    if (ticketType.availableQuantity > 0) {
      ticketType.availableQuantity -= 1
      await ticketType.save()
    } else {
      console.warn(
        `TicketService: TicketType ${ticket_type_id} available quantity was already 0 or less when trying to decrement.`
      )
      // Có thể cần xử lý thêm ở đây, ví dụ rollback việc tạo vé nếu không còn availableQuantity.
    }

    console.log(
      `TicketService: Ticket ${savedTicket.id} created in DB for owner ${owner_address}. Status: ${savedTicket.status}. Waiting for tokenId and tokenUri update.`
    )

    callback(null, { ticket: ticketToProto(savedTicket) })
  } catch (error) {
    console.error(
      'TicketService: ConfirmPurchaseAndMintTicket RPC error:',
      error.details || error.message || error
    )
    let grpcErrorCode = grpc.status.INTERNAL
    if (error.code && Object.values(grpc.status).includes(error.code)) {
      grpcErrorCode = error.code
    }
    callback({
      code: grpcErrorCode,
      message: error.details || error.message || 'Failed to confirm purchase.'
    })
  }
}

// ... (Handlers cho GetTicket, ListTicketsByEvent, ListTicketsByOwner) ...
module.exports = {
  PreparePurchaseTicket,
  ConfirmPurchaseAndMintTicket,
  GetTicket /* ... */
}
