const bcrypt = require('bcryptjs')

const hashPassword = async password => {
  const salt = await bcrypt.genSalt(10)
  return bcrypt.hash(password, salt)
}

const comparePassword = async (candidatePassword, hashedPassword) => {
  return bcrypt.compare(candidatePassword, hashedPassword)
}

module.exports = {
  hashPassword,
  comparePassword
}
