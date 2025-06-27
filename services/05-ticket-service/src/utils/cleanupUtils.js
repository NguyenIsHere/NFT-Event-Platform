// NFT-Event-Platform/services/05-ticket-service/src/utils/cleanupUtils.js
async function cleanupExpiredReservations () {
  try {
    console.log('🧹 Starting cleanup of expired reservations...')

    const now = new Date()

    // Find expired pending tickets
    const expiredTickets = await Ticket.find({
      status: { $in: ['PENDING_PAYMENT'] }, // ✅ FIX: Only cleanup truly pending tickets
      expiryTime: { $lt: now }
    })

    console.log(`Found ${expiredTickets.length} expired tickets to cleanup`)

    // Group by ticket type for availability updates
    const ticketTypeUpdates = {}

    for (const ticket of expiredTickets) {
      if (!ticketTypeUpdates[ticket.ticketTypeId]) {
        ticketTypeUpdates[ticket.ticketTypeId] = 0
      }
      ticketTypeUpdates[ticket.ticketTypeId]++
    }

    // Delete expired tickets
    if (expiredTickets.length > 0) {
      await Ticket.deleteMany({
        status: 'PENDING_PAYMENT',
        expiryTime: { $lt: now }
      })

      console.log(`✅ Deleted ${expiredTickets.length} expired tickets`)
    }

    // ✅ FIX: Recalculate availability from actual database state
    for (const [ticketTypeId, freedQuantity] of Object.entries(
      ticketTypeUpdates
    )) {
      const ticketType = await TicketType.findById(ticketTypeId)
      if (ticketType) {
        // Recalculate real availability
        const soldTicketsCount = await Ticket.countDocuments({
          ticketTypeId: ticketTypeId,
          status: { $in: ['MINTED'] }
        })

        const reservedTicketsCount = await Ticket.countDocuments({
          ticketTypeId: ticketTypeId,
          status: { $in: ['PENDING_PAYMENT', 'PAID', 'MINTING'] },
          expiryTime: { $gt: new Date() }
        })

        const correctAvailability = Math.max(
          0,
          ticketType.totalQuantity - soldTicketsCount - reservedTicketsCount
        )

        if (ticketType.availableQuantity !== correctAvailability) {
          ticketType.availableQuantity = correctAvailability
          await ticketType.save()
          console.log(
            `✅ Corrected availability for ${ticketTypeId}: ${ticketType.availableQuantity} -> ${correctAvailability}`
          )
        }
      }
    }

    // Mark expired purchases
    await Purchase.updateMany(
      {
        status: 'INITIATED',
        expiresAt: { $lt: now }
      },
      {
        $set: { status: 'EXPIRED' }
      }
    )

    console.log('🧹 Cleanup completed')
  } catch (error) {
    console.error('❌ Cleanup error:', error)
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredReservations, 5 * 60 * 1000)

module.exports = { cleanupExpiredReservations }
