const blockchainServiceClient = require('../clients/blockchainServiceClient')
const {
  TransactionLog,
  TRANSACTION_TYPES
} = require('../models/TransactionLog')

class TransactionLogger {
  /**
   * ✅ ENHANCED: Log ticket purchase với dynamic fee từ contract
   */
  static async logTicketPurchase ({
    transactionHash,
    blockNumber,
    eventId,
    organizerId,
    userId,
    ticketTypeId,
    fromAddress,
    toAddress,
    amountWei,
    platformFeeWei,
    organizerAmountWei,
    feePercentAtTime,
    purchaseId, // ✅ CHANGE: ticket_order_id thay vì purchase ID
    ticketIds,
    quantity,
    paymentMethod = 'WALLET', // ✅ NEW: Payment method
    gasUsed,
    gasPriceWei,
    failureReason,
    purchaseStartTime
  }) {
    try {
      // ✅ GET current fee từ contract nếu không có
      if (!feePercentAtTime || feePercentAtTime === 0) {
        try {
          // Call blockchain service để get current fee
          const feeResponse = await new Promise((resolve, reject) => {
            const blockchainServiceClient = require('../clients/blockchainServiceClient')
            blockchainServiceClient.GetPlatformFee({}, (err, res) => {
              if (err) reject(err)
              else resolve(res)
            })
          })
          feePercentAtTime = feeResponse.fee_percent || 10
        } catch (err) {
          console.warn(
            'Could not get platform fee from contract, using default:',
            err
          )
          feePercentAtTime = 10 // Default fallback
        }
      }

      // ✅ CALCULATE fees if not provided
      if (!platformFeeWei || !organizerAmountWei) {
        const totalAmount = parseFloat(amountWei || '0')
        platformFeeWei = Math.floor(
          (totalAmount * feePercentAtTime) / 100
        ).toString()
        organizerAmountWei = (
          totalAmount - parseFloat(platformFeeWei)
        ).toString()
      }

      const log = new TransactionLog({
        transactionHash: transactionHash || `pending-${Date.now()}`,
        blockNumber,
        type: TRANSACTION_TYPES[0], // TICKET_PURCHASE
        status: transactionHash ? 'CONFIRMED' : 'PENDING',
        eventId,
        organizerId,
        userId,
        ticketTypeId,
        fromAddress,
        toAddress,
        amountWei,
        platformFeeWei,
        organizerAmountWei,
        feePercentAtTime,
        relatedPurchaseId: purchaseId, // ✅ CHANGE: ticket_order_id
        relatedTicketIds: ticketIds,
        gasUsed: gasUsed?.toString(),
        gasPriceWei: gasPriceWei?.toString(),
        failureReason,
        metadata: {
          quantity,
          ticketCount: ticketIds?.length || 0,
          orderType: 'TICKET_PURCHASE',
          paymentMethod, // ✅ NEW: Store payment method
          completion_time_ms: transactionHash
            ? Date.now() - (purchaseStartTime || Date.now())
            : null
        },
        description: `${
          transactionHash ? 'Purchased' : 'Initiated purchase of'
        } ${quantity} tickets for event ${eventId}`,
        processedAt: transactionHash ? new Date() : null
      })

      const saved = await log.save()
      console.log(
        `✅ Logged ticket purchase transaction: ${transactionHash || 'PENDING'}`
      )
      return saved
    } catch (error) {
      console.error(`❌ Failed to log ticket purchase:`, error)
      throw error
    }
  }

  /**
   * Log revenue settlement transaction
   */
  static async logRevenueSettlement ({
    transactionHash,
    blockNumber,
    gasUsed,
    gasPriceWei,
    eventId,
    organizerId,
    organizerAmountWei,
    platformFeeWei,
    organizerAddress,
    eventName
  }) {
    try {
      const log = new TransactionLog({
        transactionHash,
        blockNumber,
        gasUsed,
        gasPriceWei,
        type: TRANSACTION_TYPES[2], // REVENUE_SETTLEMENT
        status: 'CONFIRMED',
        eventId,
        organizerId,
        fromAddress: process.env.CONTRACT_ADDRESS?.toLowerCase(),
        toAddress: organizerAddress?.toLowerCase(),
        organizerAmountWei,
        platformFeeWei,
        metadata: {
          eventName,
          settlementType: 'EVENT_REVENUE'
        },
        description: `Revenue settlement for event "${eventName}" - ${organizerAmountWei} Wei to organizer`,
        processedAt: new Date()
      })

      const saved = await log.save()
      console.log(`✅ Logged revenue settlement: ${transactionHash}`)
      return saved
    } catch (error) {
      console.error(`❌ Failed to log revenue settlement:`, error)
      throw error
    }
  }

  /**
   * Log platform fee withdrawal
   */
  static async logPlatformWithdraw ({
    transactionHash,
    blockNumber,
    gasUsed,
    gasPriceWei,
    amountWei,
    adminAddress
  }) {
    try {
      const log = new TransactionLog({
        transactionHash,
        blockNumber,
        gasUsed,
        gasPriceWei,
        type: TRANSACTION_TYPES[3], // PLATFORM_WITHDRAW
        status: 'CONFIRMED',
        fromAddress: process.env.CONTRACT_ADDRESS?.toLowerCase(),
        toAddress: adminAddress?.toLowerCase(),
        amountWei,
        metadata: {
          withdrawType: 'PLATFORM_FEES'
        },
        description: `Platform fee withdrawal: ${amountWei} Wei to admin`,
        processedAt: new Date()
      })

      const saved = await log.save()
      console.log(`✅ Logged platform withdrawal: ${transactionHash}`)
      return saved
    } catch (error) {
      console.error(`❌ Failed to log platform withdrawal:`, error)
      throw error
    }
  }

  /**
   * Log platform fee update
   */
  static async logPlatformFeeUpdate ({
    transactionHash,
    blockNumber,
    gasUsed,
    gasPriceWei,
    oldFeePercent,
    newFeePercent,
    adminAddress
  }) {
    try {
      const log = new TransactionLog({
        transactionHash,
        blockNumber,
        gasUsed,
        gasPriceWei,
        type: TRANSACTION_TYPES[4], // PLATFORM_FEE_UPDATE
        status: 'CONFIRMED',
        fromAddress: adminAddress?.toLowerCase(),
        toAddress: process.env.CONTRACT_ADDRESS?.toLowerCase(),
        feePercentAtTime: newFeePercent,
        metadata: {
          oldFeePercent,
          newFeePercent,
          updateType: 'FEE_CHANGE'
        },
        description: `Platform fee updated from ${oldFeePercent}% to ${newFeePercent}%`,
        processedAt: new Date()
      })

      const saved = await log.save()
      console.log(`✅ Logged platform fee update: ${transactionHash}`)
      return saved
    } catch (error) {
      console.error(`❌ Failed to log platform fee update:`, error)
      throw error
    }
  }

  /**
   * Get transaction logs for analytics
   */
  static async getTransactionLogs (filters = {}) {
    const {
      eventId,
      organizerId,
      userId,
      type,
      status,
      fromDate,
      toDate,
      limit = 100,
      offset = 0
    } = filters

    const query = {}

    if (eventId) query.eventId = eventId
    if (organizerId) query.organizerId = organizerId
    if (userId) query.userId = userId
    if (type) query.type = type
    if (status) query.status = status

    if (fromDate || toDate) {
      query.createdAt = {}
      if (fromDate) query.createdAt.$gte = new Date(fromDate)
      if (toDate) query.createdAt.$lte = new Date(toDate)
    }

    const logs = await TransactionLog.find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)

    const total = await TransactionLog.countDocuments(query)

    return { logs, total }
  }
}

module.exports = TransactionLogger
