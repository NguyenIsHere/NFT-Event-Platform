// src/utils/contractUtils.js
const { ethers } = require('ethers')
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '..', '.env')
})

const rpcUrl = process.env.ETHEREUM_RPC_URL
const signerPrivateKey = process.env.SIGNER_PRIVATE_KEY
const contractAddress = process.env.EVENT_TICKET_NFT_CONTRACT_ADDRESS

if (!rpcUrl || !signerPrivateKey || !contractAddress) {
  console.error(
    'FATAL ERROR: Ethereum RPC URL, Signer Private Key, or Contract Address is not defined in .env for BlockchainService.'
  )
  process.exit(1)
}

// --- Khởi tạo Provider và Signer ---
const provider = new ethers.JsonRpcProvider(rpcUrl)
const signer = new ethers.Wallet(signerPrivateKey, provider)
console.log(`BlockchainService: Signer address: ${signer.address}`)

// --- ABI của EventTicketNFT Smart Contract ---
// Bạn cần lấy ABI từ file JSON sau khi compile contract (ví dụ: EventTicketNFT.json)
// và dán vào đây hoặc đọc từ file.
// Ví dụ rút gọn (bạn cần ABI đầy đủ):
const contractABI = [
  'event EventCreated(uint256 indexed eventId, uint256 price, uint256 totalSupply)',
  'event TicketMinted(uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed sessionId, address owner, uint256 price)',
  'function eventInfo(uint256 eventId) view returns (uint256 price, uint256 remaining)',
  'function tickets(uint256 tokenId) view returns (uint256 eventId, uint256 sessionId, uint256 price)',
  'function nextTokenId() view returns (uint256)',
  'function createEvent(uint256 eventId, uint256 priceWei, uint256 totalSupply) external',
  'function batchMint(address to, string[] calldata uris, uint256[] calldata eventIds, uint256[] calldata sessionIds, uint256[] calldata prices) external',
  'function ownerOf(uint256 tokenId) view returns (address)'
  // Thêm các function và event khác từ ABI đầy đủ của bạn vào đây
]

const eventTicketNFTContract = new ethers.Contract(
  contractAddress,
  contractABI,
  signer
)

console.log(
  `BlockchainService: Connected to EventTicketNFT contract at ${contractAddress}`
)

module.exports = {
  provider,
  signer,
  eventTicketNFTContract,
  ethers // Export ethers để dùng BigNumber, utils nếu cần ở handlers
}
