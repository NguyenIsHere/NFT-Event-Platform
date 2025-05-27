// src/handlers/ticketServiceHandlers.js (trong 05-ticket-service)
const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
const ipfsServiceClient = require('../clients/ipfsServiceClient')
const blockchainServiceClient = require('../clients/blockchainServiceClient')
const eventServiceClient = require('../clients/eventServiceClient')

// Helper function ticketDocumentToGrpcTicket (giữ nguyên như trước)
function ticketDocumentToGrpcTicket (ticketDoc) {
  if (!ticketDoc) return null
  const ticketJson = ticketDoc.toJSON ? ticketDoc.toJSON() : ticketDoc
  return {
    id: ticketJson.id,
    event_id: ticketJson.eventId || '',
    ticket_type_id: ticketJson.ticketTypeId || '',
    token_id: ticketJson.tokenId || '',
    owner_address: ticketJson.ownerAddress || '',
    session_id: ticketJson.sessionId || '',
    status: ticketJson.status || '',
    token_uri_cid: ticketJson.tokenUriCid || '', // CID (hash) của metadata
    transaction_hash: ticketJson.transactionHash || '',
    created_at: ticketDoc.createdAt
      ? Math.floor(new Date(ticketDoc.createdAt).getTime() / 1000)
      : 0
  }
}

async function InitiatePurchase (call, callback) {
  const { ticket_type_id, buyer_address } = call.request
  console.log(
    `TicketService: InitiatePurchase for ticket_type_id: ${ticket_type_id}, buyer: ${buyer_address}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }
    const ticketType = await TicketType.findById(ticket_type_id).lean()
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
    if (!ticketType.blockchainEventId) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message:
          'TicketType is not associated with a published blockchain event yet.'
      })
    }
    if (!buyer_address) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Buyer address is required.'
      })
    }

    // Lấy thông tin Event để làm phong phú metadata
    let eventName = 'Unknown Event'
    let eventBannerCid = 'YOUR_DEFAULT_TICKET_IMAGE_CID' // Nên có ảnh mặc định
    const eventDetailsResponse = await new Promise((resolve, reject) => {
      // Lấy thông tin Event
      eventServiceClient.GetEvent(
        { event_id: ticketType.eventId },
        { deadline: new Date(Date.now() + 5000) },
        (err, res) => {
          if (err) return reject(err)
          resolve(res)
        }
      )
    })
    if (eventDetailsResponse && eventDetailsResponse.event) {
      eventName = eventDetailsResponse.event.name
      if (eventDetailsResponse.event.banner_url_cid)
        eventBannerCid = eventDetailsResponse.event.banner_url_cid
    } else {
      console.warn(
        `TicketService: Could not fetch event details for eventId ${ticketType.eventId} during InitiatePurchase.`
      )
      // Có thể quyết định trả lỗi ở đây nếu thông tin event là bắt buộc cho metadata
    }

    // Tạo nội dung metadata cho NFT Ticket
    const nftMetadataContent = {
      name: `Ticket: ${ticketType.name} - Event: ${eventName}`,
      description: `Ticket for event "${eventName}". Type: ${
        ticketType.name
      }. Session ID (on chain): ${ticketType.sessionId || 'N/A'}.`,
      image: `ipfs://${eventBannerCid}`,
      external_url: `https://yourplatform.com/events/${ticketType.eventId}`,
      attributes: [
        { trait_type: 'Event Name', value: eventName },
        { trait_type: 'Ticket Type', value: ticketType.name },
        {
          trait_type: 'Event Blockchain ID',
          value: ticketType.blockchainEventId.toString()
        },
        {
          trait_type: 'Session On Chain',
          value: ticketType.sessionId || 'N/A'
        },
        { trait_type: 'Price (WEI)', value: ticketType.priceWei }
      ]
    }
    const jsonContentString = JSON.stringify(nftMetadataContent)

    // Upload metadata JSON lên IPFS
    console.log(
      `TicketService: Uploading NFT metadata to IPFS for ticket type ${ticket_type_id}`
    )
    const ipfsResponse = await new Promise((resolve, reject) => {
      ipfsServiceClient.PinJSONToIPFS(
        {
          json_content: jsonContentString,
          options: {
            pin_name: `ticket_meta_event_${
              ticketType.eventId
            }_tt_${ticket_type_id}_${Date.now()}`
          }
        },
        { deadline: new Date(Date.now() + 10000) },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })
    const tokenUriCidOnly = ipfsResponse.ipfs_hash // Chỉ CID (hash)
    console.log(
      `TicketService: NFT metadata pinned to IPFS. CID: ${tokenUriCidOnly}`
    )

    // Tạo bản ghi Ticket trong DB với trạng thái PENDING_PAYMENT
    const newTicketOrder = new Ticket({
      eventId: ticketType.eventId,
      ticketTypeId: ticket_type_id,
      ownerAddress: buyer_address.toLowerCase(), // Lưu địa chỉ người mua tiềm năng
      sessionId: ticketType.sessionId,
      status: TICKET_STATUS_ENUM[0], // PENDING_PAYMENT (Giả sử enum PENDING_PAYMENT là index 0)
      tokenUriCid: tokenUriCidOnly // Lưu CID của metadata (không có ipfs://)
      // transactionHash và tokenId sẽ được cập nhật sau
    })
    const savedTicketOrder = await newTicketOrder.save()
    console.log(
      `TicketService: Ticket order ${savedTicketOrder.id} created with status PENDING_PAYMENT.`
    )

    // Lấy thông tin thanh toán từ blockchain-service (địa chỉ contract và giá)
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
      ticket_order_id: savedTicketOrder.id.toString(),
      payment_contract_address: paymentDetails.payment_contract_address,
      price_to_pay_wei: paymentDetails.price_to_pay_wei,
      blockchain_event_id: ticketType.blockchainEventId.toString(),
      session_id_for_contract: ticketType.sessionId || '0'
      // Không trả token_uri_cid cho client nữa, vì backend sẽ dùng nó để mint
    })
  } catch (error) {
    console.error(
      'TicketService: InitiatePurchase RPC error:',
      error.details || error.message || error
    )
    // ... (Xử lý lỗi)
    callback({
      code: grpc.status.INTERNAL,
      message:
        error.details || error.message || 'Failed to initiate ticket purchase.'
    })
  }
}

async function ConfirmPaymentAndRequestMint (call, callback) {
  const { ticket_order_id, payment_transaction_hash } = call.request
  console.log(
    `TicketService: ConfirmPaymentAndRequestMint for ticket_order_id: ${ticket_order_id}, payment_tx: ${payment_transaction_hash}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_order_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_order_id format.'
      })
    }
    const ticketOrder = await Ticket.findById(ticket_order_id)
    if (!ticketOrder) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket order not found.'
      })
    }
    if (ticketOrder.status !== TICKET_STATUS_ENUM[0]) {
      // PENDING_PAYMENT
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Ticket order is not awaiting payment. Current status: ${ticketOrder.status}`
      })
    }
    if (!ticketOrder.tokenUriCid) {
      return callback({
        code: grpc.status.INTERNAL,
        message:
          'Ticket order is missing tokenUriCid, cannot proceed with minting.'
      })
    }

    // 1. (Tùy chọn) Xác minh payment_transaction_hash (nếu là thanh toán off-chain hoặc on-chain vào ví Owner)
    //    Nếu thanh toán on-chain vào contract EventTicketNFT (qua hàm buyTickets) thì logic sẽ khác.
    //    Hiện tại, chúng ta giả định thanh toán đã được xác nhận bằng cách nào đó (ví dụ, admin duyệt)
    //    và client gọi endpoint này để kích hoạt mint.
    //    Nếu có `payment_transaction_hash`, bạn có thể gọi blockchainServiceClient.VerifyTransaction(payment_transaction_hash)
    console.log(
      `TicketService: Payment for order ${ticket_order_id} assumed confirmed (tx: ${payment_transaction_hash}). Proceeding to mint.`
    )
    ticketOrder.status = TICKET_STATUS_ENUM[1] // PAID (hoặc MINTING)
    // ticketOrder.transactionHash = payment_transaction_hash; // Nếu tx này là tx mint thì sẽ cập nhật sau
    await ticketOrder.save()

    // 2. Lấy thông tin TicketType để biết blockchain_event_id và session_id
    const ticketType = await TicketType.findById(
      ticketOrder.ticketTypeId
    ).lean()
    if (!ticketType) {
      throw new Error(
        `TicketType ${ticketOrder.ticketTypeId} not found for ticket order ${ticketOrder.id}`
      )
    }

    // 3. Gọi BlockchainService để mint vé
    const fullTokenUriForContract = `ipfs://${ticketOrder.tokenUriCid}`
    console.log(
      `TicketService: Requesting mint from BlockchainService for order ${ticketOrder.id}, buyer: ${ticketOrder.ownerAddress}, URI: ${fullTokenUriForContract}`
    )

    const mintResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.MintTicket(
        {
          buyer_address: ticketOrder.ownerAddress,
          token_uri_cid: fullTokenUriForContract, // URI đầy đủ
          blockchain_event_id: ticketType.blockchainEventId.toString(),
          session_id_for_contract: ticketType.sessionId || '0'
        },
        { deadline: new Date(Date.now() + 60000) }, // Timeout dài cho minting
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })

    if (!mintResponse || !mintResponse.success) {
      ticketOrder.status = TICKET_STATUS_ENUM[5] // FAILED_MINT
      await ticketOrder.save()
      console.error(
        'TicketService: MintTicket call to BlockchainService failed:',
        mintResponse
      )
      throw new Error(
        mintResponse.message || 'Failed to mint NFT via BlockchainService.'
      )
    }

    // 4. Cập nhật thông tin vé trong DB với kết quả từ mint
    ticketOrder.tokenId = mintResponse.token_id
    ticketOrder.transactionHash = mintResponse.transaction_hash // Hash của giao dịch MINT
    ticketOrder.status = TICKET_STATUS_ENUM[4] // MINTED
    // ownerAddress đã được set khi InitiatePurchase, và mintResponse.owner_address nên khớp
    if (
      ticketOrder.ownerAddress.toLowerCase() !==
      mintResponse.owner_address.toLowerCase()
    ) {
      console.warn(
        `TicketService: Minted owner ${mintResponse.owner_address} differs from expected buyer ${ticketOrder.ownerAddress} for order ${ticketOrder.id}. Updating to actual minted owner.`
      )
      ticketOrder.ownerAddress = mintResponse.owner_address.toLowerCase()
    }
    const savedTicket = await ticketOrder.save()
    console.log(
      `TicketService: Ticket ${savedTicket.id} MINTED successfully. TokenId: ${savedTicket.tokenId}, TxHash: ${savedTicket.transactionHash}`
    )

    // 5. Giảm số lượng vé còn lại của TicketType
    // (Đã giảm ở Prepare, hoặc cần cơ chế lock/release nếu Prepare không trừ ngay)
    // Nếu bạn chưa trừ ở Prepare, thì trừ ở đây:
    if (ticketType.availableQuantity > 0) {
      // Double check
      await TicketType.findByIdAndUpdate(ticketOrder.ticketTypeId, {
        $inc: { availableQuantity: -1 }
      })
      console.log(
        `TicketService: Decremented available quantity for TicketType ${ticketOrder.ticketTypeId}`
      )
    } else {
      console.warn(
        `TicketService: TicketType ${ticketOrder.ticketTypeId} available quantity was already 0 or less when mint confirmed.`
      )
    }

    callback(null, { ticket: ticketDocumentToGrpcTicket(savedTicket) })
  } catch (error) {
    console.error(
      'TicketService: ConfirmPaymentAndRequestMint RPC error:',
      error.details || error.message || error
    )
    if (ticket_order_id && mongoose.Types.ObjectId.isValid(ticket_order_id)) {
      try {
        // Cố gắng cập nhật trạng thái vé về FAILED_MINT nếu có lỗi
        await Ticket.findByIdAndUpdate(ticket_order_id, {
          status: TICKET_STATUS_ENUM[5] /* FAILED_MINT */
        })
      } catch (statusUpdateError) {
        console.error(
          `TicketService: Could not update ticket order ${ticket_order_id} status to FAILED_MINT:`,
          statusUpdateError
        )
      }
    }
    let grpcErrorCode = grpc.status.INTERNAL
    if (error.code && Object.values(grpc.status).includes(error.code)) {
      grpcErrorCode = error.code
    }
    callback({
      code: grpcErrorCode,
      message:
        error.details ||
        error.message ||
        'Failed to confirm payment and request mint.'
    })
  }
}

// ... (GetTicket, ListTicketsByEvent, ListTicketsByOwner giữ nguyên như trước) ...
async function GetTicket (call, callback) {
  /* ... */
}
async function ListTicketsByEvent (call, callback) {
  /* ... */
}
async function ListTicketsByOwner (call, callback) {
  /* ... */
}

module.exports = {
  InitiatePurchase,
  ConfirmPaymentAndRequestMint,
  GetTicket,
  ListTicketsByEvent,
  ListTicketsByOwner
}
