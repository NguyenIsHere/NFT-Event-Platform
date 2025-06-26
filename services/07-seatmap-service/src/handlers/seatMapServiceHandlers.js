// 07-seatmap-service/src/handlers/seatMapServiceHandlers.js
const SeatMap = require('../models/SeatMap')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
// const eventServiceClient = require('../clients/eventServiceClient'); // Bỏ comment nếu dùng

// Helper function để chuyển đổi Mongoose document sang gRPC message SeatMap
function seatMapDocumentToGrpcSeatMap (doc) {
  if (!doc) return null
  const jsonDoc = doc.toJSON ? doc.toJSON() : doc

  return {
    id: jsonDoc.id,
    event_id: jsonDoc.eventId,
    stage_config: {
      dimensions: jsonDoc.stageConfig.dimensions,
      position: jsonDoc.stageConfig.position,
      shape: jsonDoc.stageConfig.shape || ''
    },
    sections: jsonDoc.sections
      ? jsonDoc.sections.map(s => ({
          id: s.id,
          name: s.name,
          type: s.type,
          position: s.position,
          dimensions: s.dimensions,
          rows: s.rows,
          seats_per_row: s.seats_per_row,
          color: s.color || '',
          price_category_id: s.price_category_id || '',
          price_description: s.price_description || '',
          rows_config_input: s.rows_config_input || '' // ✅ ADD
        }))
      : []
  }
}

async function CreateSeatMap (call, callback) {
  const { event_id, stage_config, sections } = call.request
  console.log(`SeatMapService: CreateSeatMap called for event_id: ${event_id}`)

  try {
    // Validate event_id format if needed
    if (!event_id || typeof event_id !== 'string') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event_id format.'
      })
    }

    // ✅ FIX: Kiểm tra xem event_id này đã có seatmap chưa
    const existingSeatMap = await SeatMap.findOne({ eventId: event_id })
    if (existingSeatMap) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `Seat map for event_id ${event_id} already exists. Use UpdateSeatMap (PUT /v1/seatmaps/${existingSeatMap.id}) to modify.`
      })
    }

    // ✅ FIX: Validate input data
    if (!stage_config || !stage_config.dimensions || !stage_config.position) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'stage_config with dimensions and position is required.'
      })
    }

    if (!sections || sections.length === 0) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'At least one section is required.'
      })
    }

    // ✅ FIX: Validate sections data
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]
      if (
        !section.name ||
        !section.type ||
        !section.position ||
        !section.dimensions
      ) {
        return callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: `Section ${
            i + 1
          }: name, type, position, and dimensions are required.`
        })
      }
    }

    // ✅ FIX: Transform sections với rows_config_input
    const mongooseSections = sections.map(s_in => ({
      name: s_in.name,
      type: s_in.type,
      position: s_in.position,
      dimensions: s_in.dimensions,
      rows: s_in.rows || 0,
      seats_per_row: s_in.seats_per_row || 0,
      color: s_in.color || '#87CEEB',
      price_category_id: s_in.price_category_id || '',
      price_description: s_in.price_description || '',
      rows_config_input: s_in.rows_config_input || '' // ✅ ADD: Field mới
    }))

    const newSeatMap = new SeatMap({
      eventId: event_id,
      stageConfig: stage_config,
      sections: mongooseSections
    })

    const savedSeatMap = await newSeatMap.save()
    console.log(
      `SeatMapService: SeatMap created for event ${event_id} with ID: ${savedSeatMap.id}`
    )
    callback(null, { seat_map: seatMapDocumentToGrpcSeatMap(savedSeatMap) })
  } catch (error) {
    console.error('SeatMapService: CreateSeatMap error:', error)
    if (error.name === 'ValidationError') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: Object.values(error.errors)
          .map(e => e.message)
          .join(', ')
      })
    }
    if (error.code === 11000) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `Seat map for event_id ${event_id} already exists.`
      })
    }
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to create seat map.'
    })
  }
}

async function GetSeatMap (call, callback) {
  const { seat_map_id } = call.request
  console.log(
    `SeatMapService: GetSeatMap called for seat_map_id: ${seat_map_id}`
  )
  try {
    if (!mongoose.Types.ObjectId.isValid(seat_map_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid seat_map_id format.'
      })
    }
    const seatMap = await SeatMap.findById(seat_map_id)
    if (!seatMap) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'SeatMap not found.'
      })
    }
    callback(null, { seat_map: seatMapDocumentToGrpcSeatMap(seatMap) })
  } catch (error) {
    console.error('SeatMapService: GetSeatMap RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get seat map.'
    })
  }
}

async function GetSeatMapByEvent (call, callback) {
  const { event_id } = call.request
  console.log(
    `SeatMapService: GetSeatMapByEvent called for event_id: ${event_id}`
  )
  try {
    // if (!mongoose.Types.ObjectId.isValid(event_id)) { // Nếu event_id là ObjectId
    //     return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'Invalid event_id format.' });
    // }
    const seatMap = await SeatMap.findOne({ eventId: event_id }) // eventId là unique
    if (!seatMap) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `SeatMap not found for event_id ${event_id}.`
      })
    }
    callback(null, { seat_map: seatMapDocumentToGrpcSeatMap(seatMap) })
  } catch (error) {
    console.error('SeatMapService: GetSeatMapByEvent RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get seat map by event.'
    })
  }
}

async function UpdateSeatMap (call, callback) {
  const { seat_map_id, event_id_to_verify, stage_config, sections } =
    call.request
  console.log(
    `SeatMapService: UpdateSeatMap called for seat_map_id: ${seat_map_id}`
  )
  try {
    if (!mongoose.Types.ObjectId.isValid(seat_map_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid seat_map_id format.'
      })
    }

    const updateData = {
      stageConfig: stage_config, // Đổi tên cho khớp Mongoose
      sections: sections.map(s_in => ({
        // Client gửi ID của section nếu muốn giữ lại section cũ, nếu không thì là section mới
        _id:
          s_in.id && mongoose.Types.ObjectId.isValid(s_in.id)
            ? s_in.id
            : new mongoose.Types.ObjectId(), // Giữ id cũ hoặc tạo id mới
        name: s_in.name,
        type: s_in.type,
        position: s_in.position,
        dimensions: s_in.dimensions,
        rows: s_in.rows,
        seats_per_row: s_in.seats_per_row,
        color: s_in.color,
        price_category_id: s_in.price_category_id,
        price_description: s_in.price_description
      }))
    }

    // (Tùy chọn) Xác minh event_id_to_verify nếu được cung cấp
    const query = { _id: seat_map_id }
    if (event_id_to_verify) {
      query.eventId = event_id_to_verify
    }

    const updatedSeatMap = await SeatMap.findOneAndUpdate(
      query,
      { $set: updateData },
      { new: true, runValidators: true }
    )

    if (!updatedSeatMap) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `SeatMap with id ${seat_map_id}${
          event_id_to_verify ? ' for event ' + event_id_to_verify : ''
        } not found to update.`
      })
    }
    console.log(`SeatMapService: SeatMap ${updatedSeatMap.id} updated.`)
    callback(null, { seat_map: seatMapDocumentToGrpcSeatMap(updatedSeatMap) })
  } catch (error) {
    console.error('SeatMapService: UpdateSeatMap RPC error:', error)
    if (error.name === 'ValidationError') {
      /* ... */
    }
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to update seat map.'
    })
  }
}

async function DeleteSeatMap (call, callback) {
  const { seat_map_id } = call.request
  console.log(
    `SeatMapService: DeleteSeatMap called for seat_map_id: ${seat_map_id}`
  )
  try {
    if (!mongoose.Types.ObjectId.isValid(seat_map_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid seat_map_id format.'
      })
    }
    const result = await SeatMap.findByIdAndDelete(seat_map_id)
    if (!result) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'SeatMap not found to delete.'
      })
    }
    console.log(`SeatMapService: SeatMap ${seat_map_id} deleted.`)
    callback(null, {}) // google.protobuf.Empty tương ứng với {} hoặc null
  } catch (error) {
    console.error('SeatMapService: DeleteSeatMap RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to delete seat map.'
    })
  }
}

async function ListSeatMaps (call, callback) {
  const { event_id /*, page_size, page_token */ } = call.request
  console.log(`SeatMapService: ListSeatMaps called with event_id: ${event_id}`)
  try {
    const query = {}
    if (event_id) {
      // if (!mongoose.Types.ObjectId.isValid(event_id)) { ... }
      query.eventId = event_id
    }
    // TODO: Implement pagination
    const seatMaps = await SeatMap.find(query).sort({ createdAt: -1 })
    callback(null, {
      seat_maps: seatMaps.map(doc => seatMapDocumentToGrpcSeatMap(doc))
    })
  } catch (error) {
    console.error('SeatMapService: ListSeatMaps RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list seat maps.'
    })
  }
}

module.exports = {
  CreateSeatMap,
  GetSeatMap,
  GetSeatMapByEvent,
  UpdateSeatMap,
  DeleteSeatMap,
  ListSeatMaps
}
