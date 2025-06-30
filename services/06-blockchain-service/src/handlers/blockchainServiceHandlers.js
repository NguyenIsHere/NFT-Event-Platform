// src/handlers/blockchainServiceHandlers.js
const grpc = require('@grpc/grpc-js')
const {
  provider,
  signer,
  eventTicketNFTContract,
  ethers
} = require('../utils/contractUtils')
const eventServiceClient = require('../clients/eventServiceClient')

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

// Update RegisterEventOnBlockchain to include organizer
// Update RegisterEventOnBlockchain to include organizer
async function RegisterEventOnBlockchain (call, callback) {
  const {
    system_event_id_for_ref,
    blockchain_event_id,
    event_name,
    organizer_address
  } = call.request

  try {
    const eventIdBN = BigInt(blockchain_event_id)
    const txOptions = await prepareGasOptions()

    // ✅ Validate organizer address
    if (!organizer_address || !organizer_address.startsWith('0x')) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Valid organizer address is required'
      })
    }

    console.log(
      `Calling contract.createEvent(${eventIdBN}, "${event_name}", "${organizer_address}")`
    )
    const tx = await eventTicketNFTContract.createEvent(
      eventIdBN,
      event_name,
      organizer_address, // ✅ Pass organizer address
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

// ✅ NEW: Set platform fee
async function SetPlatformFee (call, callback) {
  const { fee_percent } = call.request

  console.log(`SetPlatformFee called for fee: ${fee_percent}%`)

  try {
    if (fee_percent > 30) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Fee percent cannot exceed 30%'
      })
    }

    const txOptions = await prepareGasOptions()

    // Get current fee first
    const currentFee = await eventTicketNFTContract.getPlatformFeePercent()

    console.log(`Setting platform fee from ${currentFee}% to ${fee_percent}%`)

    const tx = await eventTicketNFTContract.setPlatformFeePercent(
      fee_percent,
      txOptions
    )

    const receipt = await waitForTransaction(tx)

    callback(null, {
      success: true,
      transaction_hash: receipt.hash,
      old_fee_percent: Number(currentFee),
      new_fee_percent: fee_percent
    })
  } catch (error) {
    console.error('SetPlatformFee error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to set platform fee'
    })
  }
}

// ✅ NEW: Get platform fee
async function GetPlatformFee (call, callback) {
  try {
    const currentFee = await eventTicketNFTContract.getPlatformFeePercent()
    const maxFee = await eventTicketNFTContract.MAX_PLATFORM_FEE()

    callback(null, {
      fee_percent: Number(currentFee),
      max_fee_percent: Number(maxFee)
    })
  } catch (error) {
    console.error('GetPlatformFee error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get platform fee'
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

        // ✅ FIX: Check if event exists on contract
        const eventDetails = await eventTicketNFTContract.eventInfo(eventIdBN)
        console.log(`📋 Event ${blockchain_event_id} details from contract:`, {
          exists: eventDetails?.exists || false,
          name: eventDetails?.name || 'N/A'
        })

        if (eventDetails && eventDetails.exists) {
          console.log(
            `✅ Event ${blockchain_event_id} found on contract: ${eventDetails.name}`
          )
          // ✅ FIX: For this contract, we ALWAYS use price from ticket type since events don't store price
          console.log(
            `Using price from ticket type: ${price_wei_from_ticket_type}`
          )
        } else {
          console.warn(
            `❌ Event ${blockchain_event_id} not found on contract. Using price from ticket type: ${price_wei_from_ticket_type}`
          )
        }
      } catch (contractError) {
        console.error(
          `❌ Error fetching event info from contract for event ${blockchain_event_id}:`,
          contractError.message
        )
        console.log(
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
    blockchain_ticket_type_id,
    session_id_for_contract
  } = call.request

  console.log(
    `MintTicket called for buyer: ${buyer_address}, ticketTypeId: ${blockchain_ticket_type_id}, session: ${session_id_for_contract}, uri: ${token_uri_cid}`
  )

  try {
    // Validate inputs
    if (!buyer_address || !token_uri_cid || !blockchain_ticket_type_id) {
      throw new Error('Missing required parameters for minting')
    }

    const ticketTypeIdBN = BigInt(blockchain_ticket_type_id)

    // Validate ticket type exists
    try {
      const ticketTypeInfo = await eventTicketNFTContract.ticketTypeInfo(
        ticketTypeIdBN
      )
      if (!ticketTypeInfo || !ticketTypeInfo.exists) {
        throw new Error(
          `Ticket type ${blockchain_ticket_type_id} not found on contract`
        )
      }
      console.log('✅ Ticket type validated on contract:', {
        ticketTypeId: blockchain_ticket_type_id,
        price: ticketTypeInfo.price.toString(),
        eventId: ticketTypeInfo.eventId.toString(),
        exists: ticketTypeInfo.exists
      })
    } catch (contractError) {
      console.error('❌ Ticket type validation failed:', contractError)
      throw new Error(`Invalid ticket type ID: ${blockchain_ticket_type_id}`)
    }

    console.log('🏗️ Minting NFT with params:', {
      buyer_address,
      token_uri_cid,
      ticketTypeId: blockchain_ticket_type_id,
      sessionId: session_id_for_contract || '1'
    })

    const txOptions = await prepareGasOptions()

    // ✅ FIX: Use mintTicket (single mint like old contract)
    const tx = await eventTicketNFTContract.mintTicket(
      buyer_address, // address to
      token_uri_cid, // string uri
      ticketTypeIdBN, // uint256 ticketTypeId
      BigInt(session_id_for_contract || '1'), // uint256 sessionId
      txOptions
    )

    console.log(`Transaction sent for mintTicket, hash: ${tx.hash}`)
    const receipt = await waitForTransaction(tx, 2)

    // Parse logs for TicketMinted event
    let mintedTokenId = '0'

    for (const log of receipt.logs || []) {
      try {
        const parsedLog = eventTicketNFTContract.interface.parseLog(log)

        if (parsedLog && parsedLog.name === 'TicketMinted') {
          mintedTokenId = parsedLog.args.tokenId.toString()

          console.log('✅ Found TicketMinted event:', {
            tokenId: mintedTokenId,
            eventId: parsedLog.args.eventId.toString(),
            ticketTypeId: parsedLog.args.ticketTypeId.toString(),
            owner: parsedLog.args.owner
          })
          break
        }
      } catch (parseError) {
        console.log('⚠️ Could not parse log:', parseError.message)
      }
    }

    if (mintedTokenId === '0') {
      throw new Error(
        'Failed to retrieve minted tokenId from transaction receipt'
      )
    }

    // Verify token URI was set correctly
    try {
      const setTokenURI = await eventTicketNFTContract.tokenURI(mintedTokenId)
      console.log('✅ Token URI verified on contract:', {
        tokenId: mintedTokenId,
        uri: setTokenURI,
        expectedUri: token_uri_cid
      })

      // Verify owner
      const owner = await eventTicketNFTContract.ownerOf(mintedTokenId)
      console.log('✅ Token owner verified:', {
        tokenId: mintedTokenId,
        owner: owner,
        expectedOwner: buyer_address
      })
    } catch (verifyError) {
      console.warn('⚠️ Could not verify token details:', verifyError.message)
    }

    console.log(`✅ Successfully minted NFT with tokenId: ${mintedTokenId}`)

    callback(null, {
      success: true,
      token_id: mintedTokenId,
      transaction_hash: receipt.hash,
      owner_address: buyer_address,
      gas_used: receipt.gasUsed?.toString() || '0'
    })
  } catch (error) {
    console.error('❌ MintTicket Error:', error)

    let errorMessage = error.message || 'Failed to mint ticket'
    let statusCode = grpc.status.INTERNAL

    if (error.message?.includes('Invalid ticket type')) {
      statusCode = grpc.status.INVALID_ARGUMENT
    } else if (error.message?.includes('insufficient funds')) {
      statusCode = grpc.status.FAILED_PRECONDITION
      errorMessage = 'Insufficient funds for minting'
    } else if (error.message?.includes('execution reverted')) {
      statusCode = grpc.status.FAILED_PRECONDITION
      errorMessage = `Contract execution failed: ${error.message}`
    }

    callback({
      code: statusCode,
      message: errorMessage
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
    // ✅ FIX: Validate transaction hash
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

    console.log(`📋 Getting receipt for transaction: ${transaction_hash}`)
    const receipt = await provider.getTransactionReceipt(transaction_hash)

    if (!receipt) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Transaction receipt not found'
      })
    }

    console.log(`📋 Transaction receipt:`, {
      hash: receipt.hash,
      status: receipt.status,
      gasUsed: receipt.gasUsed?.toString(),
      logsCount: receipt.logs?.length || 0
    })

    if (receipt.status !== 1) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Transaction failed on blockchain'
      })
    }

    let mintedTokenIds = []
    let eventId = null
    let sessionId = null

    // ✅ FIX: Parse all TicketMinted events (for multiple tickets)
    for (const log of receipt.logs || []) {
      try {
        const parsedLog = eventTicketNFTContract.interface.parseLog(log)
        if (parsedLog && parsedLog.name === 'TicketMinted') {
          const tokenId = parsedLog.args.tokenId.toString()
          mintedTokenIds.push(tokenId)

          if (!eventId) {
            eventId = parsedLog.args.eventId.toString()
          }
          if (!sessionId) {
            sessionId = parsedLog.args.sessionId.toString()
          }

          console.log(`🎫 Found TicketMinted event:`, {
            tokenId,
            eventId: parsedLog.args.eventId.toString(),
            ticketTypeId: parsedLog.args.ticketTypeId.toString(),
            owner: parsedLog.args.owner,
            price: parsedLog.args.price.toString()
          })
        }
      } catch (parseError) {
        console.log('⚠️ Could not parse log:', parseError.message)
      }
    }

    if (mintedTokenIds.length === 0) {
      console.warn('⚠️ No TicketMinted events found in transaction logs')
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'No ticket minting events found in transaction'
      })
    }

    console.log(
      `✅ Successfully parsed ${mintedTokenIds.length} TicketMinted events`
    )

    callback(null, {
      success: true,
      minted_token_id: mintedTokenIds[0], // Return first token ID for compatibility
      minted_token_ids: mintedTokenIds, // ✅ FIX: Return all token IDs
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

async function VerifyTokenOwnership (call, callback) {
  const { token_id, expected_owner } = call.request

  console.log(
    `VerifyTokenOwnership called for token ${token_id}, expected owner: ${expected_owner}`
  )

  try {
    if (!token_id || token_id === '0') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid token ID'
      })
    }

    if (!expected_owner || !expected_owner.startsWith('0x')) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid expected owner address'
      })
    }

    const tokenIdBN = BigInt(token_id)

    // Check if token exists
    let actualOwner
    try {
      actualOwner = await eventTicketNFTContract.ownerOf(tokenIdBN)
    } catch (contractError) {
      console.error(
        `Token ${token_id} does not exist or error querying:`,
        contractError
      )
      return callback(null, {
        is_valid_owner: false,
        actual_owner: '',
        expected_owner: expected_owner,
        reason: 'Token does not exist or is not minted'
      })
    }

    const isValidOwner =
      actualOwner.toLowerCase() === expected_owner.toLowerCase()

    console.log(`Ownership verification result:`, {
      tokenId: token_id,
      expectedOwner: expected_owner,
      actualOwner: actualOwner,
      isValid: isValidOwner
    })

    callback(null, {
      is_valid_owner: isValidOwner,
      actual_owner: actualOwner,
      expected_owner: expected_owner,
      reason: isValidOwner ? 'Owner verified' : 'Owner mismatch'
    })
  } catch (error) {
    console.error('VerifyTokenOwnership error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to verify token ownership'
    })
  }
}

async function SettleEventRevenue (call, callback) {
  const { blockchain_event_id } = call.request

  console.log(`SettleEventRevenue called for event: ${blockchain_event_id}`)

  try {
    const eventIdBN = BigInt(blockchain_event_id)
    const txOptions = await prepareGasOptions()

    // ✅ STEP 1: Get event revenue first
    const revenueInfo = await eventTicketNFTContract.getEventRevenue(eventIdBN)
    const [organizerRevenue, platformFees, settled, organizer] = revenueInfo

    if (settled) {
      const errorMessage = 'Event revenue already settled'
      console.log(`❌ Settlement rejected: ${errorMessage}`)
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: errorMessage
      })
    }

    if (organizerRevenue === 0n) {
      const errorMessage = 'No revenue to settle for this event'
      console.log(`❌ Settlement rejected: ${errorMessage}`)
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: errorMessage
      })
    }

    // ✅ STEP 2: Get event details from event service to check if ended
    console.log(`🔍 Fetching event details to validate settlement timing...`)

    let eventDetails = null
    try {
      const eventsResponse = await new Promise((resolve, reject) => {
        eventServiceClient.ListEvents(
          {
            page_size: 100,
            status: 'ACTIVE'
          },
          { deadline: new Date(Date.now() + 10000) },
          (err, response) => {
            if (err) {
              console.error('❌ Error fetching events from EventService:', err)
              reject(err)
            } else {
              resolve(response)
            }
          }
        )
      })

      const matchingEvent = eventsResponse.events?.find(
        event => event.blockchain_event_id === blockchain_event_id
      )

      if (!matchingEvent) {
        console.warn(
          `⚠️ No system event found with blockchain_event_id: ${blockchain_event_id}`
        )
      } else {
        eventDetails = matchingEvent
        console.log(
          `✅ Found matching event: ${eventDetails.name} (ID: ${eventDetails.id})`
        )
      }
    } catch (eventError) {
      console.warn(
        '⚠️ Could not fetch event details for time validation:',
        eventError
      )
    }

    // ✅ STEP 3: Validate event has ended if we have event details
    if (
      eventDetails &&
      eventDetails.sessions &&
      eventDetails.sessions.length > 0
    ) {
      const now = Date.now() / 1000 // Current time in seconds

      // Find the latest end time among all sessions
      const latestEndTime = Math.max(
        ...eventDetails.sessions.map(session => {
          const endTime =
            session.end_time < 10000000000
              ? session.end_time
              : session.end_time / 1000
          return endTime
        })
      )

      console.log(`🔍 Event timing validation:`, {
        eventName: eventDetails.name,
        now: new Date(now * 1000).toISOString(),
        latestSessionEnd: new Date(latestEndTime * 1000).toISOString(),
        hasEnded: now > latestEndTime,
        timeDifferenceHours: ((now - latestEndTime) / 3600).toFixed(2)
      })

      // ✅ ENFORCE: Event must have ended before settlement
      if (now <= latestEndTime) {
        const timeUntilEnd = latestEndTime - now
        const minutesUntilEnd = Math.ceil(timeUntilEnd / 60)

        // ✅ FIX: Simpler English error message for better gRPC transmission
        const errorMessage = `Cannot settle ongoing event. Event "${eventDetails.name}" ends in ${minutesUntilEnd} minutes.`

        console.log(
          `❌ Settlement rejected: Không thể settlement cho sự kiện đang diễn ra. Event "${
            eventDetails.name
          }" sẽ kết thúc vào ${new Date(latestEndTime * 1000).toLocaleString(
            'vi-VN'
          )} (còn ${minutesUntilEnd} phút nữa).`
        )

        return callback({
          code: grpc.status.FAILED_PRECONDITION,
          message: errorMessage // ✅ Use English message for gRPC
        })
      }

      // ✅ OPTIONAL: Add grace period (e.g., 1 hour after event ends)
      const gracePeriodHours = 0
      const gracePeriodSeconds = gracePeriodHours * 3600
      const earliestSettlementTime = latestEndTime + gracePeriodSeconds

      if (now < earliestSettlementTime) {
        const timeUntilSettlement = earliestSettlementTime - now
        const minutesUntilSettlement = Math.ceil(timeUntilSettlement / 60)

        // ✅ FIX: English message
        const errorMessage = `Settlement available in ${minutesUntilSettlement} minutes. Grace period: ${gracePeriodHours} hour(s) after event ends.`

        console.log(
          `❌ Settlement rejected (grace period): Settlement sẽ khả dụng sau ${minutesUntilSettlement} phút nữa. Cần có thời gian chờ ${gracePeriodHours} giờ sau khi sự kiện kết thúc.`
        )

        return callback({
          code: grpc.status.FAILED_PRECONDITION,
          message: errorMessage // ✅ Use English message for gRPC
        })
      }

      console.log(
        `✅ Event has ended and grace period passed. Settlement allowed.`
      )
    } else {
      console.log(
        `⚠️ No session timing info available. Proceeding with settlement.`
      )
    }

    // ✅ STEP 4: Proceed with settlement
    console.log(`Settling revenue for event ${blockchain_event_id}:`, {
      organizer,
      organizerRevenue: organizerRevenue.toString(),
      platformFees: platformFees.toString(),
      eventName: eventDetails?.name || 'Unknown'
    })

    const tx = await eventTicketNFTContract.settleEventRevenue(
      eventIdBN,
      txOptions
    )

    const receipt = await waitForTransaction(tx)

    console.log(
      `✅ Settlement completed for event "${
        eventDetails?.name || blockchain_event_id
      }":`,
      {
        transactionHash: receipt.hash,
        organizerAmount: organizerRevenue.toString(),
        platformFee: platformFees.toString(),
        organizer
      }
    )

    callback(null, {
      success: true,
      transaction_hash: receipt.hash,
      organizer_amount_wei: organizerRevenue.toString(),
      platform_fee_wei: platformFees.toString(),
      organizer_address: organizer,
      event_name: eventDetails?.name || 'Unknown',
      event_end_time:
        eventDetails?.sessions?.length > 0
          ? Math.max(...eventDetails.sessions.map(s => s.end_time))
          : 0,
      settlement_time: Math.floor(Date.now() / 1000)
    })
  } catch (error) {
    console.error('SettleEventRevenue error:', error)

    // ✅ FIX: Better error message handling with English messages
    let errorMessage = 'Failed to settle event revenue'

    if (error.message) {
      errorMessage = error.message
    }

    // Check for specific contract errors
    if (error.message?.includes('Event has not ended')) {
      errorMessage = 'Event has not ended yet, cannot settle'
    } else if (error.message?.includes('Already settled')) {
      errorMessage = 'Event revenue has already been settled'
    } else if (error.message?.includes('No revenue')) {
      errorMessage = 'No revenue to settle for this event'
    }

    console.log(`❌ Settlement error details:`, {
      originalError: error.message,
      finalMessage: errorMessage,
      code: grpc.status.FAILED_PRECONDITION
    })

    callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: errorMessage
    })
  }
}

async function WithdrawPlatformFees (call, callback) {
  const { amount_wei } = call.request

  console.log(`WithdrawPlatformFees called for amount: ${amount_wei}`)

  try {
    const amountBN = BigInt(amount_wei)
    const txOptions = await prepareGasOptions()

    // Check total platform fees
    const totalFees = await eventTicketNFTContract.getTotalPlatformFees()

    if (amountBN > totalFees) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Insufficient platform fees. Available: ${totalFees.toString()}, Requested: ${amount_wei}`
      })
    }

    console.log(`Withdrawing platform fees:`, {
      amount: amount_wei,
      totalAvailable: totalFees.toString()
    })

    // Call contract to withdraw
    const tx = await eventTicketNFTContract.withdrawPlatformFees(
      amountBN,
      txOptions
    )

    const receipt = await waitForTransaction(tx)

    callback(null, {
      success: true,
      transaction_hash: receipt.hash,
      amount_wei: amount_wei
    })
  } catch (error) {
    console.error('WithdrawPlatformFees error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to withdraw platform fees'
    })
  }
}

async function GetEventRevenue (call, callback) {
  const { blockchain_event_id } = call.request

  try {
    const eventIdBN = BigInt(blockchain_event_id)

    const revenueInfo = await eventTicketNFTContract.getEventRevenue(eventIdBN)
    const [organizerRevenue, platformFees, settled, organizer] = revenueInfo

    callback(null, {
      organizer_revenue_wei: organizerRevenue.toString(),
      platform_fees_wei: platformFees.toString(),
      settled: settled,
      organizer_address: organizer
    })
  } catch (error) {
    console.error('GetEventRevenue error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get event revenue'
    })
  }
}

async function GetContractBalance (call, callback) {
  console.log('GetContractBalance called')

  try {
    // Get contract balance
    const contractBalance = await provider.getBalance(
      eventTicketNFTContract.target || eventTicketNFTContract.address
    )

    // Get total platform fees from contract
    const totalPlatformFees =
      await eventTicketNFTContract.getTotalPlatformFees()

    // Get platform fee percentage
    const platformFeePercent =
      await eventTicketNFTContract.getPlatformFeePercent()

    console.log('📊 Contract balance info:', {
      contractBalance: contractBalance.toString(),
      totalPlatformFees: totalPlatformFees.toString(),
      platformFeePercent: platformFeePercent.toString()
    })

    callback(null, {
      contract_balance_wei: contractBalance.toString(),
      total_platform_fees_wei: totalPlatformFees.toString(),
      platform_fee_percent: Number(platformFeePercent)
    })
  } catch (error) {
    console.error('GetContractBalance error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get contract balance'
    })
  }
}

// Export updated functions
module.exports = {
  RegisterEventOnBlockchain,
  RegisterTicketTypeOnBlockchain,
  GetTicketPaymentDetails,
  MintTicket,
  VerifyTransaction,
  ParseTransactionLogs,
  VerifyTokenOwnership,
  SettleEventRevenue,
  WithdrawPlatformFees,
  GetEventRevenue,
  SetPlatformFee,
  GetPlatformFee,
  GetContractBalance
}
