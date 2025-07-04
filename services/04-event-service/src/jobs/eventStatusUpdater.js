const cron = require('node-cron')
const { Event, EVENT_STATUS_ENUM } = require('../models/Event')
const { ticketServiceClient } = require('../clients/ticketServiceClient')

class EventStatusUpdater {
  constructor () {
    this.isRunning = false
  }

  start () {
    // ✅ Chạy mỗi 1 phút để kiểm tra events cần update status
    cron.schedule('*/1 * * * *', async () => {
      if (this.isRunning) {
        console.log('⏸️ EventStatusUpdater already running, skipping...')
        return
      }

      try {
        this.isRunning = true
        await this.updateEndedEvents()
        // Expire tickets sau khi update events
        await this.expireTicketsForEndedEvents()
      } catch (error) {
        console.error('❌ EventStatusUpdater error:', error)
      } finally {
        this.isRunning = false
      }
    })

    console.log('✅ EventStatusUpdater started - checking every 5 minutes')
    console.log(
      '🎫 EventStatusUpdater will also expire tickets for ended events'
    )
  }

  async updateEndedEvents () {
    const now = Date.now() / 1000 // Current time in seconds

    console.log('🔍 Checking for events that should be marked as ENDED...')

    try {
      // ✅ Find ACTIVE events that have ended
      const activeEvents = await Event.find({
        status: EVENT_STATUS_ENUM[2], // ACTIVE
        sessions: { $exists: true, $ne: [] }
      })

      let updatedCount = 0

      for (const event of activeEvents) {
        if (!event.sessions || event.sessions.length === 0) {
          continue
        }

        // Find the latest end time among all sessions
        const latestEndTime = Math.max(
          ...event.sessions.map(session => {
            // Handle both seconds and milliseconds timestamps
            return session.endTime < 10000000000
              ? session.endTime
              : session.endTime / 1000
          })
        )

        // ✅ Check if event has ended (with 1 hour grace period)
        const gracePeriod = 0 * 60 // 0 hour in seconds
        const eventEndedTime = latestEndTime + gracePeriod

        if (now > eventEndedTime) {
          console.log(`🔄 Updating event "${event.name}" to ENDED status`)
          console.log(
            `   Latest session ended: ${new Date(
              latestEndTime * 1000
            ).toISOString()}`
          )
          console.log(
            `   Grace period ended: ${new Date(
              eventEndedTime * 1000
            ).toISOString()}`
          )

          // ✅ Update event status
          await Event.findByIdAndUpdate(event._id, {
            status: EVENT_STATUS_ENUM[4], // ENDED
            isActive: false
          })

          updatedCount++

          // ✅ Log the status change
          console.log(
            `✅ Event "${event.name}" (ID: ${event.id}) status changed to ENDED`
          )
        }
      }

      if (updatedCount > 0) {
        console.log(
          `✅ EventStatusUpdater completed: ${updatedCount} events updated to ENDED status`
        )
      } else {
        console.log('ℹ️ No events need status update at this time')
      }
    } catch (error) {
      console.error('❌ Error in updateEndedEvents:', error)
      throw error
    }
  }

  // ✅ THÊM: Expire tickets for ended events
  async expireTicketsForEndedEvents () {
    console.log('🎫 Checking for tickets that should be expired...')

    try {
      // Find all ENDED events
      const endedEvents = await Event.find({
        status: EVENT_STATUS_ENUM[4] // ENDED
      })

      let totalExpiredTickets = 0

      for (const event of endedEvents) {
        try {
          // ✅ Call ticket service to expire tickets for this event
          const expireResult = await this.expireTicketsForEvent(event.id)

          if (expireResult.success) {
            totalExpiredTickets += expireResult.expired_count

            if (expireResult.expired_count > 0) {
              console.log(
                `🎫 Expired ${expireResult.expired_count} tickets for event "${event.name}"`
              )
            }
          }
        } catch (expireError) {
          console.error(
            `❌ Error expiring tickets for event "${event.name}":`,
            expireError.message
          )
          // Continue with other events
        }
      }

      if (totalExpiredTickets > 0) {
        console.log(`✅ Total expired tickets: ${totalExpiredTickets}`)
      } else {
        console.log('ℹ️ No tickets need to be expired at this time')
      }
    } catch (error) {
      console.error('❌ Error in expireTicketsForEndedEvents:', error)
      throw error
    }
  }

  // ✅ THÊM: Helper method to expire tickets for a specific event
  async expireTicketsForEvent (eventId) {
    return new Promise((resolve, reject) => {
      ticketServiceClient.ExpireTicketsForEvent(
        { event_id: eventId },
        { deadline: new Date(Date.now() + 30000) }, // 30 second timeout
        (err, response) => {
          if (err) {
            reject(
              new Error(
                `Failed to expire tickets for event ${eventId}: ${err.message}`
              )
            )
          } else {
            resolve(response)
          }
        }
      )
    })
  }

  // ✅ Manual trigger for testing
  async triggerUpdate () {
    console.log('🔧 Manual trigger: Updating ended events...')
    await this.updateEndedEvents()
    console.log('🔧 Manual trigger: Expiring tickets for ended events...')
    await this.expireTicketsForEndedEvents()
  }

  // ✅ THÊM: Manual trigger chỉ để expire tickets
  async triggerExpireTickets () {
    console.log('🔧 Manual trigger: Expiring tickets for ended events...')
    await this.expireTicketsForEndedEvents()
  }
}

module.exports = new EventStatusUpdater()
