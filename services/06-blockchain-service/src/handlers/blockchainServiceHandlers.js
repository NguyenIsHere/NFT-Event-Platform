// src/handlers/blockchainServiceHandlers.js
const grpc = require('@grpc/grpc-js')
const {
  provider,
  signer,
  eventTicketNFTContract,
  ethers
} = require('../utils/contractUtils')

// Helper function để chờ giao dịch được mined và lấy receipt
async function waitForTransaction (txResponse, confirmations = 1) {
  console.log(`Waiting for transaction ${txResponse.hash} to be mined...`)
  const receipt = await txResponse.wait(confirmations)
  if (!receipt) {
    throw new Error(
      `Transaction ${txResponse.hash} receipt not found after ${confirmations} confirmations.`
    )
  }
  console.log(
    `Transaction ${txResponse.hash} mined in block ${receipt.blockNumber}, status: ${receipt.status}`
  )
  if (receipt.status !== 1) {
    // Lấy lý do revert nếu có (cần provider hỗ trợ, không phải lúc nào cũng có)
    let reason = 'Transaction failed on-chain.'
    try {
      const tx = await provider.getTransaction(txResponse.hash)
      if (tx) {
        const code = await provider.call({
          ...tx,
          blockTag: receipt.blockNumber - 1
        }) // Replay on previous block state
        reason = ethers.toUtf8String('0x' + code.substring(138)) // Basic revert reason parsing
      }
    } catch (e) {
      console.warn('Could not extract revert reason:', e.message)
    }
    throw new Error(
      `Transaction ${txResponse.hash} failed on-chain (status: ${receipt.status}). Reason: ${reason}`
    )
  }
  return receipt
}

// async function RegisterEventOnBlockchain (call, callback) {
//   const {
//     system_event_id_for_ref,
//     blockchain_event_id,
//     price_wei,
//     total_supply
//   } = call.request
//   console.log(
//     `RegisterEventOnBlockchain called for system_event_id: ${system_event_id_for_ref}, blockchain_event_id: ${blockchain_event_id}`
//   )

//   try {
//     const eventIdBN = BigInt(blockchain_event_id)
//     const priceWeiBN = BigInt(price_wei)
//     const totalSupplyBN = BigInt(total_supply)

//     // Lấy thông tin phí gas hiện tại từ mạng
//     const feeData = await provider.getFeeData()
//     console.log('Current fee data from network:', {
//       gasPrice: feeData.gasPrice ? feeData.gasPrice.toString() : 'N/A',
//       maxFeePerGas: feeData.maxFeePerGas
//         ? feeData.maxFeePerGas.toString()
//         : 'N/A',
//       maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
//         ? feeData.maxPriorityFeePerGas.toString()
//         : 'N/A'
//     })

//     // Tạo đối tượng options cho giao dịch để chỉ định gas
//     const txOptions = {}
//     if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
//       txOptions.maxFeePerGas = feeData.maxFeePerGas
//       txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
//       // Có thể tăng một chút để đảm bảo giao dịch được ưu tiên
//       // txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas + ethers.parseUnits("1", "gwei");
//       // txOptions.maxFeePerGas = feeData.maxFeePerGas + ethers.parseUnits("2", "gwei");
//     } else if (feeData.gasPrice) {
//       // Dùng cho mạng non-EIP-1559 (legacy)
//       txOptions.gasPrice = feeData.gasPrice
//       // txOptions.gasPrice = feeData.gasPrice + ethers.parseUnits("2", "gwei"); // Tăng một chút
//     }
//     // Nếu mạng yêu cầu cao hơn, bạn có thể cần hardcode một mức tối thiểu hoặc nhân thêm %
//     // Ví dụ, cho Linea Sepolia, bạn có thể cần một maxPriorityFeePerGas cụ thể
//     // if (txOptions.maxPriorityFeePerGas && txOptions.maxPriorityFeePerGas < ethers.parseUnits("0.01", "gwei")) {
//     //    console.log("Adjusting maxPriorityFeePerGas to a minimum for Linea Sepolia");
//     //    txOptions.maxPriorityFeePerGas = ethers.parseUnits("0.01", "gwei"); // Ví dụ: 0.01 Gwei
//     // }

//     console.log(
//       `Calling contract.createEvent(${eventIdBN}, ${priceWeiBN}, ${totalSupplyBN}) with txOptions:`,
//       txOptions
//     )
//     const tx = await eventTicketNFTContract.createEvent(
//       eventIdBN,
//       priceWeiBN,
//       totalSupplyBN,
//       txOptions // Truyền options gas vào đây
//     )
//     console.log(`Transaction sent for createEvent, hash: ${tx.hash}`)
//     const receipt = await waitForTransaction(tx)

//     callback(null, {
//       success: true,
//       transaction_hash: receipt.hash,
//       actual_blockchain_event_id: blockchain_event_id
//     })
//   } catch (error) {
//     console.error('RegisterEventOnBlockchain Error:', error)
//     // Chi tiết lỗi từ ethers.js thường đã đủ rõ ràng
//     let errorMessage = error.message || 'Failed to register event on blockchain'
//     if (error.error && error.error.message) {
//       // Lỗi từ node RPC thường nằm trong error.error
//       errorMessage = error.error.message
//     } else if (error.reason) {
//       // Đôi khi ethers cung cấp error.reason
//       errorMessage = error.reason
//     }
//     callback({
//       code: grpc.status.INTERNAL,
//       message: errorMessage
//     })
//   }
// }

// Hàm helper mới để chuẩn bị txOptions với logic gas linh hoạt
async function prepareGasOptions () {
  const feeData = await provider.getFeeData()
  console.log('Linea Sepolia - Current fee data from network:', {
    gasPrice: feeData.gasPrice ? feeData.gasPrice.toString() : 'N/A',
    maxFeePerGas: feeData.maxFeePerGas
      ? feeData.maxFeePerGas.toString()
      : 'N/A',
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
      ? feeData.maxPriorityFeePerGas.toString()
      : 'N/A',
    lastBaseFeePerGas: feeData.lastBaseFeePerGas
      ? feeData.lastBaseFeePerGas.toString()
      : 'N/A'
  })

  const txOptions = {}

  // Lấy base fee từ provider, nếu không có thì dùng fallback (ví dụ 7 Wei từ explorer)
  const currentBaseFee =
    feeData.lastBaseFeePerGas ||
    BigInt(process.env.LINEA_FALLBACK_BASE_FEE_WEI || '7')

  // Đặt Max Priority Fee (Tip)
  // Dựa trên giao dịch thành công của bạn (0.214 Gwei), có vẻ tip cao được ưu tiên.
  // Tuy nhiên, có thể không cần cao đến vậy nếu base fee thực sự là 7 Wei.
  // Hãy thử một mức tip hợp lý, ví dụ 0.05 Gwei đến 0.1 Gwei, có thể cấu hình qua .env
  // 0.05 Gwei = 50,000,000 Wei
  // 0.1  Gwei = 100,000,000 Wei
  // Giao dịch thành công của bạn có tip ~0.21 Gwei, nhưng đó có thể là do provider.getFeeData() đã gợi ý như vậy.

  // Nếu provider gợi ý maxPriorityFeePerGas và nó hợp lý (ví dụ > 0.001 Gwei), hãy dùng nó.
  // Nếu không, đặt một giá trị mặc định.
  let priorityFeeToUse
  const minSensiblePriorityFee = ethers.parseUnits(
    process.env.LINEA_MIN_SENSIBLE_PRIORITY_FEE_GWEI || '0.01',
    'gwei'
  ) // Ví dụ: 0.01 Gwei

  if (
    feeData.maxPriorityFeePerGas &&
    feeData.maxPriorityFeePerGas >= minSensiblePriorityFee
  ) {
    priorityFeeToUse = feeData.maxPriorityFeePerGas
    console.log(
      `Using provider's suggested maxPriorityFeePerGas: ${priorityFeeToUse.toString()} Wei`
    )
  } else {
    priorityFeeToUse = minSensiblePriorityFee
    console.log(
      `Provider's maxPriorityFeePerGas is too low or N/A. Using default minimum priority fee: ${priorityFeeToUse.toString()} Wei`
    )
  }
  txOptions.maxPriorityFeePerGas = priorityFeeToUse

  // Tính Max Fee Per Gas = Base Fee (hiện tại hoặc dự kiến) + Tip + Buffer
  // Buffer để phòng trường hợp base fee tăng nhẹ ở block tiếp theo
  const bufferForMaxFee = ethers.parseUnits(
    process.env.LINEA_MAX_FEE_BUFFER_GWEI || '0.05',
    'gwei'
  ) // Ví dụ: buffer 0.05 Gwei
  txOptions.maxFeePerGas =
    currentBaseFee + txOptions.maxPriorityFeePerGas + bufferForMaxFee

  // Đảm bảo maxFeePerGas không quá thấp
  const absoluteMinMaxFee = ethers.parseUnits(
    process.env.LINEA_ABSOLUTE_MIN_MAX_FEE_GWEI || '0.1',
    'gwei'
  ) // Ví dụ: ít nhất 0.1 Gwei
  if (txOptions.maxFeePerGas < absoluteMinMaxFee) {
    console.warn(
      `Calculated maxFeePerGas (${txOptions.maxFeePerGas.toString()} Wei) is below absolute minimum. Adjusting to ${absoluteMinMaxFee.toString()} Wei.`
    )
    txOptions.maxFeePerGas = absoluteMinMaxFee
    // Đảm bảo tip vẫn hợp lệ so với maxFeePerGas mới
    if (txOptions.maxPriorityFeePerGas >= txOptions.maxFeePerGas) {
      txOptions.maxPriorityFeePerGas =
        txOptions.maxFeePerGas - currentBaseFee > BigInt(0)
          ? txOptions.maxFeePerGas - currentBaseFee
          : BigInt(1) // Tip ít nhất 1 Wei
      if (txOptions.maxPriorityFeePerGas <= BigInt(0))
        txOptions.maxPriorityFeePerGas = BigInt(1)
    }
  }

  console.log('Prepared EIP-1559 Gas TxOptions for Linea Sepolia:', {
    maxFeePerGas: txOptions.maxFeePerGas.toString(),
    maxPriorityFeePerGas: txOptions.maxPriorityFeePerGas.toString()
  })
  return txOptions
}

async function RegisterEventOnBlockchain (call, callback) {
  const {
    system_event_id_for_ref,
    blockchain_event_id,
    price_wei,
    total_supply
  } = call.request
  console.log(
    `RegisterEventOnBlockchain called for system_event_id: ${system_event_id_for_ref}, blockchain_event_id: ${blockchain_event_id}`
  )

  try {
    const eventIdBN = BigInt(blockchain_event_id)
    const priceWeiBN = BigInt(price_wei)
    const totalSupplyBN = BigInt(total_supply)

    const txOptions = await prepareGasOptions()

    console.log(
      `Calling contract.createEvent(${eventIdBN}, ${priceWeiBN}, ${totalSupplyBN}) with txOptions:`,
      txOptions
    )
    const tx = await eventTicketNFTContract.createEvent(
      eventIdBN,
      priceWeiBN,
      totalSupplyBN,
      txOptions // Truyền options gas vào đây
    )
    console.log(`Transaction sent for createEvent, hash: ${tx.hash}`)
    const receipt = await waitForTransaction(tx)

    callback(null, {
      success: true,
      transaction_hash: receipt.hash,
      actual_blockchain_event_id: blockchain_event_id // Giả sử ID truyền vào là ID được dùng
    })
  } catch (error) {
    console.error('RegisterEventOnBlockchain Error:', error)
    let errorMessage = error.message || 'Failed to register event on blockchain'
    if (error.error && error.error.message) {
      errorMessage = error.error.message
    } else if (error.reason) {
      errorMessage = error.reason
    }
    callback({
      code: grpc.status.INTERNAL,
      message: errorMessage
    })
  }
}

async function GetTicketPaymentDetails (call, callback) {
  const { blockchain_event_id, price_wei_from_ticket_type } = call.request
  console.log(
    `GetTicketPaymentDetails called for blockchain_event_id: ${blockchain_event_id}`
  )
  try {
    // Thông tin contract address là cố định
    const paymentContractAddress = await eventTicketNFTContract.getAddress() // eventTicketNFTContract.address cho ethers v5

    // Giá có thể lấy trực tiếp từ contract nếu đã đăng ký event
    // hoặc dùng giá từ ticket_type nếu đó là giá cuối cùng
    let priceToPayWei = price_wei_from_ticket_type // Mặc định dùng giá từ ticket type

    if (blockchain_event_id && BigInt(blockchain_event_id) > 0) {
      // Kiểm tra xem có blockchain_event_id không
      try {
        const eventIdBN = BigInt(blockchain_event_id)
        const eventDetails = await eventTicketNFTContract.eventInfo(eventIdBN)
        if (eventDetails && eventDetails.price > 0) {
          // eventDetails.price là BigInt
          priceToPayWei = eventDetails.price.toString()
          console.log(
            `Price for event ${blockchain_event_id} from contract: ${priceToPayWei} wei`
          )
        } else {
          console.warn(
            `Event ${blockchain_event_id} not found or price is zero on contract. Using price from ticket type: ${price_wei_from_ticket_type}`
          )
        }
      } catch (contractError) {
        console.error(
          `Error fetching event info from contract for event ${blockchain_event_id}:`,
          contractError.message
        )
        console.warn(
          `Using price from ticket type: ${price_wei_from_ticket_type} due to contract query error.`
        )
      }
    } else {
      console.log(
        `No valid blockchain_event_id provided, using price from ticket type: ${price_wei_from_ticket_type}`
      )
    }

    callback(null, {
      payment_contract_address: paymentContractAddress,
      price_to_pay_wei: priceToPayWei
      // chain_id: (await provider.getNetwork()).chainId.toString() // Nếu cần chain_id
    })
  } catch (error) {
    console.error('GetTicketPaymentDetails Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get ticket payment details'
    })
  }
}

async function MintTicket (call, callback) {
  const {
    buyer_address,
    token_uri_cid,
    blockchain_event_id,
    session_id_for_contract
  } = call.request
  console.log(
    `MintTicket called for buyer: ${buyer_address}, event: ${blockchain_event_id}, session: ${session_id_for_contract}, uri: ${token_uri_cid}`
  )

  try {
    // Lấy giá từ contract cho event này để đưa vào mảng prices cho batchMint
    const eventIdBN = BigInt(blockchain_event_id)
    const eventDetails = await eventTicketNFTContract.eventInfo(eventIdBN)
    if (!eventDetails || eventDetails.price === BigInt(0)) {
      // eventDetails.price là BigInt
      throw new Error(
        `Event ${blockchain_event_id} not found on blockchain or has no price.`
      )
    }
    const priceWeiBN = eventDetails.price

    // Chuyển đổi các ID sang BigInt
    const sessionIdBN = BigInt(session_id_for_contract)

    // Hàm batchMint của bạn nhận mảng, nên chúng ta tạo mảng 1 phần tử
    const uris = [token_uri_cid]
    const eventIds = [eventIdBN]
    const sessionIds = [sessionIdBN]
    const prices = [priceWeiBN] // Giá lấy từ contract

    console.log(
      `Calling contract.batchMint(${buyer_address}, [${uris[0]}], [${eventIds[0]}], [${sessionIds[0]}], [${prices[0]}])`
    )
    // Giao dịch này được ký bởi signer của blockchain-service (owner của contract)
    const tx = await eventTicketNFTContract.batchMint(
      buyer_address,
      uris,
      eventIds,
      sessionIds,
      prices
    )
    console.log(`Transaction sent for batchMint (single), hash: ${tx.hash}`)
    const receipt = await waitForTransaction(tx)

    // Lấy tokenId từ Event TicketMinted
    // Cần parse logs từ receipt để tìm event TicketMinted và lấy tokenId
    let mintedTokenId = '0' // Default hoặc giá trị không hợp lệ
    for (const log of receipt.logs || []) {
      try {
        const parsedLog = eventTicketNFTContract.interface.parseLog(log)
        if (parsedLog && parsedLog.name === 'TicketMinted') {
          mintedTokenId = parsedLog.args.tokenId.toString()
          console.log(
            `Found TicketMinted event: tokenId=${mintedTokenId}, eventId=${parsedLog.args.eventId.toString()}, sessionId=${parsedLog.args.sessionId.toString()}, owner=${
              parsedLog.args.owner
            }, price=${parsedLog.args.price.toString()}`
          )
          break
        }
      } catch (e) {
        // Ignore errors parsing logs that are not from our contract
      }
    }

    if (mintedTokenId === '0' && receipt.logs?.length > 0) {
      console.warn(
        'MintTicket: TicketMinted event not found or tokenId not parsed correctly from logs. Will attempt to read nextTokenId.'
      )
      // Fallback: nếu không parse được event, thử đọc nextTokenId và trừ 1
      // LƯU Ý: Cách này không an toàn 100% nếu có nhiều giao dịch mint đồng thời.
      // Tốt nhất là dựa vào event log.
      const nextTokenIdFromContract = await eventTicketNFTContract.nextTokenId()
      mintedTokenId = (nextTokenIdFromContract - BigInt(1)).toString() // nextTokenId đã tăng lên 1
    }

    if (mintedTokenId === '0') {
      throw new Error(
        'Failed to retrieve minted tokenId from transaction receipt.'
      )
    }

    callback(null, {
      success: true,
      token_id: mintedTokenId,
      transaction_hash: receipt.hash, // receipt.transactionHash cho ethers v5
      owner_address: buyer_address // người mua là người sở hữu
    })
  } catch (error) {
    console.error('MintTicket Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to mint ticket'
    })
  }
}

async function VerifyTransaction (call, callback) {
  const { transaction_hash } = call.request
  console.log(`VerifyTransaction called for hash: ${transaction_hash}`)
  try {
    const tx = await provider.getTransaction(transaction_hash)
    if (!tx) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Transaction hash ${transaction_hash} not found.`
      })
    }

    const receipt = await provider.getTransactionReceipt(transaction_hash)
    if (!receipt) {
      // Giao dịch có thể chưa được mined
      return callback(null, {
        is_confirmed: false,
        success_on_chain: false, // Chưa biết
        from_address: tx.from || '',
        to_address: tx.to || '',
        value_wei: tx.value.toString(),
        block_number: BigInt(0) // Chưa có block number
      })
    }

    callback(null, {
      is_confirmed: receipt.confirmations > 0, // Hoặc dùng receipt.isMined() cho ethers v6
      success_on_chain: receipt.status === 1,
      from_address: receipt.from,
      to_address: receipt.to,
      value_wei: tx.value.toString(), // Lấy value từ tx gốc
      block_number: BigInt(receipt.blockNumber) // receipt.blockNumber là number
    })
  } catch (error) {
    console.error('VerifyTransaction Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to verify transaction'
    })
  }
}

module.exports = {
  RegisterEventOnBlockchain,
  GetTicketPaymentDetails,
  MintTicket,
  VerifyTransaction
}
