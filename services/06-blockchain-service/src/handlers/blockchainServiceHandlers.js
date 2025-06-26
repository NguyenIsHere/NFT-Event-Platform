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

// ✅ FIX: Register Event Only (no price/supply)
async function RegisterEventOnBlockchain (call, callback) {
  const { system_event_id_for_ref, blockchain_event_id, event_name } =
    call.request

  try {
    const eventIdBN = BigInt(blockchain_event_id)
    const txOptions = await prepareGasOptions()

    console.log(`Calling contract.createEvent(${eventIdBN}, "${event_name}")`)
    const tx = await eventTicketNFTContract.createEvent(
      eventIdBN,
      event_name,
      txOptions
    )

    const receipt = await waitForTransaction(tx)

    callback(null, {
      success: true,
      transaction_hash: receipt.hash,
      actual_blockchain_event_id: blockchain_event_id
    })
  } catch (error) {
    console.error('RegisterEventOnBlockchain Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to register event on blockchain'
    })
  }
}

// ✅ NEW: Register TicketType on Blockchain
async function RegisterTicketTypeOnBlockchain (call, callback) {
  const { blockchain_event_id, ticket_type_name, price_wei, total_supply } =
    call.request

  try {
    const eventIdBN = BigInt(blockchain_event_id)
    const priceWeiBN = BigInt(price_wei)
    const totalSupplyBN = BigInt(total_supply)
    const txOptions = await prepareGasOptions()

    console.log(
      `Calling contract.createTicketType(${eventIdBN}, "${ticket_type_name}", ${priceWeiBN}, ${totalSupplyBN})`
    )
    const tx = await eventTicketNFTContract.createTicketType(
      eventIdBN,
      ticket_type_name,
      priceWeiBN,
      totalSupplyBN,
      txOptions
    )

    const receipt = await waitForTransaction(tx)

    // Parse logs to get ticketTypeId
    let blockchainTicketTypeId = '0'
    for (const log of receipt.logs || []) {
      try {
        const parsed = eventTicketNFTContract.interface.parseLog(log)
        if (parsed.name === 'TicketTypeCreated') {
          blockchainTicketTypeId = parsed.args.ticketTypeId.toString()
          break
        }
      } catch (e) {
        // Skip unparseable logs
      }
    }

    callback(null, {
      success: true,
      transaction_hash: receipt.hash,
      blockchain_ticket_type_id: blockchainTicketTypeId
    })
  } catch (error) {
    console.error('RegisterTicketTypeOnBlockchain Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to register ticket type on blockchain'
    })
  }
}

async function GetTicketPaymentDetails (call, callback) {
  const { blockchain_event_id, price_wei_from_ticket_type } = call.request
  console.log(
    `GetTicketPaymentDetails called for blockchain_event_id: ${blockchain_event_id}`
  )
  try {
    const paymentContractAddress = await eventTicketNFTContract.getAddress()

    let priceToPayWei = price_wei_from_ticket_type

    if (blockchain_event_id && BigInt(blockchain_event_id) > 0) {
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
    blockchain_ticket_type_id, // ✅ CHANGE: Use ticket type ID instead of event ID
    session_id_for_contract
  } = call.request

  console.log(
    `MintTicket called for buyer: ${buyer_address}, ticketTypeId: ${blockchain_ticket_type_id}, session: ${session_id_for_contract}, uri: ${token_uri_cid}`
  )

  try {
    // ✅ FIX: Validate ticket type exists on contract
    const ticketTypeIdBN = BigInt(blockchain_ticket_type_id)
    const ticketTypeInfo = await eventTicketNFTContract.ticketTypeInfo(
      ticketTypeIdBN
    )

    if (!ticketTypeInfo || !ticketTypeInfo.exists) {
      throw new Error(
        `TicketType ${blockchain_ticket_type_id} not found on blockchain`
      )
    }

    const sessionIdBN = BigInt(session_id_for_contract)

    // ✅ FIX: Use batchMint with ticketTypeIds
    const uris = [token_uri_cid]
    const ticketTypeIds = [ticketTypeIdBN]
    const sessionIds = [sessionIdBN]

    console.log(
      `Calling contract.batchMint(${buyer_address}, [${uris[0]}], [${ticketTypeIds[0]}], [${sessionIds[0]}])`
    )

    const txOptions = await prepareGasOptions()

    // ✅ FIX: Call batchMint with ticketTypeIds
    const tx = await eventTicketNFTContract.batchMint(
      buyer_address,
      uris,
      ticketTypeIds,
      sessionIds,
      txOptions
    )

    console.log(`Transaction sent for batchMint, hash: ${tx.hash}`)
    const receipt = await waitForTransaction(tx)

    // Parse logs to get tokenId
    let mintedTokenId = '0'
    for (const log of receipt.logs || []) {
      try {
        const parsedLog = eventTicketNFTContract.interface.parseLog(log)
        if (parsedLog && parsedLog.name === 'TicketMinted') {
          mintedTokenId = parsedLog.args.tokenId.toString()
          console.log(
            `Found TicketMinted event: tokenId=${mintedTokenId}, eventId=${parsedLog.args.eventId.toString()}, ticketTypeId=${parsedLog.args.ticketTypeId.toString()}`
          )
          break
        }
      } catch (e) {
        // Ignore logs that aren't from our contract
      }
    }

    if (mintedTokenId === '0') {
      throw new Error(
        'Failed to retrieve minted tokenId from transaction receipt'
      )
    }

    callback(null, {
      success: true,
      token_id: mintedTokenId,
      transaction_hash: receipt.hash,
      owner_address: buyer_address
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
    // ✅ VALIDATE transaction hash format
    if (!transaction_hash || typeof transaction_hash !== 'string') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Transaction hash is required and must be a string'
      })
    }

    if (transaction_hash.length !== 66 || !transaction_hash.startsWith('0x')) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message:
          'Transaction hash must be a valid hex string (66 characters, starting with 0x)'
      })
    }

    const hexPattern = /^0x[0-9a-fA-F]{64}$/
    if (!hexPattern.test(transaction_hash)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Transaction hash contains invalid hex characters'
      })
    }

    console.log(`Getting transaction for valid hash: ${transaction_hash}`)

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

    // ✅ FIX: Check confirmation properly for Ethers v6
    const currentBlockNumber = await provider.getBlockNumber()
    const confirmations = currentBlockNumber - receipt.blockNumber
    const minConfirmations = 1 // Require at least 1 confirmation

    const isConfirmed = confirmations >= minConfirmations
    const isSuccessful = receipt.status === 1

    console.log(`✅ Transaction verification details:`, {
      txHash: transaction_hash,
      blockNumber: receipt.blockNumber,
      currentBlockNumber,
      confirmations,
      minConfirmations,
      isConfirmed,
      isSuccessful,
      status: receipt.status
    })

    callback(null, {
      is_confirmed: isConfirmed,
      success_on_chain: isSuccessful,
      from_address: receipt.from || tx.from || '',
      to_address: receipt.to || tx.to || '',
      value_wei: tx.value ? tx.value.toString() : '0',
      block_number: Number(receipt.blockNumber) || 0
    })
  } catch (error) {
    console.error('VerifyTransaction Error:', error)

    if (error.code === 'UNKNOWN_ERROR' && error.error?.code === -32602) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message:
          'Invalid transaction hash format - must be 64 hex characters with 0x prefix'
      })
    }

    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to verify transaction'
    })
  }
}

// blockchainServiceHandlers.js - Thêm method mới
async function ParseTransactionLogs (call, callback) {
  const { transaction_hash } = call.request
  console.log(`ParseTransactionLogs called for hash: ${transaction_hash}`)

  try {
    const receipt = await provider.getTransactionReceipt(transaction_hash)
    if (!receipt) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Transaction receipt not found'
      })
    }

    let mintedTokenId = null
    let eventId = null
    let sessionId = null

    // Parse logs để tìm TicketMinted event
    for (const log of receipt.logs || []) {
      try {
        const parsedLog = eventTicketNFTContract.interface.parseLog(log)
        if (parsedLog && parsedLog.name === 'TicketMinted') {
          mintedTokenId = parsedLog.args.tokenId.toString()
          eventId = parsedLog.args.eventId.toString()
          sessionId = parsedLog.args.sessionId.toString()

          console.log(
            `Found TicketMinted: tokenId=${mintedTokenId}, eventId=${eventId}, sessionId=${sessionId}`
          )
          break
        }
      } catch (e) {
        // Ignore logs that aren't from our contract
      }
    }

    callback(null, {
      success: true,
      minted_token_id: mintedTokenId || '',
      event_id: eventId || '',
      session_id: sessionId || ''
    })
  } catch (error) {
    console.error('ParseTransactionLogs Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to parse transaction logs'
    })
  }
}

module.exports = {
  RegisterEventOnBlockchain,
  RegisterTicketTypeOnBlockchain,
  GetTicketPaymentDetails,
  MintTicket, // Giữ lại cho admin mint nếu cần
  VerifyTransaction,
  ParseTransactionLogs // Thêm method mới
}
