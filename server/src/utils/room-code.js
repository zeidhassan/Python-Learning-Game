function generateRoomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(Math.random() * chars.length);
    code += chars[index];
  }

  return code;
}

module.exports = {
  generateRoomCode,
};

