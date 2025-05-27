// 05-ticket-service/src/handlers/ticketServiceHandlers.js (KHUNG SƯỜN)
const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket') // Giả sử export chung từ Ticket.js
const grpc = require('@grpc/grpc-js')
const ipfsServiceClient = require('../clients/ipfsServiceClient')
const blockchainServiceClient = require('../clients/blockchainServiceClient')
// const eventServiceClient = require('../clients/eventServiceClient'); // Nếu cần
const mongoose = require('mongoose')

// Helper để chuyển đổi Ticket model sang Ticket message của proto
function ticketToProto (ticketDoc) {
  if (!ticketDoc) return null
  const ticketData = ticketDoc.toJSON()
  return {
    ...ticketData,
    created_at: ticketDoc.createdAt
      ? Math.floor(new Date(ticketDoc.createdAt).getTime() / 1000)
      : 0 // Unix timestamp seconds
    // token_id đã là string trong model
  }
}

async function PreparePurchaseTicket (call, callback) {
  const { ticket_type_id, session_id, buyer_address } = call.request
  console.log(
    `PreparePurchaseTicket called for ticket_type_id: ${ticket_type_id}, session: ${session_id}, buyer: ${buyer_address}`
  )
  try {
    // 1. Lấy thông tin TicketType từ DB
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
        message: 'TicketType not found.'
      })
    }
    if (ticketType.availableQuantity <= 0) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'This ticket type is sold out.'
      })
    }

    // 2. (Tùy chọn) Kiểm tra thông tin Event hoặc Session từ event-service nếu cần
    // Ví dụ: const eventDetails = await eventServiceClient.GetEvent({ event_id: ticketType.eventId });
    // Kiểm tra session_id có hợp lệ cho event đó không, event có active không, v.v.

    // 3. Tạo metadata cho vé NFT
    // Ví dụ đơn giản, bạn có thể lấy thêm thông tin từ EventService
    const nftMetadata = {
      name: `Ticket for ${ticketType.name} - EventID ${ticketType.eventId}`,
      description: `A ticket of type ${ticketType.name}. Event Blockchain ID: ${
        ticketType.blockchainEventId
      }. Session: ${session_id || 'Any'}`,
      // image: "ipfs://CID_ANH_DA_UPLOAD_CHO_EVENT_HOAC_LOAI_VE", // Lấy CID ảnh từ Event hoặc TicketType
      attributes: [
        { trait_type: 'Ticket Type', value: ticketType.name },
        {
          trait_type: 'Event Blockchain ID',
          value: ticketType.blockchainEventId.toString()
        },
        { trait_type: 'Session', value: session_id || 'N/A' }
      ]
    }
    const jsonContent = JSON.stringify(nftMetadata)

    // 4. Upload metadata JSON lên IPFS qua ipfs-service
    console.log(
      `Uploading NFT metadata to IPFS for ticket type ${ticket_type_id}`
    )
    const ipfsResponse = await new Promise((resolve, reject) => {
      ipfsServiceClient.PinJSONToIPFS(
        {
          json_content: jsonContent,
          options: {
            pin_name: `ticket_meta_${ticketType.name}_${new Date().getTime()}`
          }
        },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })
    const tokenUriCid = ipfsResponse.ipfs_hash // Chỉ lấy hash, không có "ipfs://"
    console.log(`NFT metadata pinned to IPFS. CID: ${tokenUriCid}`)

    // 5. Lấy thông tin thanh toán từ blockchain-service
    // (đã có giá từ ticketType, nhưng có thể cần địa chỉ contract)
    console.log(
      `Getting payment details from BlockchainService for event_id: ${ticketType.blockchainEventId}`
    )
    const paymentDetails = await new Promise((resolve, reject) => {
      blockchainServiceClient.GetTicketPaymentDetails(
        {
          blockchain_event_id: ticketType.blockchainEventId.toString(), // proto yêu cầu string
          price_wei_from_ticket_type: ticketType.priceWei
        },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })

    callback(null, {
      payment_contract_address: paymentDetails.payment_contract_address,
      price_wei: paymentDetails.price_to_pay_wei, // Giá này có thể được xác nhận lại từ contract
      blockchain_event_id: ticketType.blockchainEventId.toString(), // Đảm bảo là string
      session_id_for_contract: session_id || '0', // Contract có thể cần uint256, "0" nếu không có session cụ thể
      token_uri_cid: tokenUriCid // CID của metadata JSON (không có "ipfs://")
    })
  } catch (error) {
    console.error('PreparePurchaseTicket RPC error:', error)
    // ... (xử lý lỗi chi tiết hơn)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to prepare ticket purchase.'
    })
  }
}

async function ConfirmPurchaseAndMintTicket (call, callback) {
  const { transaction_hash, ticket_type_id, session_id, owner_address } =
    call.request
  console.log(
    `ConfirmPurchaseAndMintTicket called for tx_hash: ${transaction_hash}, owner: ${owner_address}`
  )
  try {
    // 1. Kiểm tra TicketType tồn tại và còn vé
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
        message: 'TicketType not found.'
      })
    }
    if (ticketType.availableQuantity <= 0) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Ticket type sold out while confirming.'
      })
    }

    // 2. Xác minh giao dịch trên blockchain qua blockchain-service
    console.log(
      `Verifying transaction ${transaction_hash} via BlockchainService.`
    )
    const verifyResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.VerifyTransaction(
        { transaction_hash },
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
        'Transaction verification failed or transaction not successful on chain:',
        verifyResponse
      )
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Transaction ${transaction_hash} not confirmed or failed on chain.`
      })
    }
    // (Tùy chọn) Kiểm tra thêm verifyResponse.to_address, verifyResponse.value_wei, verifyResponse.from_address (phải là owner_address)

    // 3. Nếu user tự gọi hàm buyTickets() của contract, thì NFT đã được mint.
    // Chúng ta cần lấy tokenId từ event TicketMinted của contract.
    // Cách tốt nhất là blockchain-service nên có một RPC để query tokenId từ transaction_hash (bằng cách đọc event log).
    // Hoặc, nếu luồng là backend mint hộ (qua MintTicket RPC của blockchain-service), thì gọi nó ở đây.
    // Giả sử luồng là user tự gọi buyTickets(), và chúng ta cần tìm tokenId.
    // Đây là phần phức tạp, vì việc lấy tokenId từ tx_hash ngay lập tức có thể khó khăn nếu giao dịch chưa được mined hoàn toàn
    // hoặc nếu không có cơ chế lắng nghe event hiệu quả.
    //
    // Tạm thời, chúng ta sẽ giả định rằng sau khi VerifyTransaction thành công,
    // một quy trình khác (hoặc một event listener) sẽ cập nhật tokenId vào DB.
    // Hoặc, nếu `MintTicket` RPC của blockchain service được thiết kế để mint và trả về tokenId
    // và `ConfirmPurchaseAndMintTicketRequest` cung cấp đủ thông tin cho `MintTicket` RPC đó:
    /*
        const { token_uri_cid_from_prepare, blockchain_event_id_from_prepare, session_id_for_contract_from_prepare } = some_way_to_get_this_data_again_or_pass_from_client;
        const mintResponse = await new Promise((resolve, reject) => {
            blockchainServiceClient.MintTicket({
                buyer_address: owner_address,
                token_uri_cid: token_uri_cid_from_prepare, // Cần CID này
                blockchain_event_id: blockchain_event_id_from_prepare, // Cần ID này
                session_id_for_contract: session_id_for_contract_from_prepare // Cần session này
            }, (err, response) => {
                if (err) return reject(err);
                resolve(response);
            });
        });
        if (!mintResponse || !mintResponse.success) {
            throw new Error(mintResponse.message || "Failed to mint NFT via BlockchainService after payment confirmation.");
        }
        const mintedTokenId = mintResponse.token_id;
        */
    // DO LUỒNG HIỆN TẠI USER TỰ GỌI buyTickets(), ta sẽ tạo vé PENDING_MINT và chờ một tiến trình khác cập nhật tokenId
    // Hoặc, nếu VerifyTransaction có thể trả về tokenId từ event log thì tốt hơn.

    // 4. Tạo vé trong database với trạng thái chờ (hoặc đã bán nếu có tokenId)
    const newTicket = new Ticket({
      eventId: ticketType.eventId,
      ticketTypeId: ticket_type_id,
      // tokenId: mintedTokenId, // Sẽ cập nhật sau nếu luồng là user tự mint
      ownerAddress: owner_address.toLowerCase(), // Lưu địa chỉ dạng lowercase
      sessionId: session_id, // session_id từ request
      status: TICKET_STATUS_ENUM[4], // PENDING_MINT (hoặc SOLD nếu đã có tokenId)
      // tokenUriCid: token_uri_cid_from_prepare, // Lưu lại CID đã dùng để mint
      transactionHash: transaction_hash
    })
    const savedTicket = await newTicket.save()

    // 5. Giảm số lượng vé còn lại của TicketType
    ticketType.availableQuantity -= 1
    await ticketType.save()

    console.log(
      `Ticket ${savedTicket.id} created in DB for owner ${owner_address}, tx_hash ${transaction_hash}. Status: PENDING_MINT. Waiting for tokenId update.`
    )

    // Cần một cơ chế (ví dụ: worker, event listener) để theo dõi transaction_hash,
    // lấy tokenId từ event `TicketMinted` của contract, rồi cập nhật lại bản ghi Ticket trong DB.
    // Hiện tại, ta trả về vé với thông tin đã có.

    callback(null, { ticket: ticketToProto(savedTicket) })
  } catch (error) {
    console.error('ConfirmPurchaseAndMintTicket RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to confirm purchase and mint ticket.'
    })
  }
}

// ... (Các handlers khác như GetTicket, ListTicketsByEvent, ListTicketsByOwner) ...
// Bạn cần tự viết logic cho chúng, ví dụ:
async function GetTicket (call, callback) {
  const { ticket_id } = call.request
  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket ID format.'
      })
    }
    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket not found.'
      })
    }
    callback(null, ticketToProto(ticket))
  } catch (error) {
    console.error('GetTicket RPC error:', error)
    callback({ code: grpc.status.INTERNAL, message: 'Failed to get ticket.' })
  }
}

module.exports = {
  PreparePurchaseTicket,
  ConfirmPurchaseAndMintTicket,
  GetTicket
  // ListTicketsByEvent,
  // ListTicketsByOwner,
}
