// 07-seatmap-service/src/clients/eventServiceClient.js (TÙY CHỌN - nếu cần xác minh event_id)
// (Tạo file này tương tự như eventServiceClient.js trong ticket-service nếu bạn cần)
// const grpc = require('@grpc/grpc-js');
// const protoLoader = require('@grpc/proto-loader');
// const path = require('path');

// const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos');
// const EVENT_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'event.proto');

// const EVENT_SERVICE_ADDRESS = process.env.EVENT_SERVICE_ADDRESS || 'localhost:50054';

// console.log(`SeatMapService: Event client attempting to connect to ${EVENT_SERVICE_ADDRESS}`);
// const eventPackageDefinition = protoLoader.loadSync(EVENT_PROTO_PATH, { /* ... */ });
// const eventProto = grpc.loadPackageDefinition(eventPackageDefinition).event;
// const eventServiceClient = new eventProto.EventService(EVENT_SERVICE_ADDRESS, grpc.credentials.createInsecure());
// module.exports = eventServiceClient;
